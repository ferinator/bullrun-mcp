import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'

const SECRET = 'test-mcp-gateway-secret-32-bytes-minimum'
const seen = []
const api = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers })
  // The two metered paths answer like RateLimitFilter does after charging a read.
  if (req.url.startsWith('/api/financials/') || req.url.startsWith('/api/prices/'))
    res.setHeader('X-Bullrun-Quota-Category', 'mcp_market')
  res.setHeader('Content-Type', 'application/json')
  // An MCP allowance that ran out, as RateLimitFilter answers it, and a website quota 429 without a pool.
  if (req.url.startsWith('/api/spent/')) {
    res.statusCode = 429
    res.end(JSON.stringify({ error: 'quota_exceeded', limit: 3500, resetAt: '2026-11-20T10:05:00Z', window: '30d', pool: 'caller' }))
    return
  }
  if (req.url.startsWith('/api/web429/')) {
    res.statusCode = 429
    res.end(JSON.stringify({ error: 'quota_exceeded', limit: 300, resetAt: '2026-11-20T10:05:00Z' }))
    return
  }
  res.end(req.url.startsWith('/api/prices/MISSING') ? (res.statusCode = 404, '{}') : '{"ok":true}')
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
process.env.BULLRUN_API_BASE = `http://127.0.0.1:${api.address().port}`
process.env.BULLRUN_MCP_GATEWAY_SECRET = SECRET

const { clientIpFromRequest, clientIpHeaders } = await import('../dist/usage/clientIp.js')
const { runWithMcpUsage, getMcpUsage } = await import('../dist/usage/context.js')
const { runWithGateway } = await import('../dist/gateway/context.js')
const { runWithAuth } = await import('../dist/auth/context.js')
const { bullrunGet, bullrunPost } = await import('../dist/bullrun.js')
const { recordMcpToolInvocation } = await import('../dist/usage/invocations.js')
const { createHeavyToolLimiter, heavyToolCallerKey } = await import('../dist/usage/heavyTools.js')
const { createGate, SCREEN_PATHS } = await import('../dist/usage/screenGate.js')
const { allowanceMessage, parseQuotaNotice, ACCOUNT_ENDPOINT, PRICING_URL } = await import('../dist/usage/allowance.js')

test.after(() => api.close())

const req = value => ({ headers: value === undefined ? {} : { 'cf-connecting-ip': value } })

test('takes the caller address only from a bare IP in the Cloudflare header', () => {
  assert.equal(clientIpFromRequest(req('203.0.113.7')), '203.0.113.7')
  assert.equal(clientIpFromRequest(req(' 2001:DB8::1 ')), '2001:db8::1')
  assert.equal(clientIpFromRequest(req(['198.51.100.2', '203.0.113.9'])), '198.51.100.2')
  for (const bad of [undefined, '', 'localhost', '203.0.113.7, 10.0.0.1', '203.0.113.7:443',
    'fe80::1%eth0', '999.1.1.1', '1234', 'a'.repeat(46)])
    assert.equal(clientIpFromRequest(req(bad)), undefined, String(bad))
  // Any other forwarding header is ignored: only cloudflared's is trusted.
  assert.equal(clientIpFromRequest({ headers: { 'x-forwarded-for': '203.0.113.7' } }), undefined)
})

test('signs label, method, raw target, timestamp and address with the gateway secret', () => {
  const url = new URL('http://api/api/stocks?search=A%26B&page=0')
  const headers = runWithMcpUsage({ clientIp: '203.0.113.7' }, () => clientIpHeaders('GET', url))
  const ts = headers['X-Bullrun-Mcp-Client-Ip-Timestamp']
  assert.match(ts, /^\d+$/)
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 5)
  assert.equal(headers['X-Bullrun-Mcp-Client-Ip'], '203.0.113.7')
  const expected = createHmac('sha256', SECRET)
    .update(['mcp-client-ip', 'GET', '/api/stocks?search=A%26B&page=0', ts, '203.0.113.7'].join('\n'))
    .digest('hex')
  assert.equal(headers['X-Bullrun-Mcp-Client-Ip-Signature'], expected)
})

test('sends nothing without a caller address, or for a marketplace installation', () => {
  const url = new URL('http://api/api/stocks')
  assert.deepEqual(clientIpHeaders('GET', url), {})
  assert.deepEqual(runWithMcpUsage({ sessionId: 's' }, () => clientIpHeaders('GET', url)), {})
  const gateway = runWithGateway({ listingId: 'l', installationId: 'i', deadline: Date.now() + 1000 },
    () => runWithMcpUsage({ clientIp: '203.0.113.7' }, () => clientIpHeaders('GET', url)))
  assert.deepEqual(gateway, {})
})

test('every API request carries the signed address and is counted on the tool call', async () => {
  seen.length = 0
  const events = []
  const reporter = async event => { events.push(event); await bullrunPost('/api/analytics/mcp-tools', event) }
  const result = await runWithMcpUsage({ sessionId: 's1', clientIp: '198.51.100.4' }, () =>
    recordMcpToolInvocation('get_stock_metrics', async () => {
      await bullrunGet('/api/stocks', { search: 'AAPL' })
      await bullrunGet('/api/financials/AAPL')
      await bullrunGet('/api/prices/AAPL', { limit: 5 })
      await assert.rejects(bullrunGet('/api/prices/MISSING'), /bullrun-api 404/)
      return { content: [] }
    }, reporter))
  assert.deepEqual(result, { content: [] })
  assert.equal(events.length, 1)
  // The report itself is a request too, and is not counted against the call it reports.
  assert.equal(events[0].apiCalls, 4)
  assert.equal(events[0].meteredReads, 3)
  assert.equal(events[0].rateLimited, undefined)
  assert.equal(seen.length, 5)
  for (const call of seen) {
    assert.equal(call.headers['x-bullrun-mcp-client-ip'], '198.51.100.4', call.url)
    assert.match(call.headers['x-bullrun-mcp-client-ip-signature'], /^[0-9a-f]{64}$/)
  }
  // The signature covers the exact target the API will see, query string included.
  const prices = seen.find(call => call.url.startsWith('/api/prices/AAPL'))
  assert.equal(prices.url, '/api/prices/AAPL?limit=5')
  const expected = createHmac('sha256', SECRET).update(['mcp-client-ip', 'GET', prices.url,
    prices.headers['x-bullrun-mcp-client-ip-timestamp'], '198.51.100.4'].join('\n')).digest('hex')
  assert.equal(prices.headers['x-bullrun-mcp-client-ip-signature'], expected)
})

test('concurrent tool calls keep their own read counts', async () => {
  const events = []
  const call = (ip, reads) => runWithMcpUsage({ clientIp: ip }, () =>
    recordMcpToolInvocation('compare_stocks', async () => {
      await Promise.all(Array.from({ length: reads }, (_, i) => bullrunGet(`/api/financials/T${i}`)))
      return { content: [] }
    }, async event => { events.push(event) }))
  await Promise.all([call('203.0.113.1', 2), call('203.0.113.2', 5)])
  assert.deepEqual(events.map(e => e.meteredReads).sort(), [2, 5])
})

test('heavy tools are limited per caller and per tool within a sliding minute', () => {
  const limiter = createHeavyToolLimiter(3)
  const t0 = 1_000_000
  for (let i = 0; i < 3; i++) assert.equal(limiter.take('screen_stocks', 'ip:a', t0 + i), 0)
  const wait = limiter.take('screen_stocks', 'ip:a', t0 + 10)
  assert.equal(wait, 60)
  // Another caller, another heavy tool, and any light tool are unaffected.
  assert.equal(limiter.take('screen_stocks', 'ip:b', t0 + 10), 0)
  assert.equal(limiter.take('screen_etfs', 'ip:a', t0 + 10), 0)
  for (let i = 0; i < 20; i++) assert.equal(limiter.take('get_stock_metrics', 'ip:a', t0 + 10), 0)
  // The refused call did not extend the window: the first slot frees a minute after the first call.
  assert.equal(limiter.take('screen_stocks', 'ip:a', t0 + 60_000), 0)
  assert.equal(limiter.take('screen_stocks', 'ip:a', t0 + 60_001), 0)
  assert.ok(limiter.take('screen_stocks', 'ip:a', t0 + 60_001) > 0)
})

test('a refused heavy call never runs, reports no reads, and says it was paced', async () => {
  const events = []
  let ran = false
  const limiter = { perMinute: 6, take: () => 42 }
  const result = await runWithMcpUsage({ clientIp: '203.0.113.9' }, () => recordMcpToolInvocation('screen_etfs',
    async () => { ran = true; return { content: [] } }, async event => { events.push(event) }, undefined, limiter))
  assert.equal(ran, false)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /6 calls per minute.*about 42 s/)
  assert.equal(events[0].outcome, 'error')
  assert.equal(events[0].rateLimited, true)
  assert.equal(events[0].apiCalls, 0)
})

test('screens run a few at a time, in order, and the rest wait for a slot', async () => {
  const gate = createGate(2)
  let running = 0
  let peak = 0
  const order = []
  const task = id => () => new Promise(resolve => {
    running++
    peak = Math.max(peak, running)
    order.push(id)
    setTimeout(() => { running--; resolve(id) }, 20)
  })
  const results = await Promise.all([1, 2, 3, 4, 5].map(id => gate.run(task(id))))
  assert.deepEqual(results, [1, 2, 3, 4, 5])
  assert.deepEqual(order, [1, 2, 3, 4, 5])
  assert.equal(peak, 2)
  assert.equal(gate.active, 0)
  assert.equal(gate.waiting, 0)
})

test('a screen that waits too long gives up without taking a slot, and a failure frees its slot', async () => {
  const gate = createGate(1)
  let finish
  const holder = gate.run(() => new Promise(resolve => { finish = resolve }))
  await assert.rejects(gate.run(async () => 'never', 30), /busy running other screens/)
  assert.equal(gate.waiting, 0)
  finish('done')
  assert.equal(await holder, 'done')
  await assert.rejects(gate.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await gate.run(async () => 'next'), 'next')
  assert.equal(gate.active, 0)
})

test('only the two screener POSTs are gated', async () => {
  seen.length = 0
  // Five screens at once against the stub: all succeed through the gate.
  await Promise.all(Array.from({ length: 5 }, () => bullrunPost('/api/screener/filter?limit=1', {})))
  await bullrunPost('/api/etfs/screener', {})
  assert.equal(seen.filter(call => call.method === 'POST').length, 6)
  assert.equal(SCREEN_PATHS.has('/api/screener/filter') && SCREEN_PATHS.has('/api/etfs/screener'), true)
  assert.equal(SCREEN_PATHS.has('/api/analytics/mcp-tools'), false)
})

test('the per-minute limit counts against the installation, the user, then the address', () => {
  assert.equal(heavyToolCallerKey(), 'anonymous')
  assert.equal(runWithMcpUsage({ clientIp: '203.0.113.9' }, heavyToolCallerKey), 'ip:203.0.113.9')
  assert.equal(runWithAuth({ token: 't', userId: 7, scopes: [] }, () =>
    runWithMcpUsage({ clientIp: '203.0.113.9' }, heavyToolCallerKey)), 'user:7')
  assert.equal(runWithGateway({ listingId: 'l', installationId: 'i', deadline: 0 }, heavyToolCallerKey),
    'gateway:l:i')
  assert.equal(getMcpUsage(), undefined)
})

test('only an MCP allowance 429 is read as a run-out notice', () => {
  assert.deepEqual(parseQuotaNotice('{"error":"quota_exceeded","limit":500,"resetAt":"2026-11-01T00:00:00Z","window":"24h","pool":"caller"}'),
    { pool: 'caller', window: '24h', limit: 500, resetAt: '2026-11-01T00:00:00Z' })
  assert.equal(parseQuotaNotice('{"error":"quota_exceeded","limit":300,"resetAt":"2026-11-01T00:00:00Z"}'), undefined)
  assert.equal(parseQuotaNotice('{"error":"quota_exceeded","pool":"invented"}'), undefined)
  assert.equal(parseQuotaNotice('Please wait a minute'), undefined)
})

test('the run-out message names the window, when reads return and the next step for that caller', () => {
  const at = '2026-11-20T10:05:00Z'
  const anonMonth = allowanceMessage({ pool: 'caller', window: '30d', limit: 3500, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(anonMonth, /this month's free Bullrun allowance/)
  assert.match(anonMonth, /3,500 data reads in 30 days/)
  assert.match(anonMonth, /from 2026-11-20 10:05 UTC/)
  assert.ok(anonMonth.includes(`${ACCOUNT_ENDPOINT} to save your research`))
  assert.ok(anonMonth.includes(PRICING_URL))
  const anonDay = allowanceMessage({ pool: 'caller', window: '24h', limit: 500, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(anonDay, /today's free Bullrun allowance .*500 data reads in 24 hours/)
  // A free account is pointed to Pro, never back to the account endpoint it already uses.
  const account = allowanceMessage({ pool: 'account', window: '30d', limit: 10500, resetAt: at }, { signedIn: true, marketplace: false })
  assert.match(account, /this month's allowance for your free Bullrun account \(10,500 data reads in 30 days\)/)
  assert.ok(account.includes(PRICING_URL) && !account.includes(ACCOUNT_ENDPOINT))
  const everyone = allowanceMessage({ pool: 'anonymous_total', window: '24h', limit: 50000, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(everyone, /across all users/)
  assert.ok(everyone.includes(ACCOUNT_ENDPOINT))
  const pro = allowanceMessage({ pool: 'pro', window: '5h', limit: 1000, resetAt: at }, { signedIn: true, marketplace: false })
  assert.match(pro, /Pro's fair-use limit \(1,000 data reads in 5 hours\)/)
  const marketplace = allowanceMessage({ pool: 'installation', window: '24h', limit: 10000, resetAt: at }, { signedIn: false, marketplace: true })
  assert.ok(!marketplace.includes(ACCOUNT_ENDPOINT) && !marketplace.includes(PRICING_URL))
  // Distinct from a coverage answer and from the per-minute pacing message.
  for (const text of [anonMonth, anonDay, account, everyone, pro, marketplace]) {
    assert.match(text, /usage allowance, not a gap in Bullrun's data/)
    assert.doesNotMatch(text, /per minute|could not be loaded|not stored/)
  }
})

test('a run-out mid-call answers with the allowance message, however the tool handled the failed read', async () => {
  const events = []
  const reporter = async event => { events.push(event) }
  const settledTool = () => recordMcpToolInvocation('compare_stocks', async () => {
    await bullrunGet('/api/financials/AAPL')
    const failed = await bullrunGet('/api/spent/MSFT').then(() => null, err => err.message)
    return { content: [{ type: 'text', text: `MSFT could not be loaded: ${failed}` }] }
  }, reporter)
  const throwingTool = () => recordMcpToolInvocation('screen_stocks', async () => {
    await bullrunPost('/api/spent/screen', {})
    return { content: [] }
  }, reporter)
  for (const run of [settledTool, throwingTool]) {
    const result = await runWithMcpUsage({ clientIp: '203.0.113.50' }, run)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /this month's free Bullrun allowance/)
    assert.equal(result.content.length, 1)
  }
  assert.deepEqual(events.map(e => [e.outcome, e.quotaExhausted]), [['error', 'caller:30d'], ['error', 'caller:30d']])
  assert.equal(events[0].meteredReads, 1)
})

test("a website-quota or proxy 429 keeps the tool's own answer", async () => {
  const events = []
  const result = await runWithMcpUsage({ clientIp: '203.0.113.51' }, () => recordMcpToolInvocation('get_stock_metrics',
    async () => {
      const failed = await bullrunGet('/api/web429/AAPL').then(() => null, err => err.message)
      return { content: [{ type: 'text', text: `could not be loaded: ${failed}` }] }
    }, async event => { events.push(event) }))
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /could not be loaded: bullrun-api 429/)
  assert.equal(events[0].quotaExhausted, undefined)
})
