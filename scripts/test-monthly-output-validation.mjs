import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client as ModernClient, InMemoryTransport as ModernInMemoryTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'

process.env.MCP_ALLOWANCE_ENABLED = 'true'
process.env.BULLRUN_MCP_GATEWAY_SECRET = 'output-validation-test-secret-at-least-32-bytes'
const { instrumentMcpTools } = await import('../dist/usage/invocations.js')
const { createMcpServer, MAX_TOOL_INPUT_ELEMENTS } = await import('../dist/mcpServer.js')
const { createModernMcpServer } = await import('../dist/sdkV2.js')

const originalFetch = globalThis.fetch
let calls
let mode
beforeEach(() => {
  calls = []
  mode = 'normal'
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname
    const body = JSON.parse(options.body)
    calls.push({ path, body })
    if (path.endsWith('/reserve')) return Response.json({ allowed: true, operationId: body.operationId, principalKey: 'ip:test',
      expiresAt: new Date(Date.now() + 300000).toISOString(), window: '30d', maxRequests: 1024 })
    if (path.endsWith('/finish')) {
      if (mode === 'uncertain') throw new Error('Settlement acknowledgement unavailable')
      return Response.json({ settled: true })
    }
    if (path.endsWith('/status') && mode === 'uncertain') throw new Error('Settlement status unavailable')
    if (path === '/api/analytics/mcp-tools') return Response.json({ ok: true })
    throw new Error(`Unexpected fixture request: ${path}`)
  }
})
afterEach(() => { globalThis.fetch = originalFetch })

async function callTool(config, callback, args = {}) {
  const server = new McpServer({ name: 'quota-output-test', version: '1' })
  instrumentMcpTools(server)
  server.registerTool('validation_test', config, callback)
  const client = new Client({ name: 'quota-output-client', version: '1' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverSide)
    await client.connect(clientSide)
    return await client.callTool({ name: 'validation_test', arguments: args })
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
}

function assertSettlement(success) {
  const reserved = calls.filter(call => call.path.endsWith('/reserve'))
  const finished = calls.filter(call => call.path.endsWith('/finish'))
  assert.equal(reserved.length, 1)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].body.operationId, reserved[0].body.operationId)
  assert.equal(finished[0].body.success, success)
}

test('a valid raw output shape is delivered through the SDK and charged exactly once', async () => {
  const result = await callTool({ outputSchema: { value: z.number() } }, async () => ({
    content: [{ type: 'text', text: '{"value":42}' }], structuredContent: { value: 42 },
  }))
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { value: 42 })
  assertSettlement(true)
})

test('an invalid raw output shape produces an SDK tool error and releases its reservation', async () => {
  const result = await callTool({ outputSchema: { value: z.number() } }, async () => ({
    content: [{ type: 'text', text: '{"value":"wrong"}' }], structuredContent: { value: 'wrong' },
  }))
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Output validation error/)
  assertSettlement(false)
})

test('a missing structured payload also releases an output-schema reservation', async () => {
  const result = await callTool({ outputSchema: { value: z.number() } }, async () => ({
    content: [{ type: 'text', text: 'A text-only result cannot satisfy the output schema.' }],
  }))
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no structured content/)
  assertSettlement(false)
})

test('an invalid CallToolResult envelope is rejected before successful settlement', async () => {
  const result = await callTool({}, async () => ({ content: [{ type: 'text', text: 42 }] }))
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid MCP tool result/)
  assertSettlement(false)
})

test('an explicit error result needs no structured success payload and is preserved', async () => {
  const result = await callTool({ outputSchema: { value: z.number() } }, async () => ({
    isError: true, content: [{ type: 'text', text: 'Dataset temporarily unavailable.' }],
  }))
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'Dataset temporarily unavailable.')
  assertSettlement(false)
})

test('a Zod object output schema keeps the same validation and settlement behavior', async () => {
  const result = await callTool({ outputSchema: z.object({ value: z.number() }) }, async () => ({
    content: [{ type: 'text', text: '{"value":7}' }], structuredContent: { value: 7 },
  }))
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { value: 7 })
  assertSettlement(true)
})

test('SDK input validation failures never reserve a successful-call slot', async () => {
  let ran = false
  const result = await callTool({ inputSchema: { value: z.number() } }, async () => {
    ran = true
    return { content: [] }
  }, { value: 'wrong' })
  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.equal(calls.length, 0)
})

test('both protocol generations reject oversized collections before element validation or allowance work', async t => {
  for (const modern of [false, true]) {
    await t.test(modern ? 'current SDK' : 'legacy SDK', async () => {
      calls = []
      let parsed = 0
      let executed = 0
      const server = modern ? createModernMcpServer() : createMcpServer()
      server.registerTool('collection_validation_test', {
        inputSchema: { values: z.array(z.string().refine(() => { parsed++; return true })) },
      }, async () => { executed++; return { content: [] } })
      const client = modern ? new ModernClient({ name: 'collection-current-test', version: '1' })
        : new Client({ name: 'collection-legacy-test', version: '1' })
      const Transport = modern ? ModernInMemoryTransport : InMemoryTransport
      const [clientSide, serverSide] = Transport.createLinkedPair()
      try {
        await server.connect(serverSide)
        await client.connect(clientSide)
        const rejected = await client.callTool({ name: 'collection_validation_test',
          arguments: { values: Array(MAX_TOOL_INPUT_ELEMENTS + 1).fill('x') } })
        assert.equal(rejected.isError, true)
        assert.match(rejected.content[0].text, /maximum of 10000 elements/)
        assert.equal(parsed, 0, 'the SDK must reject before walking array elements')
        assert.equal(executed, 0)
        assert.equal(calls.length, 0, 'rejection must neither reserve allowance nor report a callback')

        const accepted = await client.callTool({ name: 'collection_validation_test', arguments: { values: ['a', 'b'] } })
        assert.equal(accepted.isError, undefined)
        assert.equal(parsed, 2)
        assert.equal(executed, 1)
        assertSettlement(true)
      } finally { await Promise.allSettled([client.close(), server.close()]) }
    })
  }
})

test('unknown settlement preserves the completed saved result and never sends the opposite outcome', async () => {
  mode = 'uncertain'
  const result = await callTool({ outputSchema: { saved: z.boolean(), draftId: z.number() } }, async () => ({
    content: [{ type: 'text', text: '{"saved":true,"draftId":42}' }], structuredContent: { saved: true, draftId: 42 },
  }))
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, '{"saved":true,"draftId":42}')
  assert.deepEqual(result.structuredContent, { saved: true, draftId: 42 })
  assert.match(result.content.at(-1).text, /tool completed.*could not confirm/s)
  assert.match(result.content.at(-1).text, /review it before repeating a write/)
  assert.match(result.content.at(-1).text, /Do not automatically retry/)
  const finishes = calls.filter(call => call.path.endsWith('/finish'))
  assert.ok(finishes.length > 0)
  assert.ok(finishes.every(call => call.body.success === true), 'a known-successful callback must never be falsely refunded')
  assert.equal(calls.filter(call => call.path.endsWith('/reserve')).length, 1)
})
