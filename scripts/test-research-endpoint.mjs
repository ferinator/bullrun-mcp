import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RESEARCH_EXAMPLES } from './research-examples.mjs'

// The public /research/mcp path is what a no-authentication directory listing points at:
// every tool it lists must work for an anonymous caller.
const cwd = fileURLToPath(new URL('..', import.meta.url))
const protocolVersion = '2025-06-18'
const ACCOUNT_TOOLS = ['list_research_shortlist', 'save_research_shortlist', 'list_portfolios', 'get_portfolio_context',
  'get_portfolio_analytics', 'create_portfolio_draft', 'create_position_draft', 'create_portfolio_from_positions', 'get_capabilities']
let apiServer
let requestId = 0

async function startApi() {
  // Every research read gets a 404, which is enough to separate schema rejections from tool runs.
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(req.url.startsWith('/api/analytics/') ? 200 : 404, { 'content-type': 'application/json' })
    res.end('{}')
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
    env: { ...process.env, PORT: String(port), MCP_REQUIRE_AUTH: 'true', MCPRUSH_TOKEN: '', BULLRUN_MCP_GATEWAY_SECRET: '',
      BULLRUN_API_BASE: `http://127.0.0.1:${apiServer.address().port}`, BULLRUN_API_TIMEOUT_MS: '250', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const url = `http://127.0.0.1:${port}`
  const readyBy = Date.now() + 15000
  while (Date.now() < readyBy) {
    if (child.exitCode !== null) throw new Error(`MCP server exited early: ${output}`)
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(200) })).ok) return { child, url }
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

async function rpc(url, route, method, params, { sessionId, headers = {}, notification = false } = {}) {
  const response = await fetch(`${url}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method,
    ...(params === undefined ? {} : { params }) }), signal: AbortSignal.timeout(5_000) })
  const text = await response.text()
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    : text ? [JSON.parse(text)] : []
  return { status: response.status, headers: response.headers, text, body: messages.at(-1) }
}

async function initialize(url, route) {
  const response = await rpc(url, route, 'initialize', { protocolVersion, capabilities: {},
    clientInfo: { name: 'research-endpoint-test', version: '1.0.0' } })
  assert.equal(response.status, 200, response.text)
  const sessionId = response.headers.get('mcp-session-id')
  assert.ok(sessionId)
  assert.equal((await rpc(url, route, 'notifications/initialized', undefined, { sessionId, notification: true })).status, 202)
  return { sessionId, result: response.body.result }
}

before(async () => { apiServer = await startApi() })
after(async () => {
  apiServer?.closeAllConnections()
  if (apiServer) await new Promise(resolve => apiServer.close(resolve))
})

test('the research path serves exactly the example-covered research catalog without sign-in', async () => {
  // MCP_REQUIRE_AUTH=true closes /mcp, but the research path stays open.
  const app = await startApp()
  try {
    assert.equal((await rpc(app.url, '/mcp', 'initialize', {})).status, 401)
    const { sessionId, result } = await initialize(app.url, '/research/mcp')
    assert.equal(result.capabilities.prompts, undefined, 'no prompts: they reference account tools')
    const list = await rpc(app.url, '/research/mcp', 'tools/list', undefined, { sessionId })
    const tools = list.body.result.tools
    assert.deepEqual(tools.map(tool => tool.name).sort(), RESEARCH_EXAMPLES.map(example => example.tool).sort())
    for (const name of ACCOUNT_TOOLS) assert.equal(tools.some(tool => tool.name === name), false, name)
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has no title`)
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not read-only`)
    }
    const instructions = result.instructions
    assert.match(instructions, /readable without sign-in/)
    assert.match(instructions, /optional platformLink .* to the same view on bull-run\.org/)
    assert.doesNotMatch(instructions, /show that descriptive link|so they can continue|mcprush/i)
    for (const name of ACCOUNT_TOOLS) assert.equal(instructions.includes(name), false, `instructions mention ${name}`)

    const health = await (await fetch(`${app.url}/health`)).json()
    assert.equal(health.auth.researchEndpoint, '/research/mcp')
    const trailing = await rpc(app.url, '/Research/MCP/', 'ping', undefined, { sessionId })
    assert.equal(trailing.status, 200, trailing.text)
  } finally { await stopApp(app) }
})

test('research sessions are isolated from the full catalog and still validate a presented token', async () => {
  const app = await startApp({ MCP_REQUIRE_AUTH: 'false' })
  try {
    const research = (await initialize(app.url, '/research/mcp')).sessionId
    const full = (await initialize(app.url, '/mcp')).sessionId
    assert.equal((await rpc(app.url, '/mcp', 'tools/list', undefined, { sessionId: research })).status, 404)
    assert.equal((await rpc(app.url, '/research/mcp', 'tools/list', undefined, { sessionId: full })).status, 404)
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${app.url}/research/mcp`, { method,
        headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': full } })
      assert.equal(response.status, 404)
    }
    const fullList = await rpc(app.url, '/mcp', 'tools/list', undefined, { sessionId: full })
    assert.equal(fullList.body.result.tools.length, 48)

    const invalid = await rpc(app.url, '/research/mcp', 'initialize', {}, { headers: { authorization: 'Bearer not-a-token' } })
    assert.equal(invalid.status, 401)
    assert.match(invalid.headers.get('www-authenticate'), /invalid_token/)
  } finally { await stopApp(app) }
})

test('every research example matches its tool input schema', async () => {
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${apiServer.address().port}`
  process.env.BULLRUN_API_TIMEOUT_MS = '250'
  const { createMcpServer } = await import('../dist/mcpServer.js')
  const server = createMcpServer({ researchOnly: true })
  const client = new Client({ name: 'research-examples', version: '1.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverSide)
    await client.connect(clientSide)
    for (const example of RESEARCH_EXAMPLES) {
      assert.ok(example.prompt.length > 10, `${example.tool} needs a reviewer prompt`)
      // The stub answers 404, so a tool error is expected here; a schema rejection is not.
      const result = await client.callTool({ name: example.tool, arguments: example.args })
      const text = result.content?.map(block => block.text ?? '').join('\n') ?? ''
      assert.doesNotMatch(text, /Input validation error|-32602|Invalid arguments/, `${example.tool}: ${text.slice(0, 300)}`)
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
})

test('no instructions or results ask Claude to show Bullrun links', async () => {
  const { createMcpServer } = await import('../dist/mcpServer.js')
  const { continuationFor } = await import('../dist/tools/platformLinks.js')
  for (const options of [{}, { researchOnly: true }, { marketplace: true }, { legacyTools: true }]) {
    const server = createMcpServer(options)
    const client = new Client({ name: 'link-wording', version: '1.0.0' })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverSide)
      await client.connect(clientSide)
      const instructions = client.getInstructions()
      assert.match(instructions, /optional platformLink/)
      assert.doesNotMatch(instructions, /show (that|the|a useful)[^.]*link|so they can continue/i)
      for (const tool of (await client.listTools()).tools) {
        assert.doesNotMatch(tool.description, /show (that|the)[^.]*link|platformLink|bull-run\.org/i, tool.name)
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()])
    }
  }
  const stock = continuationFor('get_stock_metrics', { ticker: 'AAPL' }, { identity: { ticker: 'AAPL' } })
  assert.doesNotMatch(stock.description, /^Save|\bto come back\b/)
})
