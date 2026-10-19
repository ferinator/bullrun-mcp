import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('./check-mcprush.mjs', import.meta.url))
const token = 'fixture-gateway-token-do-not-print'
const privateDetail = 'http://private-api.internal:8080 Authorization: fixture-secret'
const protocol = '2025-06-18'
const names = ['compare_stocks', 'screen_stocks', 'get_stock_metrics', 'screen_etfs',
  'get_macro_history', 'get_company_risk', 'get_valuation_model']

function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function comparison() {
  return { structuredContent: {
    rows: ['AAPL', 'MSFT'].map(ticker => ({ ticker, identity: { ticker },
      fundamentals: { annual: { revenue: 200, basis: { fiscalYear: 2025, reportingCurrency: 'USD' } } },
      quality: { operatingMarginPct: 20 } })),
    coverage: ['AAPL', 'MSFT'].map(ticker => ({ ticker, identityAvailable: true,
      annualRows: 2, endpoints: { financials: 'ok' } })),
  }, content: [] }
}

async function fixture(mode, run) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ method: req.method, headers: req.headers, body })
    if (mode === 'timeout') return
    if (mode === 'disabled') return json(res, { error: `${privateDetail} ${token}` }, 503)
    if (mode === 'missing-route') return json(res, { error: `${privateDetail} ${token}` }, 404)
    if (req.headers['x-mcprush-token'] !== token || mode === 'wrong-token') {
      return json(res, { error: `${privateDetail} ${token}` }, 401)
    }
    if (mode === 'redirect') return json(res, {}, 307, { location: 'https://private-api.internal:8080/' })
    if (mode === 'bad-listing') return json(res, { error: privateDetail }, 400)
    const reply = result => json(res, { jsonrpc: '2.0', id: body.id, result })
    if (body.method === 'initialize') {
      if (mode === 'rpc-error') return json(res, { jsonrpc: '2.0', id: body.id,
        error: { code: -32603, message: `${privateDetail} ${token}` } })
      return json(res, { jsonrpc: '2.0', id: body.id, result: {
        protocolVersion: mode === 'bad-protocol' ? '2024-11-05' : protocol,
        serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} },
      } }, 200, { 'mcp-session-id': 'fixture-session-secret' })
    }
    if (req.headers['mcp-session-id'] !== 'fixture-session-secret') return json(res, {}, 404)
    if (body.method === 'notifications/initialized') {
      res.writeHead(202)
      return res.end()
    }
    if (body.method === 'tools/list') {
      let tools = names.map(name => ({ name, annotations: { readOnlyHint: true } }))
      if (mode === 'private-tool') tools.push({ name: 'get_portfolio_context', annotations: { readOnlyHint: true } })
      if (mode === 'write-tool') tools.push({ name: 'create_order', annotations: { readOnlyHint: true } })
      if (mode === 'not-read-only') tools[0].annotations.readOnlyHint = false
      if (mode === 'missing-tool') tools = tools.slice(1)
      if (mode === 'oversize') return reply({ tools, sensitive: `${token} ${privateDetail} ${'x'.repeat(270 * 1024)}` })
      return reply({ tools, ...(mode === 'paginated' ? { nextCursor: 'next-page' } : {}) })
    }
    if (body.method === 'ping') return reply({})
    if (body.method === 'tools/call') {
      const result = comparison()
      if (mode === 'tool-error') result.isError = true
      if (mode === 'partial-data') result.structuredContent.rows[0].quality = null
      if (mode === 'no-quality-metrics') result.structuredContent.rows[0].quality = {}
      if (mode === 'unknown-currency') result.structuredContent.rows[0].fundamentals.annual.basis.reportingCurrency = null
      return reply(result)
    }
    return json(res, { error: privateDetail }, 400)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}/mcprush/mcp`
  try { await run({ endpoint, calls }) }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function check(endpoint, args = [], env = {}) {
  const child = spawn(process.execPath, [cli, ...(endpoint ? [endpoint] : []), ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCPRUSH_TOKEN: token, MCPRUSH_LISTING_ID: 'fixture-listing',
      MCPRUSH_INSTALL_ID: '', ...env },
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = setTimeout(() => child.kill(), 8_000)
  try {
    const [code] = await once(child, 'exit')
    assert.ok(!output.includes(token), 'output must not disclose the gateway token')
    assert.ok(!output.includes(privateDetail), 'output must not disclose raw server errors')
    assert.ok(!output.includes('127.0.0.1:'), 'output must not disclose internal endpoint addresses')
    assert.ok(!output.includes('private-api.internal'), 'output must not disclose internal backend addresses')
    assert.ok(!output.includes('fixture-session-secret'), 'output must not disclose session identifiers')
    return { code, output }
  } finally { clearTimeout(deadline) }
}

test('discovery uses POST, verifies both rejected tokens and preserves the negotiated session without tools/call', async () => {
  await fixture('normal', async ({ endpoint, calls }) => {
    const result = await check(endpoint)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /READY for Studio verification/)
    assert.match(result.output, /zero tools\/call/)
    assert.equal(calls.length, 6)
    assert.ok(calls.every(call => call.method === 'POST'))
    assert.equal(calls[0].headers['x-mcprush-token'], undefined)
    assert.notEqual(calls[1].headers['x-mcprush-token'], token)
    assert.equal(calls[2].body.params.protocolVersion, protocol)
    assert.ok(calls.slice(3).every(call => call.headers['mcp-session-id'] === 'fixture-session-secret'))
    assert.ok(calls.every(call => call.body.method !== 'tools/call'))
    assert.ok(calls.every(call => !call.headers.authorization))
  })
})

test('research must be explicitly requested and makes one compact, bounded comparison', async () => {
  await fixture('normal', async ({ endpoint, calls }) => {
    const result = await check(endpoint, ['--research'], { MCPRUSH_INSTALL_ID: 'fixture-installation' })
    assert.equal(result.code, 0, result.output)
    const research = calls.filter(call => call.body.method === 'tools/call')
    assert.equal(research.length, 1)
    assert.deepEqual(research[0].body.params, { name: 'compare_stocks',
      arguments: { tickers: ['AAPL', 'MSFT'], include: ['fundamentals', 'quality'] } })
    assert.equal(research[0].headers['x-mcprush-install'], 'fixture-installation')
    assert.match(result.output, /at most 6 backend reads/)
    assert.match(result.output, /confirm mcprush_market metering/)
  })
})

test('supplying an installation alone cannot accidentally run research', async () => {
  await fixture('normal', async ({ endpoint, calls }) => {
    const result = await check(endpoint, [], { MCPRUSH_INSTALL_ID: 'fixture-installation' })
    assert.equal(result.code, 0, result.output)
    assert.ok(calls.every(call => call.body.method !== 'tools/call'))
  })
})

test('research without an installation is rejected before any HTTP requests', async () => {
  await fixture('normal', async ({ endpoint, calls }) => {
    const result = await check(endpoint, ['--research'])
    assert.equal(result.code, 2)
    assert.match(result.output, /requires MCPRUSH_TOKEN/)
    assert.equal(calls.length, 0)
  })
})

test('missing token verifies rejection but exits nonzero with the remaining setup step', async () => {
  await fixture('normal', async ({ endpoint, calls }) => {
    const result = await check(endpoint, [], { MCPRUSH_TOKEN: '' })
    assert.equal(result.code, 2)
    assert.match(result.output, /set MCPRUSH_TOKEN/)
    assert.equal(calls.length, 2)
  })
})

for (const [mode, status] of [['disabled', 503], ['missing-route', 404]]) {
  test(`${status} is reported as not live without echoing the response body`, async () => {
    await fixture(mode, async ({ endpoint }) => {
      const result = await check(endpoint)
      assert.equal(result.code, 1)
      assert.match(result.output, new RegExp(`NOT LIVE:.*${status}`))
    })
  })
}

for (const [mode, message] of [['wrong-token', /rejected MCPRUSH_TOKEN/], ['bad-listing', /exact Studio ID/],
  ['redirect', /credentials were not forwarded/], ['rpc-error', /invalid or unsuccessful MCP/],
  ['bad-protocol', /expected MCP protocol/]]) {
  test(`authenticated ${mode} failure remains concise and redacted`, async () => {
    await fixture(mode, async ({ endpoint }) => {
      const result = await check(endpoint)
      assert.equal(result.code, 1)
      assert.match(result.output, message)
    })
  })
}

for (const mode of ['private-tool', 'write-tool', 'not-read-only', 'missing-tool', 'paginated']) {
  test(`catalog ${mode} cannot be reported ready`, async () => {
    await fixture(mode, async ({ endpoint, calls }) => {
      const result = await check(endpoint)
      assert.equal(result.code, 1)
      assert.match(result.output, /catalog is incomplete or exposes account\/write tools/)
      assert.ok(calls.every(call => call.body.method !== 'tools/call'))
    })
  })
}

test('oversize discovery responses are rejected without copying their contents', async () => {
  await fixture('oversize', async ({ endpoint }) => {
    const result = await check(endpoint)
    assert.equal(result.code, 1)
    assert.match(result.output, /256 KiB marketplace limit/)
    assert.ok(result.output.length < 1000)
  })
})

for (const mode of ['tool-error', 'partial-data', 'no-quality-metrics', 'unknown-currency']) {
  test(`research ${mode} requires repair before readiness`, async () => {
    await fixture(mode, async ({ endpoint }) => {
      const result = await check(endpoint, ['--research'], { MCPRUSH_INSTALL_ID: 'fixture-installation' })
      assert.equal(result.code, 1)
      assert.match(result.output, /lacks usable annual fundamentals\/quality/)
    })
  })
}

test('per-request timeout is enforced and reported without the fetch exception', async () => {
  await fixture('timeout', async ({ endpoint }) => {
    const started = Date.now()
    const result = await check(endpoint, ['--timeout-ms', '100'])
    assert.equal(result.code, 1)
    assert.match(result.output, /request timed out/)
    assert.ok(Date.now() - started < 3000)
  })
})

test('invalid flags, unsafe endpoints, IDs and timeout values are rejected before connecting', async () => {
  const cases = [
    ['https://example.com/mcprush/mcp', ['--token', token]],
    [`https://user:${token}@example.com/mcprush/mcp`, []],
    [`https://example.com/mcprush/mcp?token=${token}`, []],
    ['http://example.com/mcprush/mcp', []],
    ['https://example.com/mcp', []],
    ['https://example.com/mcprush/mcp', ['--timeout-ms', '40001']],
    ['https://example.com/mcprush/mcp', ['--timeout-ms', '-1']],
    ['https://example.com/mcprush/mcp', ['--timeout-ms', 'NaN']],
  ]
  for (const [endpoint, args] of cases) {
    const result = await check(endpoint, args)
    assert.equal(result.code, 2)
    assert.match(result.output, /CONFIG:/)
  }
  const id = await check('https://example.com/mcprush/mcp', [], { MCPRUSH_LISTING_ID: 'bad/listing' })
  assert.equal(id.code, 2)
})

test('help documents the production endpoint, environment-only token and opt-in call budget', async () => {
  const result = await check(undefined, ['--help'])
  assert.equal(result.code, 0)
  assert.match(result.output, /https:\/\/mcp\.bull-run\.org\/mcprush\/mcp/)
  assert.match(result.output, /MCPRUSH_TOKEN/)
  assert.match(result.output, /--research/)
  assert.match(result.output, /zero tools\/call/)
})
