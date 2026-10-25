import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { after, beforeEach, test } from 'node:test'

const secret = 'tool-operation-test-secret-at-least-32-bytes'
process.env.MCP_ALLOWANCE_ENABLED = 'true'
process.env.BULLRUN_MCP_GATEWAY_SECRET = secret
const { recordMcpToolInvocation } = await import('../dist/usage/invocations.js')
const { runWithMcpUsage, getMcpUsage } = await import('../dist/usage/context.js')
const { runWithAuth } = await import('../dist/auth/context.js')
const { bullrunGet, bullrunPost } = await import('../dist/bullrun.js')
const { parseCapacityNotice } = await import('../dist/usage/operation.js')
const { registerResearchShortlist } = await import('../dist/tools/researchShortlist.js')
const { registerCreatePortfolioDraft } = await import('../dist/tools/createPortfolioDraft.js')

const originalFetch = globalThis.fetch
let control, backend, events, mode
beforeEach(() => {
  control = []; backend = []; events = []; mode = 'normal'
  globalThis.fetch = async (input, options) => {
    const url = new URL(input)
    if (url.pathname.startsWith('/api/internal/mcp-allowance/')) {
      const body = JSON.parse(options.body)
      control.push({ path: url.pathname, body })
      if (url.pathname.endsWith('/reserve')) {
        if (mode === 'busy-admission') return Response.json({ error: 'mcp_capacity_exceeded', reason: 'caller_attempt_pacing', retryAfterSeconds: 12 }, { status: 429 })
        if (mode === 'pro-spent') return Response.json({ error: 'quota_exceeded', pool: 'mcp_calls', window: '5h', limit: 1000, resetAt: new Date(Date.now() + 3600000).toISOString() }, { status: 429 })
        return Response.json({ allowed: true, operationId: body.operationId, principalKey: mode === 'invalid-lease' ? 'bad\r\nheader' : 'ip:test',
          expiresAt: new Date(Date.now() + 300000).toISOString(), maxRequests: mode === 'bounded' ? 2 : 1024,
          window: '30d', limit: 700 })
      }
      if (url.pathname.endsWith('/finish')) {
        if (mode === 'write-settlement-uncertain') throw new Error('lost settlement acknowledgement')
        return Response.json({ settled: true })
      }
      throw new Error(`Unexpected control request: ${url.pathname}`)
    }
    const headers = options.headers
    if (url.pathname === '/api/analytics/mcp-tools') {
      assert.equal(headers['X-Bullrun-Mcp-Operation-Id'], undefined)
      return Response.json({ ok: true })
    }
    const timestamp = headers['X-Bullrun-Mcp-Operation-Timestamp']
    const operationId = headers['X-Bullrun-Mcp-Operation-Id']
    const digest = createHash('sha256').update(options.body ?? '').digest('hex')
    const canonical = ['mcp-operation', options.method ?? 'GET', url.pathname + url.search, timestamp,
      operationId, headers['X-Bullrun-Mcp-Operation-Principal'], headers['X-Bullrun-Mcp-Operation-Tool'], digest].join('\n')
    assert.equal(headers['X-Bullrun-Mcp-Operation-Signature'], createHmac('sha256', secret).update(canonical).digest('hex'))
    const reservation = control.find(call => call.path.endsWith('/reserve') && call.body.operationId === operationId)
    assert.ok(reservation)
    assert.equal(headers['X-Bullrun-Mcp-Operation-Tool'], reservation.body.toolName)
    backend.push({ url: url.pathname + url.search, operationId, body: options.body })
    const busy = () => Response.json({ error: 'mcp_capacity_exceeded', reason: 'global_concurrency', retryAfterSeconds: 3 }, { status: 429 })
    if (mode === 'partial-shortlist') {
      if (url.pathname === '/api/short-list/AAPL') return Response.json({ id: 1, ticker: 'AAPL' })
      if (url.pathname === '/api/short-list/MSFT') return busy()
    }
    if (mode === 'draft-poll-capacity') {
      if (url.pathname === '/api/portfolios/ai-draft') return Response.json({ jobId: 'draft-job-42', status: 'running', private: 'never-retain-this' })
      return busy()
    }
    if (mode === 'write-transport') throw new Error('private.internal/token-secret request-prompt-secret')
    if (mode === 'write-malformed-confirmation') return new Response('invalid JSON, private.internal/token-secret', { status: 200 })
    if (mode === 'bounded-write-receipts') {
      if (url.pathname.startsWith('/api/short-list/')) return Response.json({ ticker: url.pathname.split('/').at(-1), token: 'token-secret', prompt: 'request-prompt-secret' })
      return busy()
    }
    if (mode === 'write-settlement-uncertain') return Response.json({ draftId: 42, private: 'never-retain-this' })
    if (mode === 'busy-work') return Response.json({ error: 'mcp_capacity_exceeded', reason: 'global_concurrency', retryAfterSeconds: 3 }, { status: 429 })
    return Response.json({ ok: true }, { headers: { 'X-Bullrun-Quota-Category': 'mcp_work' } })
  }
})
after(() => { globalThis.fetch = originalFetch })

const invoke = callback => runWithMcpUsage({ clientIp: '203.0.113.42' }, () =>
  recordMcpToolInvocation('operation_test', callback, async event => { events.push(event) }))
const finish = () => control.filter(call => call.path.endsWith('/finish'))
const registered = (register, toolName) => {
  let callback
  register({ registerTool(name, _config, handler) { if (name === toolName) callback = handler } })
  assert.equal(typeof callback, 'function')
  return callback
}
const account = callback => runWithAuth({ token: 'test-token', userId: 42, scopes: ['write:shortlist', 'write:drafts'] }, callback)
const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
const assertWriteWarning = result => {
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /^This request did not finish\. Changes may already exist/)
  assert.match(result.content[0].text, /Review .*before retrying/)
  assert.match(result.content[0].text, /Do not automatically retry/)
  assert.match(result.content[0].text, /No tool-call unit was used/)
  assert.doesNotMatch(text(result), /Retry in about|private\.internal|token-secret|request-prompt-secret|never-retain-this/)
  assert.ok(finish().every(call => call.body.success === false))
  assert.doesNotMatch(JSON.stringify(events), /receipts|AAPL|draft-job-42|token-secret|request-prompt-secret/)
}

test('501 backend reads cost exactly one successful customer call', async () => {
  const result = await invoke(async () => {
    for (let index = 0; index < 501; index++) await bullrunGet('/api/financials/AAPL', { index })
    return { content: [{ type: 'text', text: 'complete' }] }
  })
  assert.equal(result.isError, undefined)
  assert.equal(backend.length, 501)
  assert.equal(new Set(backend.map(call => call.operationId)).size, 1)
  assert.equal(control[0].body.toolName, 'operation_test')
  assert.equal(finish().length, 1)
  assert.equal(finish()[0].body.success, true)
  assert.equal(events[0].meteredReads, 501)
})

test('operation proof signs exact POST bytes as well as the raw query', async () => {
  const body = { rules: [{ value: 'a/b + x', amount: 42 }], isins: ['US0378331005'] }
  await invoke(async () => {
    await bullrunPost('/api/stocks/identity-batch?origin=a%2Fb', body)
    return { content: [] }
  })
  assert.equal(backend[0].body, JSON.stringify(body))
  assert.equal(backend[0].url, '/api/stocks/identity-batch?origin=a%2Fb')
})

test('admission pacing explains the wait before any research or customer charge', async () => {
  mode = 'busy-admission'
  let ran = false
  const result = await invoke(async () => { ran = true; return { content: [] } })
  assert.equal(ran, false)
  assert.equal(backend.length, 0)
  assert.equal(finish().length, 0)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /12 seconds.*No tool-call unit was used/)
  assert.equal(events[0].capacityLimited, true)
  assert.equal(events[0].quotaExhausted, undefined)
})

test('resource refusal stops further work and refunds the single call, even if a tool catches it', async () => {
  mode = 'busy-work'
  const result = await invoke(async () => {
    for (let index = 0; index < 10; index++) await bullrunGet('/api/financials/AAPL').catch(() => null)
    return { content: [{ type: 'text', text: 'partial result' }] }
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /3 seconds.*No tool-call unit was used/)
  assert.equal(backend.length, 1)
  assert.equal(finish()[0].body.success, false)
  assert.equal(events[0].capacityLimited, true)
})

test('bounded operation work fails before sending the excess request and spends no call', async () => {
  mode = 'bounded'
  const result = await invoke(async () => {
    for (let index = 0; index < 3; index++) await bullrunGet('/api/financials/AAPL')
    return { content: [] }
  })
  assert.equal(backend.length, 2)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /too large.*fewer results.*No tool-call unit was used/)
  assert.equal(finish()[0].body.success, false)
})

test('invalid operation receipt is refused before executing a callback', async () => {
  mode = 'invalid-lease'
  let ran = false
  const result = await invoke(async () => { ran = true; return { content: [] } })
  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.equal(backend.length, 0)
  assert.equal(finish().length, 0)
})

test('Pro call limit names successful calls and its refill, without an upgrade prompt', async () => {
  mode = 'pro-spent'
  const result = await runWithAuth({ token: 'test-token', userId: 42, scopes: ['read:market'] }, () => invoke(async () => { throw new Error('must not run') }))
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Pro limit of 1,000 successful tool calls per rolling 5 hours/)
  assert.match(result.content[0].text, /starts refilling at/)
  assert.doesNotMatch(result.content[0].text, /pricing|trial|Upgrade|data reads/)
})

test('capacity metadata is only accepted for defined capacity or operation errors', () => {
  assert.equal(parseCapacityNotice(500, '{"error":"mcp_capacity_exceeded"}'), undefined)
  assert.equal(parseCapacityNotice(429, '{"error":"quota_exceeded"}'), undefined)
  assert.deepEqual(parseCapacityNotice(429, '{"error":"mcp_capacity_exceeded","reason":"busy","retryAfterSeconds":-1}'), { reason: 'busy', retryAfterSeconds: 1 })
})

test('a partial shortlist save keeps saved items when a later write hits capacity', async () => {
  mode = 'partial-shortlist'
  const save = registered(registerResearchShortlist, 'save_research_shortlist')
  const result = await account(() => invoke(() => save({ tickers: ['AAPL', 'MSFT'] })))
  assertWriteWarning(result)
  const partial = result.content.filter(part => part.type === 'text').map(part => {
    try { return JSON.parse(part.text) } catch { return null }
  }).find(value => value?.savedCount === 1)
  assert.equal(partial.partial, true)
  assert.deepEqual(partial.items.map(item => item.ticker), ['AAPL'])
  assert.deepEqual(partial.failures.map(item => item.ticker), ['MSFT'])
  assert.deepEqual(result.structuredContent.writeReceipts, [{ kind: 'shortlist', ticker: 'AAPL' }])
  assert.equal(backend.length, 2)
  assert.equal(finish().length, 1)
})

test('a created draft job remains discoverable when a subsequent status poll hits capacity', async () => {
  mode = 'draft-poll-capacity'
  const draft = registered(registerCreatePortfolioDraft, 'create_portfolio_draft')
  const result = await account(() => invoke(() => draft({ prompt: 'request-prompt-secret' })))
  assertWriteWarning(result)
  assert.deepEqual(result.structuredContent.writeReceipts, [{ kind: 'portfolio_draft_job', jobId: 'draft-job-42' }])
  assert.equal(backend.length, 2)
  assert.equal(finish().length, 1)
})

test('a write whose transport fails warns about an unknown account outcome without exposing its error', async () => {
  mode = 'write-transport'
  const result = await invoke(async () => {
    await bullrunPost('/api/portfolios/draft-basket', { prompt: 'request-prompt-secret' })
    return { content: [] }
  })
  assertWriteWarning(result)
  assert.deepEqual(result.structuredContent.writeReceipts, [])
  assert.equal(backend.length, 1)
  assert.equal(finish().length, 1)
})

test('a malformed write acknowledgement remains uncertain even if its tool catches the parse error', async () => {
  mode = 'write-malformed-confirmation'
  const result = await invoke(async () => {
    await bullrunPost('/api/portfolios/draft-basket').catch(() => null)
    return { isError: true, content: [{ type: 'text', text: 'private.internal/token-secret' }] }
  })
  assertWriteWarning(result)
  assert.deepEqual(result.structuredContent.writeReceipts, [])
})

test('write receipts are bounded and request-local, with no retained arguments or full account payloads', async () => {
  mode = 'bounded-write-receipts'
  const result = await invoke(async () => {
    for (let index = 0; index < 25; index++) await bullrunPost(`/api/short-list/A${index}`, { prompt: 'request-prompt-secret' })
    const progress = getMcpUsage().writes
    assert.equal(progress.acknowledged, 25)
    assert.equal(progress.receipts.length, 20)
    assert.doesNotMatch(JSON.stringify(progress), /token-secret|request-prompt-secret|private/)
    await bullrunGet('/api/financials/AAPL')
    return { content: [] }
  })
  assertWriteWarning(result)
  assert.equal(result.structuredContent.writeReceipts.length, 20)
  mode = 'normal'
  const separate = await invoke(async () => {
    assert.equal(getMcpUsage().writes.attempted, 0)
    assert.deepEqual(getMcpUsage().writes.receipts, [])
    return { content: [] }
  })
  assert.equal(separate.isError, undefined)
})

test('read-only POSTs and telemetry never become possible account writes', async () => {
  const result = await invoke(async () => {
    for (const path of ['/api/screener/filter', '/api/etfs/screener', '/api/stocks/identity-batch', '/api/analytics/mcp-tools']) {
      await bullrunPost(path, {})
    }
    assert.deepEqual(getMcpUsage().writes, { attempted: 0, acknowledged: 0, uncertain: false, receipts: [] })
    return { content: [] }
  })
  assert.equal(result.isError, undefined)
  assert.equal(finish()[0].body.success, true)
})

test('a completed write with uncertain successful settlement keeps its result and is never refunded', async () => {
  mode = 'write-settlement-uncertain'
  const result = await invoke(async () => {
    const { draftId } = await bullrunPost('/api/portfolios/draft-basket')
    return { content: [{ type: 'text', text: JSON.stringify({ saved: true, draftId }) }], structuredContent: { saved: true, draftId } }
  })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, { saved: true, draftId: 42 })
  assert.match(text(result), /tool completed.*could not confirm/s)
  assert.doesNotMatch(text(result), /No tool-call unit was used|never-retain-this/)
  assert.equal(finish().length, 3)
  assert.ok(finish().every(call => call.body.success === true))
})

test('concurrent tool invocations cannot share their private write progress', async () => {
  mode = 'bounded-write-receipts'
  let wrote
  const written = new Promise(resolve => { wrote = resolve })
  const [writer, reader] = await Promise.all([
    invoke(async () => {
      await bullrunPost('/api/short-list/AAPL')
      wrote()
      await Promise.resolve()
      assert.equal(getMcpUsage().writes.receipts[0].ticker, 'AAPL')
      return { content: [] }
    }),
    invoke(async () => {
      await written
      assert.deepEqual(getMcpUsage().writes, { attempted: 0, acknowledged: 0, uncertain: false, receipts: [] })
      return { content: [] }
    }),
  ])
  assert.equal(writer.isError, undefined)
  assert.equal(reader.isError, undefined)
})
