import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

// Exercise the actual HTTP transport and AsyncLocalStorage contexts, not just helpers.
const cwd = fileURLToPath(new URL('..', import.meta.url))
const token = 'test-marketplace-token'
const secret = 'test-internal-signing-secret-at-least-32-bytes'
const listing = 'bullrun-listing'
const installation = 'buyer-installation-a'
const protocolVersion = '2025-06-18'
const calls = []
let apiServer
let base
let app
let session
let requestId = 0

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startApi() {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: rawBody && JSON.parse(rawBody) })
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/analytics/mcp-tools') return json(res, { ok: true })
    if (url.pathname === '/api/calendar/earnings') return json(res, [
      { ticker: 'AAPL', company: 'Apple', eventDate: '2026-10-29', currency: 'USD' },
    ])
    const researchMatch = url.pathname.match(/^\/api\/stocks\/(AAPL|MSFT)\/(risk-history|data-coverage|relationships)$/)
    if (researchMatch) {
      const ticker = researchMatch[1]
      if (researchMatch[2] === 'risk-history') return json(res, { ticker, companyName: ticker,
        history: [{asOfDate: '2026-10-18', dials: [{riskClass: 'LEVERAGE', score: 10, formulaVersion: 'v1', terms: [], change: null}]}], caveats: [] })
      if (researchMatch[2] === 'data-coverage') return json(res, { ticker, companyName: ticker,
        checkedAt: '2026-10-18T12:00:00Z', datasets: [{dataset:'prices',status:'available',latestPeriod:'2026-10-16',latestStoredAt:null}],
        graph: {status:'mapped'}, caveats: [] })
      return json(res, {status:'ready',subject:{name:ticker,ticker},nodes:[
        {id:ticker,name:ticker,ticker,role:'SELECTED'}, {id:'supplier',name:'Shared Supplier',ticker:null,role:'SUPPLIER'},
      ], edges:[{from:'supplier',to:ticker,type:'SUPPLIES_TO',status:'VERIFIED',confidence:0.9,
        soleSource:false,evidenceCount:1,metrics:[],evidence:[]}],caveats:[]})
    }
    if (url.pathname === '/api/markets/history') {
      const code = url.searchParams.get('code')
      // Returning nothing ensures an upstream timeout is reported as an MCP error.
      if (code === 'SLOW') return
      return json(res, { code, title: code === 'HUGE' ? 'x'.repeat(260 * 1024) : 'Policy rate',
        unit: 'percent', frequency: 'daily', points: [
          { date: '2025-01-01', value: 4 }, { date: '2025-02-01', value: 3.75 },
        ] })
    }
    if (url.pathname === '/api/screener/filter') return json(res, [{ ticker: 'AAPL', company: 'Apple' }])
    if (url.pathname === '/api/etfs/screener') return json(res, { rows: [], evaluatedCount: 100, matchCount: 0, truncated: false })
    return json(res, { error: `Unexpected stub request: ${req.method} ${req.url}` }, 404)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

async function reservePort() {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startApp(env = {}) {
  const port = await reservePort()
  const child = spawn(process.execPath, ['dist/index.js'], { cwd, windowsHide: true,
    env: { ...process.env, PORT: String(port), MCP_REQUIRE_AUTH: 'false',
      BULLRUN_API_BASE: `http://127.0.0.1:${apiServer.address().port}`,
      BULLRUN_API_TIMEOUT_MS: '250', MCPRUSH_TOKEN: token,
      MCPRUSH_DOMAIN_CLAIM: '',
      BULLRUN_MCP_GATEWAY_SECRET: secret, MCPRUSH_LISTING_ID: listing, ...env },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const url = `http://127.0.0.1:${port}`
  // Parallel suites can contend for module loading on Windows; bound readiness by
  // elapsed time instead of assuming 150 short polling intervals cover startup.
  const readyBy = Date.now() + 15000
  while (Date.now() < readyBy) {
    if (child.exitCode !== null) throw new Error(`MCP server exited early: ${output}`)
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(200) })
      if (health.ok) return { child, url }
    } catch { /* Wait for the child to listen. */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  child.kill()
  throw new Error(`MCP server did not start: ${output}`)
}

async function stopApp(instance) {
  if (!instance || instance.child.exitCode !== null) return
  const exited = once(instance.child, 'exit')
  instance.child.kill()
  await exited
}

function gatewayHeaders(install = installation) {
  return { 'x-mcprush-token': token, 'x-mcprush-listing': listing,
    ...(install === undefined ? {} : { 'x-mcprush-install': install }) }
}

async function rpc(method, params, { route = '/mcprush/mcp', headers = gatewayHeaders(),
  sessionId, url = base, notification = false } = {}) {
  const response = await fetch(`${url}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': protocolVersion,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method,
    ...(params === undefined ? {} : { params }) }), signal: AbortSignal.timeout(5_000) })
  const text = await response.text()
  // Public sessions retain SSE responses; marketplace sessions return JSON.
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    : text ? [JSON.parse(text)] : []
  return { status: response.status, headers: response.headers, text, body: messages.at(-1) }
}

async function initialize({ clientName = 'mcprush-integration-test', ...options } = {}) {
  const response = await rpc('initialize', { protocolVersion, capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' } }, options)
  assert.equal(response.status, 200, response.text)
  assert.ok(response.body.result.serverInfo)
  const sessionId = response.headers.get('mcp-session-id')
  assert.ok(sessionId)
  const initialized = await rpc('notifications/initialized', undefined,
    { ...options, sessionId, notification: true })
  assert.equal(initialized.status, 202, initialized.text)
  return sessionId
}

function callTool(name, args, options = {}) {
  return rpc('tools/call', { name, arguments: args }, { sessionId: session, ...options })
}

function researchCallsSince(index) {
  return calls.slice(index).filter(call => call.url.split('?')[0] !== '/api/analytics/mcp-tools')
}

function assertSigned(call, expectedInstallation = installation) {
  const timestamp = call.headers['x-bullrun-mcp-gateway-timestamp']
  assert.match(timestamp, /^\d+$/)
  assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 10)
  assert.equal(call.headers['x-bullrun-mcp-gateway-listing'], listing)
  assert.equal(call.headers['x-bullrun-mcp-gateway-installation'], expectedInstallation)
  const canonical = [call.method, call.url, timestamp, listing, expectedInstallation].join('\n')
  assert.equal(call.headers['x-bullrun-mcp-gateway-signature'],
    createHmac('sha256', secret).update(canonical).digest('hex'))
}

before(async () => {
  apiServer = await startApi()
  app = await startApp()
  base = app.url
  session = await initialize()
})

after(async () => {
  await stopApp(app)
  apiServer?.closeAllConnections()
  if (apiServer) await new Promise(resolve => apiServer.close(resolve))
})

test('modern and compatibility HTTP catalogs have isolated sessions and preserve legacy preset calls', async () => {
  const modern = { route: '/mcp', headers: {} }
  const legacy = { route: '/legacy/mcp', headers: {} }
  const modernSession = await initialize(modern)
  const legacySession = await initialize(legacy)
  const modernList = await rpc('tools/list', undefined, { ...modern, sessionId: modernSession })
  const legacyList = await rpc('tools/list', undefined, { ...legacy, sessionId: legacySession })
  const modernNames = modernList.body.result.tools.map(tool => tool.name)
  const legacyNames = legacyList.body.result.tools.map(tool => tool.name)
  assert.equal(modernNames.length, 48)
  assert.equal(legacyNames.length, 52)
  const before = calls.length
  for (const name of ['query_etfs', 'screen_stock_presets', 'analyze_etf_overlap', 'analyze_portfolio_fit']) {
    assert.equal(modernNames.includes(name), false)
    assert.ok(legacyNames.includes(name))
    const denied = await rpc('tools/call', { name, arguments: {} }, { ...modern, sessionId: modernSession })
    assert.ok(denied.body.error || denied.body.result?.isError)
  }
  const listed = await rpc('tools/call', { name: 'screen_stock_presets', arguments: { action: 'list' } },
    { ...legacy, sessionId: legacySession })
  assert.ok(!listed.body.result.isError)
  assert.equal(listed.body.result.structuredContent.action, 'list')
  assert.ok(listed.body.result.structuredContent.presets.length > 0)
  const modernPresets = await rpc('tools/call', { name: 'screen_stocks', arguments: { action: 'list_presets' } },
    { ...modern, sessionId: modernSession })
  assert.deepEqual(modernPresets.body.result.structuredContent.presets, listed.body.result.structuredContent.presets)
  assert.equal(researchCallsSince(before).length, 0, 'listing presets and refusing aliases must not fetch research data')
  for (const [options, wrongSession] of [[modern, legacySession], [legacy, modernSession]]) {
    assert.equal((await rpc('ping', undefined, { ...options, sessionId: wrongSession })).status, 404)
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}${options.route}`, { method,
        headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': wrongSession } })
      assert.equal(response.status, 404)
    }
  }
  const trailing = await rpc('ping', undefined, { ...legacy, route: '/legacy/mcp/', sessionId: legacySession })
  assert.equal(trailing.status, 200, trailing.text)
  const upper = await rpc('tools/list', undefined, { ...legacy, route: '/LEGACY/MCP', sessionId: legacySession })
  assert.equal(upper.status, 200, upper.text)
  assert.equal(upper.body.result.tools.length, 52)
  assert.equal((await rpc('ping', undefined, { ...legacy, route: '/LEGACY/MCP', sessionId: modernSession })).status, 404)
})

test('compatibility endpoints preserve public and login-required authentication gates', async () => {
  for (const route of ['/account/mcp', '/account/legacy/mcp']) {
    const response = await rpc('initialize', {}, { route, headers: {} })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate'), /Bearer/)
  }
  const instance = await startApp({ MCP_REQUIRE_AUTH: 'true' })
  try {
    const response = await rpc('initialize', {}, { route: '/legacy/mcp', headers: {}, url: instance.url })
    assert.equal(response.status, 401)
  } finally { await stopApp(instance) }
})

test('public mcprush ownership claim is absent by default', async () => {
  const response = await fetch(`${base}/.well-known/mcprush.com-claim.txt`)
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('www-authenticate'), null)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public mcprush ownership claim works without OAuth or configured gateway credentials', async () => {
  const claim = 'mcprush.com-test_public_claim_1234'
  const instance = await startApp({ MCP_REQUIRE_AUTH: 'true', MCPRUSH_TOKEN: '',
    BULLRUN_MCP_GATEWAY_SECRET: '', MCPRUSH_DOMAIN_CLAIM: claim })
  try {
    const before = calls.length
    const response = await fetch(`${instance.url}/.well-known/mcprush.com-claim.txt`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/plain/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('www-authenticate'), null)
    assert.equal(await response.text(), claim)
    assert.equal(calls.length, before, 'ownership verification must not call research APIs')
  } finally { await stopApp(instance) }
})

test('invalid mcprush ownership claims remain unavailable and are not reflected', async () => {
  for (const claim of ['mgw_not_an_ownership_claim', 'mcprush.com-short',
    'mcprush.com-invalid<script>', 'mcprush.com-valid_claim_1234\n', `mcprush.com-${'a'.repeat(129)}`]) {
    const instance = await startApp({ MCP_REQUIRE_AUTH: 'true', MCPRUSH_DOMAIN_CLAIM: claim })
    try {
      const response = await fetch(`${instance.url}/.well-known/mcprush.com-claim.txt`)
      assert.equal(response.status, 404)
      assert.equal(response.headers.get('www-authenticate'), null)
      assert.equal(await response.text(), 'Not found\n')
    } finally { await stopApp(instance) }
  }
})

test('gateway rejects missing and incorrect tokens before protocol discovery', async () => {
  for (const headers of [{}, { 'x-mcprush-token': 'wrong-token', 'x-mcprush-listing': listing }]) {
    const response = await rpc('ping', undefined, { headers })
    assert.equal(response.status, 401)
    assert.match(response.body.error.message, /valid mcprush gateway token/)
  }
})

test('gateway stays disabled when either independent credential is absent or too short', async () => {
  for (const env of [{ MCPRUSH_TOKEN: '' }, { BULLRUN_MCP_GATEWAY_SECRET: '' },
    { BULLRUN_MCP_GATEWAY_SECRET: 'too-short' }]) {
    const disabled = await startApp(env)
    try {
      const response = await rpc('initialize', {}, { url: disabled.url })
      assert.equal(response.status, 503)
      assert.match(response.body.error.message, /not configured/)
    } finally { await stopApp(disabled) }
  }
})

test('gateway validates listing and installation identifiers and refuses batched requests', async () => {
  for (const headers of [
    { ...gatewayHeaders(), 'x-mcprush-listing': 'different-listing' },
    { ...gatewayHeaders(), 'x-mcprush-listing': 'bad/listing' },
    { ...gatewayHeaders(), 'x-mcprush-install': 'bad/installation' },
    { ...gatewayHeaders(), 'x-mcprush-install': 'a'.repeat(129) },
  ]) {
    assert.equal((await rpc('ping', undefined, { headers, sessionId: session })).status, 400)
  }
  const response = await fetch(`${base}/mcprush/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', ...gatewayHeaders(),
  }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /one JSON-RPC request/)
})

test('installation-free verification supports discovery and ping, but cannot execute research', async () => {
  const headers = { 'x-mcprush-token': token, 'x-mcprush-listing': listing }
  const verificationSession = await initialize({ headers })
  for (const method of ['tools/list', 'ping']) {
    const response = await rpc(method, undefined, { headers, sessionId: verificationSession })
    assert.equal(response.status, 200, response.text)
    assert.ok(response.body.result)
  }
  const before = calls.length
  const denied = await callTool('get_macro_history', { code: 'FED' }, { headers, sessionId: verificationSession })
  assert.equal(denied.status, 400)
  assert.match(denied.body.error.message, /installation is required/)
  assert.equal(calls.length, before)
})

test('Studio Verify can use token-only discovery with a pinned listing and a bound MCP session', async () => {
  // Vendor Verify sends neither identity header, then echoes the initialized session.
  const headers = { 'x-mcprush-token': token }
  const before = calls.length
  const verificationSession = await initialize({ headers })
  const tools = await rpc('tools/list', undefined, { headers, sessionId: verificationSession })
  assert.equal(tools.status, 200, tools.text)
  assert.ok(tools.body.result.tools.some(tool => tool.name === 'compare_stocks'))
  assert.ok(tools.body.result.tools.every(tool => tool.annotations?.readOnlyHint === true))
  assert.ok(!tools.body.result.tools.some(tool => tool.name === 'list_portfolios'))
  for (let ping = 0; ping < 5; ping++) {
    const response = await rpc('ping', undefined, { headers, sessionId: verificationSession })
    assert.equal(response.status, 200, response.text)
    assert.deepEqual(response.body.result, {})
  }
  assert.equal((await rpc('tools/list', undefined, { headers })).status, 400,
    'token-only discovery still requires the initialized MCP session')
  for (const options of [
    { headers: gatewayHeaders(), sessionId: verificationSession },
    { headers, sessionId: session },
    { route: '/mcp', headers: {}, sessionId: verificationSession },
  ]) {
    assert.equal((await rpc('ping', undefined, options)).status, 404,
      'verification sessions must remain isolated from installations and public routes')
  }
  const denied = await callTool('get_macro_history', { code: 'FED' }, { headers, sessionId: verificationSession })
  assert.equal(denied.status, 400)
  assert.equal(calls.length, before, 'token-only verification must never call research APIs')
})

test('Studio Verify fallback never repairs supplied malformed or mismatched identity headers', async () => {
  const tokenOnly = { 'x-mcprush-token': token }
  const verificationSession = await initialize({ headers: tokenOnly })
  for (const headers of [
    { ...tokenOnly, 'x-mcprush-listing': '' },
    { ...tokenOnly, 'x-mcprush-listing': 'different-listing' },
    { ...tokenOnly, 'x-mcprush-listing': 'bad/listing' },
    { ...tokenOnly, 'x-mcprush-listing': 'a'.repeat(129) },
    { ...tokenOnly, 'x-mcprush-install': installation },
    { ...tokenOnly, 'x-mcprush-install': '' },
    { ...tokenOnly, 'x-mcprush-install': 'bad/installation' },
  ]) {
    const response = await rpc('ping', undefined, { headers, sessionId: verificationSession })
    assert.equal(response.status, 400, response.text)
    assert.match(response.body.error.message, /Invalid marketplace listing or installation/)
  }
  for (const method of ['tools/call', 'prompts/list', 'resources/list']) {
    const response = await rpc(method, { name: 'get_macro_history', arguments: { code: 'FED' } },
      { headers: tokenOnly, sessionId: verificationSession })
    assert.equal(response.status, 400, `${method} must not receive discovery fallback`)
  }
})

test('token-only discovery requires a valid configured listing and valid gateway token', async () => {
  for (const pinnedListing of ['', 'bad/listing', 'a'.repeat(129)]) {
    const instance = await startApp({ MCPRUSH_LISTING_ID: pinnedListing })
    try {
      const response = await rpc('initialize', { protocolVersion, capabilities: {},
        clientInfo: { name: 'mcprush-verify', version: '1.0.0' } },
      { headers: { 'x-mcprush-token': token }, url: instance.url })
      assert.equal(response.status, 400)
      assert.match(response.body.error.message, /Invalid marketplace listing or installation/)
    } finally { await stopApp(instance) }
  }
  for (const headers of [{}, { 'x-mcprush-token': 'wrong-token' }]) {
    const response = await rpc('initialize', { protocolVersion, capabilities: {},
      clientInfo: { name: 'mcprush-verify', version: '1.0.0' } }, { headers })
    assert.equal(response.status, 401)
  }
})

test('marketplace exposes research tools and refuses account and write tool names', async () => {
  const response = await rpc('tools/list', undefined, { sessionId: session })
  assert.equal(response.status, 200, response.text)
  assert.ok(Buffer.byteLength(response.text) < 256 * 1024, 'research manifest exceeds gateway response cap')
  const names = response.body.result.tools.map(tool => tool.name)
  for (const name of ['compare_stocks', 'screen_stocks', 'get_stock_metrics', 'get_macro_history']) {
    assert.ok(names.includes(name), `${name} should be discoverable`)
  }
  const privateNames = ['list_portfolios', 'get_portfolio_context', 'get_portfolio_analytics',
    'analyze_portfolio_fit', 'get_capabilities', 'create_portfolio_draft', 'create_position_draft',
    'create_portfolio_from_positions']
  assert.deepEqual(names.filter(name => privateNames.includes(name)), [])
  assert.ok(response.body.result.tools.every(tool => tool.annotations?.readOnlyHint === true))
  const before = calls.length
  for (const name of privateNames) {
    const denied = await callTool(name, {})
    assert.ok(denied.body.error || denied.body.result?.isError, `${name} was not refused`)
  }
  assert.equal(calls.length, before, 'hidden tools must not reach account APIs')
})

test('new calendar, relationship, history and coverage research tools keep signed installation-scoped backend access', async () => {
  const before = calls.length
  const list = await rpc('tools/list', undefined, { sessionId: session })
  for (const [name, args] of [
    ['get_corporate_calendar', {include:['earnings']}],
    ['compare_company_exposures', {tickers:['AAPL','MSFT']}],
    ['get_company_risk_history', {ticker:'AAPL'}],
    ['get_company_data_coverage', {ticker:'AAPL'}],
  ]) {
    assert.ok(list.body.result.tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint))
    const response = await callTool(name, args)
    assert.equal(response.status, 200, response.text)
    assert.equal(response.body.result.isError, undefined, response.text)
  }
  const upstream = researchCallsSince(before)
  assert.equal(upstream.length, 5)
  upstream.forEach(call => assertSigned(call))
})

test('sessions cannot cross installations, verification probes, or public routes', async () => {
  const otherHeaders = gatewayHeaders('buyer-installation-b')
  const otherSession = await initialize({ headers: otherHeaders })
  const verificationHeaders = { 'x-mcprush-token': token, 'x-mcprush-listing': listing }
  const publicSession = await initialize({ route: '/mcp', headers: {} })
  for (const options of [
    { headers: otherHeaders, sessionId: session },
    { headers: gatewayHeaders(), sessionId: otherSession },
    { headers: verificationHeaders, sessionId: session },
    { route: '/mcp', headers: {}, sessionId: session },
    { sessionId: publicSession },
  ]) {
    const response = await rpc('ping', undefined, options)
    assert.equal(response.status, 404, response.text)
  }
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${base}/mcp`, { method, headers: {
      accept: 'application/json, text/event-stream', 'mcp-session-id': session,
    } })
    assert.equal(response.status, 404)
  }
  const result = await callTool('get_macro_history', { code: 'OTHER-BUYER' },
    { headers: otherHeaders, sessionId: otherSession })
  assert.equal(result.status, 200, result.text)
  assertSigned(calls.find(call => call.url.includes('code=OTHER-BUYER')), 'buyer-installation-b')
})

test('research requests sign the exact encoded path/query and ignore inbound buyer credentials', async () => {
  const before = calls.length
  const response = await callTool('get_macro_history', { code: 'CPI:United States & Europe/CHF' },
    { headers: { ...gatewayHeaders(), authorization: 'Bearer buyer-token-not-bullrun-oauth',
      'x-env-authorization': 'Bearer should-not-be-forwarded', 'x-env-api-key': 'not-a-bullrun-key',
      'x-bullrun-mcp-gateway-signature': 'spoofed' } })
  assert.equal(response.status, 200, response.text)
  assert.equal(response.body.result.isError, undefined, response.text)
  const upstream = researchCallsSince(before)
  assert.equal(upstream.length, 1)
  assert.match(upstream[0].url, /code=CPI%3AUnited\+States\+%26\+Europe%2FCHF/)
  assertSigned(upstream[0])
  assert.equal(upstream[0].headers.authorization, undefined)
  assert.equal(upstream[0].headers['x-env-authorization'], undefined)
  assert.equal(upstream[0].headers['x-env-api-key'], undefined)
  assert.equal(upstream[0].headers['x-mcprush-token'], undefined)
  assert.equal(upstream[0].headers['x-bullrun-client'], 'mcp')
  assert.equal(upstream[0].headers['x-bullrun-mcp-tool'], 'get_macro_history')
  assert.equal(upstream[0].headers['x-bullrun-mcp-session'], session)
  const analytics = calls.slice(before).find(call => call.url === '/api/analytics/mcp-tools')
  assert.ok(analytics)
  assert.equal(analytics.headers['x-bullrun-mcp-gateway-signature'], undefined,
    'analytics POST must never receive research quota-bypass credentials')
})

test('public MCP requests cannot acquire signed access by spoofing marketplace headers', async () => {
  const spoofed = { ...gatewayHeaders(), 'x-bullrun-mcp-gateway-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-bullrun-mcp-gateway-listing': listing, 'x-bullrun-mcp-gateway-installation': installation,
    'x-bullrun-mcp-gateway-signature': 'attacker-controlled-signature' }
  const publicSession = await initialize({ route: '/mcp', headers: spoofed })
  const before = calls.length
  const response = await callTool('get_macro_history', { code: 'PUBLIC' },
    { route: '/mcp', headers: spoofed, sessionId: publicSession })
  assert.equal(response.status, 200, response.text)
  const upstream = researchCallsSince(before)
  assert.equal(upstream.length, 1)
  assert.ok(Object.keys(upstream[0].headers).every(name => !name.startsWith('x-bullrun-mcp-gateway-')))
  assert.equal(upstream[0].headers['x-mcprush-token'], undefined)
})

test('public reads from a directory probe are tagged for the probe pool; other clients are not', async () => {
  const probeSession = await initialize({ route: '/mcp', headers: {}, clientName: 'agentstatus-probe' })
  // Only clientInfo decides the class: an inbound copy of the header is never forwarded.
  const userHeaders = { 'x-bullrun-mcp-client-class': 'probe' }
  const userSession = await initialize({ route: '/mcp', headers: userHeaders, clientName: 'claude-ai' })
  const before = calls.length
  for (const [sessionId, headers] of [[probeSession, {}], [userSession, userHeaders]]) {
    const response = await callTool('get_macro_history', { code: 'CLASS' }, { route: '/mcp', headers, sessionId })
    assert.equal(response.status, 200, response.text)
  }
  const [probe, user] = researchCallsSince(before)
  assert.equal(probe.headers['x-bullrun-client'], 'mcp')
  assert.equal(probe.headers['x-bullrun-mcp-client-class'], 'probe')
  assert.equal(user.headers['x-bullrun-mcp-client-class'], undefined)
})

test('read-only stock screener POST receives a signature over its actual method and query', async () => {
  const before = calls.length
  const response = await callTool('screen_stocks', { country: 'United States', limit: 2 })
  assert.equal(response.status, 200, response.text)
  assert.equal(response.body.result.isError, undefined, response.text)
  const upstream = researchCallsSince(before)
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].method, 'POST')
  assert.equal(upstream[0].url.split('?')[0], '/api/screener/filter')
  assert.equal(upstream[0].body.country, 'United States')
  assertSigned(upstream[0])
})

test('read-only ETF screener POST also receives installation metering credentials', async () => {
  const before = calls.length
  const response = await callTool('screen_etfs', { domicile: 'Ireland', limit: 2 })
  assert.equal(response.status, 200, response.text)
  assert.equal(response.body.result.isError, undefined, response.text)
  const upstream = researchCallsSince(before)
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].method, 'POST')
  assert.equal(upstream[0].url.split('?')[0], '/api/etfs/screener')
  assert.equal(upstream[0].body.domicile, 'Ireland')
  assertSigned(upstream[0])
})

test('oversized research output returns a compact MCP tool error', async () => {
  const response = await callTool('get_macro_history', { code: 'HUGE' })
  assert.equal(response.status, 200)
  assert.equal(response.body.result.isError, true)
  assert.match(response.body.result.content[0].text, /response limit/)
  assert.ok(Buffer.byteLength(response.text) < 1024)
})

test('an upstream timeout returns a normal MCP error without hanging the marketplace call', async () => {
  const started = Date.now()
  const response = await callTool('get_macro_history', { code: 'SLOW' })
  assert.equal(response.status, 200)
  assert.equal(response.body.result.isError, true)
  assert.match(response.body.result.content[0].text, /Failed to reach bullrun-api/)
  assert.ok(Date.now() - started < 3_000)
})
