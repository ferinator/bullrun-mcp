#!/usr/bin/env node
/**
 * Load test for anonymous MCP metering: N concurrent anonymous sessions, each from its own
 * address (sent as CF-Connecting-IP, the header cloudflared sets on prod), each running the same
 * research flow an agent would: stock lookups, a 5-stock compare, screens, ETF snapshot,
 * exposures and compare, and the market overview. Calls inside a session run one after another;
 * the sessions run at the same time.
 *
 * Reports per-tool latency and errors from the client side and, with --db, the per-tool backend
 * reads the MCP server logged in the mcp_tool_call analytics rows plus the api_call_log rows
 * per caller address. With --stats it samples `docker stats` for the api, mcp and db containers.
 *
 * Local docker stack only: it sends a forged CF-Connecting-IP straight to the MCP port, which
 * prod's port binding (127.0.0.1) and Cloudflare make impossible from outside.
 *
 *   node scripts/load-anon-sessions.mjs --sessions 30 --db bullrun-db --stats --out run.json
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const run = promisify(execFile)
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]])
  return pairs
}, []))
const url = args.url ?? 'http://127.0.0.1:8091/mcp'
const sessions = Number(args.sessions ?? 30)
const ipBase = args['ip-base'] ?? '203.0.113.'
const dbContainer = args.db
const sampleStats = args.stats === 'true'

const STOCK_SETS = [
  ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN'],
  ['ASML', 'SAP', 'NESN', 'NOVN', 'MC'],
  ['JPM', 'KO', 'PEP', 'META', 'TSLA'],
  ['SIE', 'ALV', 'ULVR', 'SHEL', 'AZN'],
]
const ETF_SETS = [
  ['CSPX.L', 'VUAA.L', 'SXR8.DE'],
  ['IWDA.L', 'SWDA.L', 'EUNL.DE'],
  ['VWCE.DE', 'VWRL.L', 'VTI'],
  ['SPY', 'VOO', 'QQQ'],
]
const SECTORS = ['Technology', 'Healthcare', 'Financial Services', 'Industrials', 'Consumer Defensive']
const ETF_SEARCHES = ['S&P 500', 'MSCI World', 'Nasdaq', 'Emerging']

/** One agent-like research session: the order an assistant would plausibly call these in. */
function flow(i) {
  const s = STOCK_SETS[i % STOCK_SETS.length]
  const e = ETF_SETS[i % ETF_SETS.length]
  return [
    ['search_stocks', { query: s[0], limit: 5 }],
    ['get_stock_metrics', { ticker: s[0] }],
    ['compare_stocks', { tickers: s }],
    ['get_financial_history', { ticker: s[1] }],
    ['get_quality_moat_metrics', { ticker: s[2] }],
    ['screen_stocks', { sector: SECTORS[i % SECTORS.length], limit: 10 }],
    ['find_stock_peers', { ticker: s[0] }],
    ['get_company_risk', { ticker: s[0] }],
    ['get_stock_price_history', { ticker: s[3] }],
    ['search_etfs', { search: ETF_SEARCHES[i % ETF_SEARCHES.length], limit: 5 }],
    ['get_etf_snapshot', { ticker: e[0] }],
    ['screen_etfs', { search: ETF_SEARCHES[i % ETF_SEARCHES.length], limit: 10 }],
    ['get_etf_exposures', { ticker: e[1] }],
    ['compare_etfs', { tickers: e }],
    ['get_global_markets_overview', {}],
  ]
}

async function session(i, calls) {
  const ip = `${ipBase}${10 + i}`
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'CF-Connecting-IP': ip } },
  })
  const client = new Client({ name: 'bullrun-load-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    for (const [tool, toolArgs] of flow(i)) {
      const started = performance.now()
      let isError = false
      let text = ''
      try {
        const result = await client.callTool({ name: tool, arguments: toolArgs }, undefined, { timeout: 120_000 })
        isError = result.isError === true
        text = result.content?.find(c => c.type === 'text')?.text ?? ''
      } catch (err) {
        isError = true
        text = err instanceof Error ? err.message : String(err)
      }
      calls.push({ session: i, ip, tool, ms: Math.round(performance.now() - started), isError,
        quota: /HTTP 429|quota|rate limit/i.test(text), note: isError ? text.slice(0, 160) : undefined })
    }
  } finally {
    await transport.terminateSession().catch(() => {})
    await client.close().catch(() => {})
  }
}

async function dockerStats(samples, stop) {
  while (!stop.done) {
    try {
      const { stdout } = await run('docker', ['stats', '--no-stream', '--format',
        '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', 'bullrun-api', 'bullrun-mcp', 'bullrun-db'])
      const at = Date.now()
      for (const line of stdout.trim().split('\n')) {
        const [name, cpu, mem] = line.split('|')
        samples.push({ at, name, cpu: parseFloat(cpu), memMiB: toMiB(mem.split('/')[0].trim()) })
      }
    } catch { /* a missed sample is fine */ }
  }
}

function toMiB(value) {
  const n = parseFloat(value)
  if (/GiB/.test(value)) return n * 1024
  if (/KiB/.test(value)) return n / 1024
  return n
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

async function psql(sql) {
  const { stdout } = await run('docker', ['exec', dbContainer, 'psql', '-U', 'app', '-d', 'bullrun', '-t', '-A', '-F', '|', '-c', sql])
  return stdout.trim().split('\n').filter(Boolean).map(line => line.split('|'))
}

const calls = []
const samples = []
const stop = { done: false }
const startIso = new Date().toISOString()
const statsLoop = sampleStats ? dockerStats(samples, stop) : Promise.resolve()
const started = performance.now()
const outcomes = await Promise.allSettled(Array.from({ length: sessions }, (_, i) => session(i, calls)))
const wallMs = Math.round(performance.now() - started)
stop.done = true
await statsLoop

const failedSessions = outcomes.filter(o => o.status === 'rejected').map(o => String(o.reason).slice(0, 200))
const byTool = {}
for (const call of calls) (byTool[call.tool] ??= []).push(call)
const toolRows = Object.entries(byTool).map(([tool, rows]) => {
  const ms = rows.map(r => r.ms).sort((a, b) => a - b)
  return { tool, calls: rows.length, errors: rows.filter(r => r.isError).length, quotaErrors: rows.filter(r => r.quota).length,
    p50ms: pct(ms, 0.5), p95ms: pct(ms, 0.95), maxMs: ms[ms.length - 1] }
})

const report = { url, sessions, wallMs, totalCalls: calls.length, failedSessions, tools: toolRows,
  errors: calls.filter(c => c.isError).slice(0, 20) }

if (sampleStats) {
  const byName = {}
  for (const s of samples) (byName[s.name] ??= []).push(s)
  report.dockerStats = Object.fromEntries(Object.entries(byName).map(([name, rows]) => {
    const cpu = rows.map(r => r.cpu).sort((a, b) => a - b)
    return [name, { samples: rows.length, cpuAvgPct: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1),
      cpuP95Pct: pct(cpu, 0.95), cpuMaxPct: cpu[cpu.length - 1], memMaxMiB: Math.round(Math.max(...rows.map(r => r.memMiB))) }]
  }))
}

if (dbContainer) {
  // Give the best-effort analytics POSTs a moment to land.
  await new Promise(resolve => setTimeout(resolve, 2000))
  report.readsPerTool = (await psql(`
    SELECT details->>'tool', count(*),
           round(avg((details->>'apiCalls')::int), 1), max((details->>'apiCalls')::int),
           round(avg((details->>'meteredReads')::int), 1), max((details->>'meteredReads')::int),
           round(avg((details->>'durationMs')::int))
    FROM analytics_event
    WHERE event_type = 'mcp_tool_call' AND occurred_at >= '${startIso}'
      AND details->>'clientName' = 'bullrun-load-test'
    GROUP BY 1 ORDER BY 6 DESC NULLS LAST, 1`)).map(([tool, n, avgApi, maxApi, avgMetered, maxMetered, avgMs]) =>
    ({ tool, calls: +n, avgApiCalls: +avgApi, maxApiCalls: +maxApi, avgMeteredReads: +avgMetered,
      maxMeteredReads: +maxMetered, avgDurationMs: +avgMs }))
  report.callLogByCaller = (await psql(`
    SELECT ip_address, category, count(*) FROM api_call_log
    WHERE called_at >= '${startIso}' AND category IN ('mcp_market', 'mcp_probe')
    GROUP BY 1, 2 ORDER BY 3 DESC`)).map(([ip, category, n]) => ({ ip, category, rows: +n }))
}

if (args.out) writeFileSync(args.out, JSON.stringify({ report, calls, samples }, null, 2))
console.log(JSON.stringify(report, null, 2))
