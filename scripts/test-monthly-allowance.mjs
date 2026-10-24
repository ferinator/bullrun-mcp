import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { after, beforeEach, test } from 'node:test'

const secret = 'monthly-allowance-test-key-at-least-32-bytes'
process.env.MCP_ALLOWANCE_ENABLED = 'true'
process.env.BULLRUN_MCP_GATEWAY_SECRET = secret
const { recordMcpToolInvocation } = await import('../dist/usage/invocations.js')
const { runWithMcpUsage } = await import('../dist/usage/context.js')
const { runWithAuth } = await import('../dist/auth/context.js')
const { runWithGateway } = await import('../dist/gateway/context.js')
const { ACCOUNT_SETUP_URL, PRICING_URL } = await import('../dist/usage/allowance.js')

const originalFetch = globalThis.fetch
let calls = []
let mode = 'normal'
let finishes = 0
beforeEach(() => {
  calls = []; mode = 'normal'; finishes = 0
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    const path = new URL(url).pathname
    const timestamp = options.headers['X-Bullrun-Mcp-Allowance-Timestamp']
    const digest = createHash('sha256').update(options.body).digest('hex')
    const expected = createHmac('sha256', secret).update(['mcp-allowance', 'POST', path, timestamp, digest].join('\n')).digest('hex')
    assert.equal(options.headers['X-Bullrun-Mcp-Allowance-Signature'], expected)
    calls.push({ path, body, headers: options.headers })
    if (path.endsWith('/reserve')) {
      if (mode === 'down') throw new Error('connection failed')
      if (mode === 'spent') return Response.json({ error: 'quota_exceeded', pool: 'mcp_calls', window: '30d', limit: 700, resetAt: '2026-11-20T12:00:00Z' }, { status: 429 })
      return Response.json({ allowed: true, exempt: mode === 'pro', operationId: body.operationId })
    }
    if (path.endsWith('/finish')) {
      finishes++
      if (mode === 'retry' && finishes === 1) throw new Error('lost first reply')
      if (mode === 'all-acks-lost') throw new Error('committed, but every finish reply was lost')
      return Response.json({ settled: true })
    }
    if (path.endsWith('/status')) return Response.json({ state: 'success' })
    throw new Error('Unexpected control request')
  }
})
after(() => { globalThis.fetch = originalFetch })
const report = async () => {}
const invoke = callback => runWithMcpUsage({ clientIp: '203.0.113.42' },
  () => recordMcpToolInvocation('compare_stocks', callback, report))

test('one successful tool call reserves and commits exactly once despite internal work', async () => {
  let backendReads = 0
  const result = await invoke(async () => {
    await Promise.all(Array.from({ length: 30 }, async () => { backendReads++ }))
    return { content: [{ type: 'text', text: 'comparison' }] }
  })
  assert.equal(result.isError, undefined)
  assert.equal(backendReads, 30)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.callerIp, '203.0.113.42')
  assert.equal(calls[1].body.operationId, calls[0].body.operationId)
  assert.equal(calls[1].body.success, true)
})

test('tool errors and thrown exceptions release their reservation', async () => {
  const result = await invoke(async () => ({ isError: true, content: [] }))
  assert.equal(result.isError, true)
  assert.equal(calls.at(-1).body.success, false)
  const original = new Error('backend failed')
  await assert.rejects(invoke(async () => { throw original }), error => error === original)
  assert.equal(calls.at(-1).body.success, false)
})

for (const signedIn of [false, true]) {
  test(`the 701st ${signedIn ? 'account' : 'anonymous'} call explains Pro and its account connection before any research runs`, async () => {
    mode = 'spent'
    let ran = false
    const run = () => invoke(async () => { ran = true; return { content: [] } })
    const result = await (signedIn ? runWithAuth({ token: 'test-bearer', userId: 42, scopes: ['read:market'] }, run) : run())
    assert.equal(ran, false)
    assert.equal(result.isError, true)
    const text = result.content[0].text
    assert.match(text, /700 successful tool calls per rolling 30 days/)
    assert.match(text, signedIn ? /Your Bullrun account/ : /This network/)
    assert.match(text, /starts refilling at 12:00 UTC on 20 Nov 2026 \(in about [^)]+\)/)
    assert.match(text, /Failed calls don't count/)
    assert.ok(text.includes(`[Get higher limits with Bullrun Pro](${PRICING_URL}?utm_source=mcp&utm_medium=assistant&utm_campaign=allowance&utm_content=mcp_calls_30d)`))
    assert.match(text, /CHF 5\/month or CHF 50\/year/)
    assert.match(text, /Pro usage limits apply/)
    if (signedIn) {
      assert.match(text, /Upgrade the account already connected/)
      assert.ok(!text.includes(ACCOUNT_SETUP_URL))
      assert.doesNotMatch(text, /Connect your account|reconnect|trial/)
      assert.equal(calls[0].headers.authorization, 'Bearer test-bearer')
    } else {
      assert.match(text, /New accounts.*14-day free trial, no card needed/)
      assert.ok(text.includes(`[Connect your account](${ACCOUNT_SETUP_URL})`))
      assert.match(text, /in your AI app to use its limits/)
      const visible = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      assert.ok(visible.trim().split(/\s+/).length < 110, 'anonymous quota guidance stays short')
    }
    assert.doesNotMatch(text, /account\/mcp|data reads|unlimited|remove the .*caps|resets at|this month's/)
    assert.equal(calls.length, 1)
  })
}

test('an unavailable quota service fails closed before executing research', async () => {
  mode = 'down'
  let ran = false
  const result = await invoke(async () => { ran = true; return { content: [] } })
  assert.equal(ran, false)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /could not confirm/)
  assert.doesNotMatch(result.content[0].text, /subscrib|pricing|account\/mcp/i)
})

test('settlement retries the same operation and account identity is authenticated separately', async () => {
  mode = 'retry'
  const result = await runWithAuth({ token: 'test-bearer', userId: 42, scopes: ['read:market'] },
    () => invoke(async () => ({ content: [] })))
  assert.equal(result.isError, undefined)
  assert.equal(finishes, 2)
  assert.equal(new Set(calls.map(call => call.body.operationId)).size, 1)
  assert.ok(calls.every(call => call.body.userId === 42))
  assert.equal(calls[0].headers.authorization, 'Bearer test-bearer')
  assert.equal(calls[1].headers.authorization, undefined)
})

test('lost finish acknowledgements recover the durable success without losing a saved result', async () => {
  mode = 'all-acks-lost'
  const result = await invoke(async () => ({ content: [{ type: 'text', text: 'Saved draft 42' }], structuredContent: { draftId: 42 } }))
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.draftId, 42)
  assert.equal(finishes, 3)
  assert.ok(calls.at(-1).path.endsWith('/status'))
  assert.equal(calls.filter(call => call.body.success === false).length, 0)
})

test('Pro and trial exemptions are decided by the API and do not create a finish charge', async () => {
  mode = 'pro'
  const result = await invoke(async () => ({ content: [] }))
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 1)
})

test('marketplace plans use their own gateway allowance without a duplicate 700-call charge', async () => {
  const result = await runWithGateway({ listingId: 'research', installationId: 'buyer', deadline: Date.now() + 10000 },
    () => invoke(async () => ({ content: [] })))
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 0)
})
