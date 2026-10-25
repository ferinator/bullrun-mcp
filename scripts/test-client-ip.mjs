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
  if (req.url.startsWith('/api/spent/') || req.url.startsWith('/api/screener/filter?spent=')) {
    res.statusCode = 429
    const account = req.url.startsWith('/api/spent/account') || new URL(req.url, 'http://fixture.test').searchParams.get('spent') === 'account'
    res.end(JSON.stringify({ error: 'quota_exceeded', limit: account ? 10500 : 3500,
      resetAt: '2026-11-20T10:05:00Z', window: '30d', pool: account ? 'account' : 'caller' }))
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
const { allowanceMessage, parseQuotaNotice, ACCOUNT_SETUP_URL, PRICING_URL } = await import('../dist/usage/allowance.js')
const { mapWithConcurrency } = await import('../dist/tools/etfData.js')

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
  assert.match(result.content[0].text, /failed call does not use your Bullrun tool-call allowance/)
  assert.doesNotMatch(result.content[0].text, /subscrib|pricing|account\/mcp/i)
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

test('free read allowances explain Pro subscriptions and the appropriate account handoff', () => {
  const at = '2026-11-20T10:05:00Z'
  const anonMonth = allowanceMessage({ pool: 'caller', window: '30d', limit: 3500, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(anonMonth, /This connection.*free research limit/)
  assert.match(anonMonth, /3,500 data reads per rolling 30 days/)
  assert.match(anonMonth, /starts refilling at 10:05 UTC on 20 Nov 2026 \(in about [^)]+\)/)
  assert.match(anonMonth, /New accounts.*14-day free trial, no card needed/)
  assert.ok(anonMonth.includes(`[Connect your account](${ACCOUNT_SETUP_URL})`))
  assert.match(anonMonth, /in your AI app to use its limits/)
  assert.ok(anonMonth.includes(`[Get higher limits with Bullrun Pro](${PRICING_URL}?utm_source=mcp&utm_medium=assistant&utm_campaign=allowance&utm_content=caller_30d)`))
  const anonDay = allowanceMessage({ pool: 'caller', window: '24h', limit: 500, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(anonDay, /This connection.*500 data reads per rolling 24 hours/)
  assert.match(anonDay, /starts refilling at/)
  assert.ok(anonDay.includes('utm_content=caller_24h'))
  // A connected free account gains Pro limits when that same account subscribes; no reconnect is required.
  const account = allowanceMessage({ pool: 'account', window: '30d', limit: 10500, resetAt: at }, { signedIn: true, marketplace: false })
  assert.match(account, /Your Bullrun account.*10,500 data reads per rolling 30 days/)
  assert.ok(account.includes(PRICING_URL) && !account.includes(ACCOUNT_SETUP_URL))
  assert.match(account, /Upgrade the account already connected/)
  assert.doesNotMatch(account, /Connect your account|reconnect|trial/)
  for (const text of [anonMonth, anonDay, account]) {
    assert.match(text, /CHF 5\/month or CHF 50\/year/)
    assert.match(text, /Pro usage limits apply/)
    assert.doesNotMatch(text, /account\/mcp|per minute|could not be loaded|not stored|unlimited|remove the .*caps|today's|this month's/)
  }
  for (const text of [anonMonth, anonDay]) {
    const visible = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    assert.ok(visible.trim().split(/\s+/).length < 110, 'anonymous quota guidance stays short')
  }
})

test('shared capacity, probes, Pro and marketplace limits do not send callers to subscribe', () => {
  const at = '2026-11-20T10:05:00Z'
  const shared = ['anonymous_total', 'shared'].map(pool => allowanceMessage(
    { pool, window: '24h', limit: 50000, resetAt: at }, { signedIn: false, marketplace: false }))
  for (const text of shared) {
    assert.match(text, /shared anonymous research capacity/)
    assert.ok(text.includes(`[Connect a free account](${ACCOUNT_SETUP_URL})`))
    assert.match(text, /separate allowance/)
    assert.match(text, /No subscription needed/)
  }
  const probe = allowanceMessage({ pool: 'probe', window: '24h', limit: 100, resetAt: at }, { signedIn: false, marketplace: false })
  assert.match(probe, /shared health-check limit.*100 data reads per rolling 24 hours/)
  assert.ok(!probe.includes(ACCOUNT_SETUP_URL))
  const pro = allowanceMessage({ pool: 'pro', window: '5h', limit: 1000, resetAt: at }, { signedIn: true, marketplace: false })
  assert.match(pro, /Bullrun Pro research limit.*1,000 data reads per rolling 5 hours/)
  const marketplace = allowanceMessage({ pool: 'installation', window: '24h', limit: 10000, resetAt: at }, { signedIn: false, marketplace: true })
  assert.match(marketplace, /10,000 data reads per rolling 24 hours/)
  // Marketplace context must never redirect installation billing to Bullrun, whatever notice arrives.
  const gatewayCaller = allowanceMessage({ pool: 'caller', window: '24h', limit: 500, resetAt: at }, { signedIn: false, marketplace: true })
  const gatewayCalls = allowanceMessage({ pool: 'mcp_calls', window: '30d', limit: 700, resetAt: at }, { signedIn: false, marketplace: true })
  for (const text of [marketplace, gatewayCaller, gatewayCalls]) {
    assert.ok(!text.includes(ACCOUNT_SETUP_URL))
    assert.match(text, /marketplace installation/)
  }
  assert.match(gatewayCaller, /500 data reads per rolling 24 hours/)
  assert.match(gatewayCalls, /700 successful tool calls per rolling 30 days/)
  assert.match(gatewayCalls, /Failed calls don't count/)
  // All branches identify usage limits and the first refill, without claiming missing data or a full reset.
  for (const text of [...shared, probe, pro, marketplace, gatewayCaller, gatewayCalls]) {
    assert.match(text, /starts refilling at 10:05 UTC on 20 Nov 2026/)
    assert.doesNotMatch(text, /account\/mcp|per minute|could not be loaded|not stored|no data|resets at/i)
  }
  for (const text of [...shared, probe, pro, marketplace, gatewayCaller, gatewayCalls]) {
    assert.ok(!text.includes(PRICING_URL))
    assert.doesNotMatch(text, /subscrib(?:e|ing)|Pro subscriptions|upgrade|higher limits|trial|CHF|unlimited|remove the .*caps/i)
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
  const throwingTool = path => () => recordMcpToolInvocation('screen_stocks', async () => {
    await bullrunPost(path, {})
    return { content: [] }
  }, reporter)
  for (const { run, signedIn } of [
    { run: settledTool, signedIn: false },
    { run: throwingTool('/api/screener/filter?spent=caller'), signedIn: false },
    { run: throwingTool('/api/screener/filter?spent=account'), signedIn: true },
  ]) {
    const invoke = () => runWithMcpUsage({ clientIp: '203.0.113.50' }, run)
    const result = await (signedIn ? runWithAuth({ token: 't', userId: 7, scopes: [] }, invoke) : invoke())
    assert.equal(result.isError, true)
    const text = result.content[0].text
    assert.match(text, signedIn ? /Your Bullrun account.*free research limit/ : /This connection.*free research limit/)
    assert.match(text, signedIn ? /10,500 data reads per rolling 30 days/ : /3,500 data reads per rolling 30 days/)
    assert.ok(text.includes(PRICING_URL))
    assert.doesNotMatch(text, /account\/mcp/)
    if (signedIn) {
      assert.match(text, /Upgrade the account already connected/)
      assert.ok(!text.includes(ACCOUNT_SETUP_URL))
      assert.doesNotMatch(text, /reconnect|trial/)
    } else {
      assert.ok(text.includes(`[Connect your account](${ACCOUNT_SETUP_URL})`))
      assert.match(text, /in your AI app to use its limits/)
    }
    assert.equal(result.content.length, 1)
  }
  assert.deepEqual(events.map(e => [e.outcome, e.quotaExhausted]),
    [['error', 'caller:30d'], ['error', 'caller:30d'], ['error', 'account:30d']])
  assert.equal(events[0].meteredReads, 1)
})

test('a run-out says in UTC and in rough hours when the allowance starts refilling', () => {
  const caller = { signedIn: false, marketplace: false }
  const now = new Date('2026-10-23T17:55:00Z')
  const message = resetAt => allowanceMessage({ pool: 'caller', window: '24h', limit: 500, resetAt }, caller, now)
  assert.match(message('2026-10-24T07:55:00Z'), /starts refilling at 07:55 UTC on 24 Oct 2026 \(in about 14 hours\)/)
  assert.match(message('2026-10-23T18:25:00Z'), /at 18:25 UTC on 23 Oct 2026 \(in about 30 minutes\)/)
  assert.match(message('2026-11-20T17:55:00Z'), /at 17:55 UTC on 20 Nov 2026 \(in about 28 days\)/)
  // A reset already due (clock skew) never reads as a time in the past.
  assert.match(message('2026-10-23T17:50:00Z'), /\(in about 1 minute\)/)
  assert.match(message(undefined), /refills gradually as earlier use expires/)
  assert.match(message('not a date'), /refills gradually as earlier use expires/)
  assert.doesNotMatch(message('not a date'), /Invalid Date|starts refilling at|resets at/)
})

test('after a run-out a fan-out tool stops calling bullrun-api, and the refused call is still reported', async () => {
  const before = seen.length
  const result = await runWithMcpUsage({ clientIp: '203.0.113.52' }, () => recordMcpToolInvocation('get_etf_exposures', async () => {
    // Like get_etf_exposures: one lookup per holding. The third lookup finds the allowance spent.
    const holdings = Array.from({ length: 40 }, (_, i) => i === 2 ? '/api/spent/fanout' : `/api/holding/H${i}`)
    await mapWithConcurrency(holdings, 1, path => bullrunGet(path).catch(() => null))
    return { content: [{ type: 'text', text: 'exposures' }] }
  }))
  const urls = seen.slice(before).map(request => request.url)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /This connection.*free research limit.*3,500 data reads per rolling 30 days/)
  assert.deepEqual(urls.filter(url => !url.startsWith('/api/analytics/')), ['/api/holding/H0', '/api/holding/H1', '/api/spent/fanout'])
  // The tool-call report is exempt, so the refusal still reaches the admin analytics.
  assert.deepEqual(urls.filter(url => url.startsWith('/api/analytics/')), ['/api/analytics/mcp-tools'])
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
  assert.doesNotMatch(result.content[0].text, /subscrib|pricing|account\/mcp/i)
  assert.equal(events[0].quotaExhausted, undefined)
})
