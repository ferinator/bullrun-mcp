import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { Client, StreamableHTTPClientTransport, InMemoryTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { createModernMcpServer, standardSchema } from '../dist/sdkV2.js'
import { runWithAuth } from '../dist/auth/context.js'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const issuer = 'https://bull-run.org'
const resource = 'https://mcp.bull-run.org'
const secret = 'protocol-version-test-secret-at-least-32-bytes'
const gatewayToken = 'protocol-test-marketplace-token'
const calls = []
const clients = []
let api, app, base, apiBase, privateKey, jwk
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const payload = result => result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text' && c.text.startsWith('{')).text)

before(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true })
  privateKey = keys.privateKey
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'protocol-test-key', alg: 'RS256', use: 'sig' }
  api = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    const path = new URL(req.url, 'http://stub').pathname
    calls.push({ path, headers: req.headers, body })
    if (path === '/oauth2/jwks') return json(res, { keys: [jwk] })
    if (path.endsWith('/reserve')) return json(res, { allowed: true, operationId: body.operationId,
      principalKey: body.userId ? `user:${body.userId}` : 'ip:test',
      expiresAt: new Date(Date.now() + 300000).toISOString(), maxRequests: 1024 })
    if (path.endsWith('/finish')) return json(res, { settled: true })
    if (path === '/api/analytics/mcp-tools') return json(res, { ok: true })
    if (path === '/api/portfolios/capabilities') {
      const userId = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url')).userId
      await new Promise(resolve => setTimeout(resolve, userId === 42 ? 25 : 5))
      return json(res, { userId, role: 'USER', portfolioCount: 0, maxPortfolios: 10, canCreatePortfolio: true })
    }
    if (path === '/api/stocks/AAPL/data-coverage') return json(res, { ticker: 'AAPL', companyName: 'Apple',
      checkedAt: '2026-10-29T12:00:00Z', datasets: [{ dataset: 'prices', available: true }], graph: null, caveats: [] })
    return json(res, { error: 'Unexpected test endpoint' }, 404)
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  apiBase = `http://127.0.0.1:${api.address().port}`
  const allocation = http.createServer()
  await new Promise(resolve => allocation.listen(0, '127.0.0.1', resolve))
  const port = allocation.address().port
  await new Promise(resolve => allocation.close(resolve))
  base = `http://127.0.0.1:${port}`
  app = spawn(process.execPath, ['dist/index.js'], { cwd, windowsHide: true, env: { ...process.env,
    PORT: String(port), MCP_REQUIRE_AUTH: 'false', BULLRUN_API_BASE: apiBase,
    MCP_PUBLIC_URL: resource, MCP_AUTH_SERVER: issuer, MCP_ISSUER: issuer,
    MCP_JWKS_URI: `${apiBase}/oauth2/jwks`, MCP_ALLOWANCE_ENABLED: 'true',
    BULLRUN_MCP_GATEWAY_SECRET: secret, MCPRUSH_TOKEN: gatewayToken,
    MCPRUSH_INTERNAL_SECRET: secret, MCPRUSH_LISTING_ID: 'protocol-listing' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  app.stdout.on('data', data => { logs += data })
  app.stderr.on('data', data => { logs += data })
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error(`MCP test process exited: ${logs}`)
    try { if ((await fetch(`${base}/health`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`MCP test process did not start: ${logs}`)
})
after(async () => {
  await Promise.allSettled(clients.map(c => c.close()))
  if (app && app.exitCode === null) { const exited = once(app, 'exit'); app.kill(); await exited }
  if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)) }
})

async function token(userId, scopes = 'read:market read:portfolios write:drafts') {
  return new SignJWT({ userId, role: 'USER', scope: scopes }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setSubject(`test-${userId}`).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey)
}
async function connect(path = '/mcp', headers = {}, legacy = false) {
  const client = legacy ? new LegacyClient({ name: 'legacy-protocol-test', version: '1' })
    : new Client({ name: 'modern-protocol-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
  clients.push(client)
  const Transport = legacy ? LegacyHttpTransport : StreamableHTTPClientTransport
  const transport = new Transport(new URL(base + path), { requestInit: { headers } })
  await client.connect(transport)
  return { client, transport }
}

test('one endpoint serves current stateless MCP and existing session clients with the same catalog', async () => {
  const modern = await connect()
  const legacy = await connect('/mcp', {}, true)
  assert.equal(modern.client.getProtocolEra(), 'modern')
  assert.equal(modern.transport.sessionId, undefined)
  assert.ok(legacy.transport.sessionId)
  const a = await modern.client.listTools(), b = await legacy.client.listTools()
  assert.equal(a.tools.length, 48)
  assert.deepEqual(a.tools.map(t => t.name).sort(), b.tools.map(t => t.name).sort())
  assert.doesNotMatch(JSON.stringify(a), /"\$ref"/)
  assert.equal((await modern.client.listPrompts()).prompts.length, 8)
  assert.equal(a.tools.find(t => t.name === 'get_financial_history').inputSchema.properties.years.default, 5)
  const result = await modern.client.callTool({ name: 'screen_stocks', arguments: { action: 'list_presets' } })
  assert.equal(payload(result).action, 'list_presets')
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'bullrun-mcp')
})

test('modern schemas keep defaults, collection bounds and refinements before tool execution', async () => {
  const standard = standardSchema(z.object({ values: z.array(z.number()).max(2).default([1]),
    mode: z.string().default('annual') }).refine(v => v.values.every(n => n > 0), 'Positive values only'))['~standard']
  assert.deepEqual((await standard.validate({})).value, { values: [1], mode: 'annual' })
  assert.ok((await standard.validate({ values: [1, 2, 3] })).issues)
  assert.ok((await standard.validate({ values: [-1] })).issues)
  const { client } = await connect()
  const start = calls.length
  const invalid = await client.callTool({ name: 'get_company_data_coverage', arguments: { ticker: '' } })
  assert.equal(invalid.isError, true)
  assert.equal(calls.slice(start).filter(c => c.path.includes('/reserve')).length, 0)
})

test('modern research and compatibility routes preserve their distinct catalogs', async () => {
  const research = (await connect('/research/mcp')).client
  const tools = (await research.listTools()).tools
  assert.equal(tools.length, 39)
  assert.equal(tools.some(t => /portfolio|shortlist|capabilities/.test(t.name)), false)
  assert.deepEqual((await research.listPrompts()).prompts, [])
  const compatibility = (await connect('/legacy/mcp')).client
  assert.equal((await compatibility.listTools()).tools.length, 52)
})

test('malformed and unsupported modern claims never fall into legacy session handling', async () => {
  for (const meta of [
    { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} },
  ]) {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': meta['io.modelcontextprotocol/protocolVersion'],
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }) })
    const result = await response.json()
    assert.equal(response.status, 400)
    assert.ok([-32020, -32022, -32602].includes(result.error.code))
    assert.doesNotMatch(result.error.message, /no valid session ID/)
    assert.equal(response.headers.get('mcp-session-id'), null)
  }
})

test('legacy native elicitation remains capability gated and never creates a canceled draft', async () => {
  const server = createModernMcpServer()
  const client = new Client({ name: 'elicitation-compatibility-test', version: '1' }, {
    capabilities: { elicitation: { form: {} } },
  })
  let forms = 0
  client.setRequestHandler('elicitation/create', async request => {
    forms++
    assert.match(request.params.message, /scope your new portfolio/)
    return { action: 'decline' }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(b)
    await client.connect(a)
    const result = await runWithAuth({ token: 'test-token', userId: 42, scopes: ['write:drafts'] },
      () => client.callTool({ name: 'create_portfolio_draft', arguments: {} }))
    assert.equal(forms, 1)
    assert.match(result.content[0].text, /canceled/)
  } finally { await client.close(); await server.close() }
})

test('account auth is checked before discovery and concurrent modern requests keep identity and usage isolated', async () => {
  await assert.rejects(connect('/account/mcp'))
  await assert.rejects(connect('/account/mcp', { authorization: 'Bearer invalid' }))
  const token42 = await token(42), token43 = await token(43)
  const a = (await connect('/account/mcp', { authorization: `Bearer ${token42}` })).client
  const b = (await connect('/account/mcp', { authorization: `Bearer ${token43}` })).client
  const anonymous = (await connect()).client
  const start = calls.length
  const [one, two, three] = await Promise.all([a, b, anonymous].map(client => client.callTool({ name: 'get_capabilities', arguments: {} })))
  assert.equal(payload(one).userId, 42)
  assert.equal(payload(two).userId, 43)
  assert.equal(payload(three).authenticated, false)
  const work = calls.slice(start)
  assert.deepEqual(work.filter(c => c.path.endsWith('/reserve')).map(c => c.body.userId).sort(), [42, 43, undefined])
  assert.equal(work.filter(c => c.path.endsWith('/finish') && c.body.success).length, 3)
  const reports = work.filter(c => c.path === '/api/analytics/mcp-tools')
  assert.equal(reports.length, 3)
  assert.ok(reports.every(c => c.body.clientName === 'modern-protocol-test'))
  const failedAt = calls.length
  const denied = await anonymous.callTool({ name: 'list_portfolios', arguments: {} })
  assert.equal(denied.isError, true)
  assert.equal(calls.slice(failedAt).some(c => c.path === '/api/portfolios'), false)
  assert.equal(calls.slice(failedAt).find(c => c.path.endsWith('/finish')).body.success, false)
  const fallbackAt = calls.length
  const fallback = await a.callTool({ name: 'create_portfolio_draft', arguments: {} })
  assert.match(fallback.content[0].text, /No portfolio brief was provided/)
  assert.equal(calls.slice(fallbackAt).some(c => c.path.includes('ai-draft')), false)
})

test('modern marketplace discovery and research preserve gateway credentials and account isolation', async () => {
  const headers = { 'x-mcprush-token': gatewayToken }
  const discovery = (await connect('/mcprush/mcp', headers)).client
  assert.equal((await discovery.listTools()).tools.length, 39)
  await assert.rejects(discovery.callTool({ name: 'get_company_data_coverage', arguments: { ticker: 'AAPL' } }))
  const market = (await connect('/mcprush/mcp', { ...headers, 'x-mcprush-listing': 'protocol-listing',
    'x-mcprush-install': 'protocol-installation', authorization: 'Bearer buyer-credential' })).client
  const start = calls.length
  const result = await market.callTool({ name: 'get_company_data_coverage', arguments: { ticker: 'AAPL' } })
  assert.equal(payload(result).ticker, 'AAPL')
  const work = calls.slice(start)
  assert.equal(work.some(c => c.path.endsWith('/reserve')), false)
  const read = work.find(c => c.path.endsWith('/data-coverage'))
  assert.equal(read.headers.authorization, undefined)
  assert.equal(read.headers['x-bullrun-mcp-gateway-installation'], 'protocol-installation')
  assert.ok(read.headers['x-bullrun-mcp-gateway-signature'])
})

test('stdio entry serves modern pinned and legacy SDK clients from the same shared factory', async () => {
  for (const legacy of [false, true]) {
    const client = legacy ? new LegacyClient({ name: 'legacy-stdio-test', version: '1' })
      : new Client({ name: 'modern-stdio-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url))],
      env: { BULLRUN_API_BASE: apiBase, MCP_ALLOWANCE_ENABLED: 'false' }, stderr: 'pipe' })
    try {
      await client.connect(transport)
      if (!legacy) assert.equal(client.getProtocolEra(), 'modern')
      assert.equal((await client.listTools()).tools.length, 48)
      assert.equal(payload(await client.callTool({ name: 'screen_stocks', arguments: { action: 'list_presets' } })).action, 'list_presets')
    } finally { await client.close() }
  }
})
