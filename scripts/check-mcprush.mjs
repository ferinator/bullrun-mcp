#!/usr/bin/env node
import { randomBytes } from 'node:crypto'

const DEFAULT_ENDPOINT = 'https://mcp.bull-run.org/mcprush/mcp'
const PROTOCOL = '2025-06-18'
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUIRED_TOOLS = ['compare_stocks', 'screen_stocks', 'get_stock_metrics',
  'screen_etfs', 'get_macro_history', 'get_company_risk', 'get_valuation_model']
const PRIVATE_OR_WRITE = /portfolio|capabilities|account|watchlist|notification|draft|(?:^|_)(?:user|users|alert|alerts)(?:_|$)|^(?:create|update|delete|remove|set|add|send|write)_/i

const HELP = `Usage: node scripts/check-mcprush.mjs [endpoint] [--research] [--timeout-ms 40000]

Default endpoint: ${DEFAULT_ENDPOINT}
Secrets are accepted only through environment variables; never put them in arguments.
  MCPRUSH_TOKEN          Publisher origin token, required for authenticated checks
  MCPRUSH_LISTING_ID     Exact Studio listing ID (default: bullrun)
  MCPRUSH_INSTALL_ID     Real free-tier installation ID, required with --research

This checker calls the publisher origin directly, bypassing the MCPRush buyer gateway.
The default check verifies origin token rejection, initialize, tools/list and ping.
It makes zero tools/call requests. --research explicitly adds one AAPL/MSFT
comparison with fundamentals and quality (at most 6 backend reads) to test origin
execution and backend installation safety metering only. Neither mode verifies
marketplace monthly/per-minute allowances or consumes a gateway allowance.
Each request times out within 40 seconds.
Only HTTPS and local loopback HTTP endpoints are accepted. Redirects are refused.
`

class CheckFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function parseOptions(args) {
  let endpoint
  let research = false
  let timeoutMs = 40_000
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--research' && !research) research = true
    else if (arg === '--timeout-ms') {
      const value = args[++i]
      if (!/^\d+$/.test(value ?? '') || Number(value) < 100 || Number(value) > 40_000) {
        throw new CheckFailure('CONFIG: --timeout-ms must be an integer from 100 to 40000.', 2)
      }
      timeoutMs = Number(value)
    } else if (!arg.startsWith('-') && endpoint === undefined) endpoint = arg
    else throw new CheckFailure('CONFIG: invalid arguments. Use --help; tokens belong only in MCPRUSH_TOKEN.', 2)
  }
  let url
  try { url = new URL(endpoint ?? DEFAULT_ENDPOINT) }
  catch { throw new CheckFailure('CONFIG: endpoint must be a complete HTTPS URL.', 2) }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/mcprush/mcp')) {
    throw new CheckFailure('CONFIG: use an HTTPS endpoint ending in /mcprush/mcp without credentials, query or fragment; HTTP is allowed only on loopback.', 2)
  }
  return { endpoint: url, research, timeoutMs }
}

function validateEnv(options) {
  const token = process.env.MCPRUSH_TOKEN ?? ''
  const listing = process.env.MCPRUSH_LISTING_ID || 'bullrun'
  const install = process.env.MCPRUSH_INSTALL_ID || undefined
  if (token.length > 8192 || /[\r\n\x00]/.test(token)) {
    throw new CheckFailure('CONFIG: MCPRUSH_TOKEN is not a valid HTTP header value.', 2)
  }
  for (const id of [listing, install]) {
    if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new CheckFailure('CONFIG: listing and installation IDs must contain 1-128 letters, numbers, underscores or hyphens.', 2)
    }
  }
  if (options.research && (!token || !install)) {
    throw new CheckFailure('CONFIG: --research requires MCPRUSH_TOKEN and a real free-tier MCPRUSH_INSTALL_ID in the environment.', 2)
  }
  return { token, listing, install }
}

async function readBounded(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new CheckFailure('FAIL: response exceeds the 256 KiB marketplace limit. Inspect server response limits locally.')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

async function run(options, env) {
  let id = 0
  let session
  async function rpc(method, params, { token = env.token, notification = false, useSession = true } = {}) {
    const requestId = notification ? undefined : ++id
    let response
    let raw
    try {
      response = await fetch(options.endpoint, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL, 'x-mcprush-listing': env.listing,
          ...(token ? { 'x-mcprush-token': token } : {}),
          ...(env.install ? { 'x-mcprush-install': env.install } : {}),
          ...(useSession && session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method,
          ...(params === undefined ? {} : { params }) }),
      })
      // Failure bodies may contain credentials or private backend addresses. Never print them.
      if (!response.ok) {
        await response.body?.cancel()
        return { status: response.status, headers: response.headers }
      }
      raw = await readBounded(response)
    } catch (error) {
      if (error instanceof CheckFailure) throw error
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new CheckFailure('FAIL: request timed out. Check deployment and upstream health, then retry.')
      }
      throw new CheckFailure('FAIL: endpoint could not be reached securely. Check DNS, TLS, connectivity and deployment logs locally.')
    }
    let body
    if (raw) {
      try { body = JSON.parse(raw) }
      catch { throw new CheckFailure('FAIL: expected a bounded JSON response. Check the endpoint and proxy configuration.') }
    }
    if (!notification && (body?.jsonrpc !== '2.0' || body?.id !== requestId || !body.result || body.error)) {
      throw new CheckFailure('FAIL: server returned an invalid or unsuccessful MCP response. Inspect server logs locally.')
    }
    return { status: response.status, headers: response.headers, body }
  }

  function requireStatus(response, expected, action) {
    if (response.status === expected) return
    if (response.status === 503) {
      throw new CheckFailure('NOT LIVE: gateway is disabled or unavailable (503). Configure both gateway credentials, deploy API and MCP together, then rerun.')
    }
    if (response.status === 404) {
      throw new CheckFailure('NOT LIVE: marketplace route is missing (404). Deploy the /mcprush/mcp route and check proxy routing, then rerun.')
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CheckFailure('FAIL: endpoint redirects. Use the final HTTPS marketplace endpoint; credentials were not forwarded.')
    }
    if (response.status === 401 && action === 'initialize') {
      throw new CheckFailure('FAIL: gateway rejected MCPRUSH_TOKEN (401). Load the current Studio token into the environment and retry.')
    }
    if (response.status === 400 && action === 'initialize') {
      throw new CheckFailure('FAIL: initialization rejected (400). Set MCPRUSH_LISTING_ID to the exact Studio ID and check MCPRUSH_INSTALL_ID if supplied.')
    }
    throw new CheckFailure(`FAIL: ${action} returned HTTP ${response.status}; expected ${expected}. Check deployment and configuration locally.`)
  }

  const noToken = await rpc('ping', undefined, { token: '', useSession: false })
  requireStatus(noToken, 401, 'missing-token check')
  console.log('PASS missing gateway token is rejected (401).')
  const wrongToken = await rpc('ping', undefined, { token: `invalid-check-${randomBytes(24).toString('hex')}`, useSession: false })
  requireStatus(wrongToken, 401, 'incorrect-token check')
  console.log('PASS incorrect gateway token is rejected (401).')
  if (!env.token) {
    throw new CheckFailure('CONFIG: token rejection passed; set MCPRUSH_TOKEN in the environment to verify initialization and discovery.', 2)
  }

  const initialized = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {},
    clientInfo: { name: 'bullrun-mcprush-readiness-check', version: '1.0.0' } }, { useSession: false })
  requireStatus(initialized, 200, 'initialize')
  session = initialized.headers.get('mcp-session-id')
  if (!session || session.length > 256 || /[\r\n\x00]/.test(session) ||
      initialized.body.result.protocolVersion !== PROTOCOL || !initialized.body.result.serverInfo) {
    throw new CheckFailure('FAIL: initialization is missing a valid session or the expected MCP protocol version.')
  }
  const acknowledged = await rpc('notifications/initialized', undefined, { notification: true })
  requireStatus(acknowledged, 202, 'initialized notification')
  console.log(`PASS initialize and session negotiation (${PROTOCOL}).`)

  const discovery = await rpc('tools/list')
  requireStatus(discovery, 200, 'tools/list')
  const tools = discovery.body.result.tools
  if (!Array.isArray(tools) || tools.length === 0 || discovery.body.result.nextCursor ||
      REQUIRED_TOOLS.some(name => !tools.some(tool => tool?.name === name)) ||
      tools.some(tool => typeof tool?.name !== 'string' || PRIVATE_OR_WRITE.test(tool.name) || tool.annotations?.readOnlyHint !== true)) {
    throw new CheckFailure('FAIL: tool catalog is incomplete or exposes account/write tools. Verify the complete research-only catalog before publishing.')
  }
  console.log(`PASS research-only catalog (${tools.length} read-only tools, including compare_stocks).`)
  const ping = await rpc('ping')
  requireStatus(ping, 200, 'ping')
  console.log('PASS authenticated session ping.')

  if (!options.research) {
    console.log('READY for Studio verification of origin discovery. Research execution is untested; zero tools/call requests were sent.')
    console.log('To test origin execution and backend installation safety metering only, set MCPRUSH_INSTALL_ID and rerun with --research (one tool call; at most 6 backend reads).')
    console.log('These origin checks bypass the MCPRush buyer gateway; marketplace monthly/per-minute allowances are neither verified nor consumed.')
    return
  }
  const comparison = await rpc('tools/call', { name: 'compare_stocks',
    arguments: { tickers: ['AAPL', 'MSFT'], include: ['fundamentals', 'quality'] } })
  requireStatus(comparison, 200, 'compare_stocks')
  const result = comparison.body.result
  const payload = result.structuredContent
  const hasNumber = (record, keys) => keys.some(key => Number.isFinite(record?.[key]))
  if (result.isError || !Array.isArray(payload?.rows) || payload.rows.length !== 2 ||
      !Array.isArray(payload.coverage) || payload.coverage.length !== 2 ||
      ['AAPL', 'MSFT'].some(ticker => {
        const row = payload.rows.find(row => row?.ticker === ticker)
        const coverage = payload.coverage.find(row => row?.ticker === ticker)
        return !row?.identity || !row.fundamentals?.annual || !row.quality ||
          !Number.isInteger(row.fundamentals.annual.basis?.fiscalYear) ||
          !row.fundamentals.annual.basis?.reportingCurrency ||
          !hasNumber(row.fundamentals.annual, ['revenue', 'netIncome', 'operatingCashflow', 'freeCashflow']) ||
          !hasNumber(row.quality, ['operatingMarginPct', 'netMarginPct', 'roePct', 'roaPct', 'roicPct', 'operatingCashflowToNetIncome']) ||
          !coverage?.identityAvailable || !(coverage.annualRows > 0) ||
          coverage.endpoints?.financials !== 'ok'
      })) {
    throw new CheckFailure('FAIL: stock comparison lacks usable annual fundamentals/quality for both test stocks. Check API credentials, metering and data coverage before charging.')
  }
  console.log('PASS AAPL/MSFT comparison returned annual fundamentals, quality and coverage.')
  console.log('READY for Studio origin execution review. One tools/call request was sent (at most 6 backend reads); confirm mcprush_market metering in API logs to verify backend installation safety metering.')
  console.log('This origin execution check bypasses the MCPRush buyer gateway; marketplace monthly/per-minute allowances are neither verified nor consumed.')
}

try {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) console.log(HELP)
  else await run(options, validateEnv(options))
} catch (error) {
  // Do not log raw exceptions: fetch/server errors can embed secrets or private URLs.
  console.error(error instanceof CheckFailure ? error.message : 'FAIL: check could not complete. Inspect local configuration; no credentials or server response bodies were printed.')
  process.exitCode = error instanceof CheckFailure ? error.exitCode : 1
}
