#!/usr/bin/env node
/** Bounded live contract check for the five v0.7 market-research tools.
 * npm run build
 * BULLRUN_API_BASE=http://localhost:8085 node scripts/check-market-research.mjs --stdio
 * node scripts/check-market-research.mjs --endpoint https://mcp.bull-run.org/mcp
 * Optional secrets: MCP_TOKEN (OAuth), or MCPRUSH_TOKEN/MCPRUSH_INSTALL_ID for a gateway endpoint.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const REQUIRED_TOOLS = ["search_stocks", "screen_stock_presets", "find_stock_peers", "get_stock_price_history", "get_company_news"];
const TIMEOUT_MS = 30_000;
const CLIENT_NAME = "bullrun-market-research-inspection-probe";
const HELP = `Usage:
  node scripts/check-market-research.mjs --stdio
  node scripts/check-market-research.mjs --endpoint https://mcp.bull-run.org/mcp

--stdio starts the compiled dist/stdio.js using BULLRUN_API_BASE (default
http://localhost:8085). Build first. --endpoint uses the official HTTP SDK.
Only HTTPS or loopback HTTP endpoints without credentials/query/fragment are accepted.
Optional credentials belong in MCP_TOKEN, or MCPRUSH_TOKEN/MCPRUSH_INSTALL_ID
for /mcprush/mcp; never put secrets in command arguments.

Runs eight bounded public-market calls: three listing searches, preset list/run,
MSFT peers, AAPL prices and AAPL news. News reads may queue the documented
best-effort cached-news refresh. No portfolio or account tools are called.
Prints compact JSON summaries and exits nonzero on errors or failed contracts.
Empty company news is permitted. Stops without retrying on rate-limit evidence.
`;

class CheckFailure extends Error {}
class RateLimited extends CheckFailure {}
const object = value => value != null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value);
const log = (check, status, summary = {}) => console.log(JSON.stringify({ check, status, ...summary }));

function options(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  if (args.length === 1 && args[0] === "--stdio") return { stdio: true };
  if (args.length !== 2 || args[0] !== "--endpoint") throw new CheckFailure("Use --stdio or --endpoint URL; see --help.");
  let url;
  try { url = new URL(args[1]); } catch { throw new CheckFailure("The endpoint must be a complete URL."); }
  if (url.username || url.password || url.search || url.hash ||
    url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new CheckFailure("Use HTTPS or loopback HTTP, without URL credentials, query or fragment.");
  }
  return { endpoint: url };
}

function headersFor(endpoint) {
  const headers = {};
  const token = process.env.MCP_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (endpoint.pathname.endsWith("/mcprush/mcp")) {
    if (process.env.MCPRUSH_TOKEN) headers["x-mcprush-token"] = process.env.MCPRUSH_TOKEN;
    if (process.env.MCPRUSH_INSTALL_ID) headers["x-mcprush-install"] = process.env.MCPRUSH_INSTALL_ID;
    headers["x-mcprush-listing"] = process.env.MCPRUSH_LISTING_ID ?? "bullrun";
  }
  if (Object.values(headers).some(value => value.length > 8192 || /[\r\n\x00]/.test(value))) throw new CheckFailure("A credential/header environment variable is invalid.");
  return headers;
}

function requireArray(value, label) { assert.ok(Array.isArray(value), `${label} must be an array`); return value; }
function requireCoverage(data) { assert.ok(object(data.coverage), "coverage object missing"); }
function requireInstant(value, label) { assert.ok(instant(value), `${label} must have an absolute timestamp`); }
function searchSummary(data) {
  assert.ok(["resolved", "candidate", "ambiguous"].includes(data.status), "expected a stored listing match");
  const rows = requireArray(data.candidates, "candidates");
  assert.ok(rows.length > 0 && rows.length <= 5, "expected 1-5 listing candidates");
  for (const row of rows) assert.ok(typeof row.ticker === "string" && row.ticker.length, "listing ticker missing");
  requireCoverage(data);
  requireInstant(data.retrievedAt, "retrievedAt");
  return { matchStatus: data.status, resolvedTicker: data.resolvedTicker, returnedCount: rows.length, candidateCount: data.candidateCount,
    listings: rows.map(row => ({ ticker: row.ticker, exchange: row.exchange, currency: row.quoteCurrency, match: row.match })),
    mayBeTruncated: data.coverage.mayBeTruncated, retrievedAt: data.retrievedAt };
}

async function run(config) {
  let rateLimited = false;
  const transport = config.stdio ? new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../dist/stdio.js", import.meta.url))],
    cwd: fileURLToPath(new URL("../", import.meta.url)), stderr: "pipe",
    env: { ...getDefaultEnvironment(), BULLRUN_API_BASE: process.env.BULLRUN_API_BASE ?? "http://localhost:8085",
      ...(process.env.BULLRUN_API_TIMEOUT_MS ? { BULLRUN_API_TIMEOUT_MS: process.env.BULLRUN_API_TIMEOUT_MS } : {}) },
  }) : new StreamableHTTPClientTransport(config.endpoint, {
    requestInit: { headers: headersFor(config.endpoint) },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: "error",
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 429) rateLimited = true;
      return response;
    },
  });
  // Drain child diagnostics without printing possible upstream URLs or credentials.
  if (config.stdio) transport.stderr?.on("data", () => {});
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  let failures = 0;
  let completed = 0;
  const startedAt = new Date().toISOString();
  async function check(label, tool, args, verify) {
    if (rateLimited) throw new RateLimited("Rate limiting observed; no retry or further calls were made.");
    const started = Date.now();
    try {
      const result = await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { timeout: TIMEOUT_MS });
      if (result.isError) {
        if (result.content?.some(block => block.type === "text" && /rate.?limit|too many requests|\b429\b/i.test(block.text))) {
          rateLimited = true;
          throw new RateLimited("Rate limiting observed; no retry or further calls were made.");
        }
        throw new CheckFailure("Tool returned isError; inspect server logs for the upstream cause.");
      }
      const data = result.structuredContent;
      assert.ok(object(data), "tool must return structuredContent");
      const text = result.content.find(block => block.type === "text");
      assert.ok(text, "text JSON missing");
      assert.deepEqual(JSON.parse(text.text), data, "structured and text JSON differ");
      const summary = verify(data);
      completed++;
      log(label, "pass", { elapsedMs: Date.now() - started, ...summary });
    } catch (error) {
      if (rateLimited || error instanceof RateLimited) throw new RateLimited("Rate limiting observed; no retry or further calls were made.");
      failures++;
      // Assertion messages in this script are fixed strings; SDK/HTTP error bodies are not printed.
      const reason = error instanceof CheckFailure ? error.message : error?.code === "ERR_ASSERTION"
        ? String(error.message).split("\n")[0].slice(0, 220) : "Transport or SDK call failed; inspect deployment/authentication and upstream logs.";
      log(label, "fail", { elapsedMs: Date.now() - started, reason });
    }
  }
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    const { tools } = await client.listTools({}, { timeout: TIMEOUT_MS });
    for (const name of REQUIRED_TOOLS) assert.ok(tools.some(tool => tool.name === name), `catalog is missing ${name}`);
    log("catalog", "pass", { server: client.getServerVersion(), clientName: CLIENT_NAME, requiredTools: REQUIRED_TOOLS,
      startedAt, mode: config.stdio ? "stdio" : "http" });

    await check("native ticker", "search_stocks", { query: "AAPL", limit: 5 }, data => {
      const summary = searchSummary(data);
      assert.equal(data.resolvedTicker, "AAPL", "AAPL must resolve to its exact native ticker");
      assert.ok(data.candidates.some(row => row.ticker === "AAPL" && row.match === "exact_native_ticker"), "exact AAPL candidate missing");
      return summary;
    });
    await check("Yahoo venue alternative", "search_stocks", { query: "BMW.DE", limit: 5 }, data => {
      const summary = searchSummary(data);
      assert.ok(data.candidates.some(row => (row.ticker === "BMW" || row.ticker.startsWith("BMW@")) && ["XETRA", "XETR"].includes(row.exchange)), "BMW.DE must yield the native BMW/XETRA listing, including collision-qualified native tickers");
      return summary;
    });
    await check("Nestle ISIN", "search_stocks", { query: "CH0038863350", limit: 5 }, data => {
      const summary = searchSummary(data);
      assert.ok(data.candidates.every(row => row.isin === "CH0038863350"), "ISIN candidates must match the requested security");
      return summary;
    });
    await check("preset catalogue", "screen_stock_presets", { action: "list" }, data => {
      const presets = requireArray(data.presets, "presets");
      const value = presets.find(row => row.key === "profitable_value");
      assert.ok(value, "profitable_value preset missing");
      for (const [metric, operator, threshold] of [["latestNetIncome", ">", "0"], ["latestFreeCashflow", ">", "0"], ["peRatio", ">", "0"], ["peRatio", "<=", "20"]]) {
        assert.ok(value.rules.some(rule => rule.metric === metric && rule.operator === operator && rule.value === threshold), `preset missing ${metric} ${operator} ${threshold}`);
      }
      return { presets: presets.map(row => row.key), annualLookback: value.defaultLookback };
    });
    await check("Germany profitable value", "screen_stock_presets", { action: "run", preset: "profitable_value", countries: ["Germany"], limit: 3 }, data => {
      const rows = requireArray(data.results, "results");
      assert.ok(rows.length > 0 && rows.length <= 3, "expected 1-3 German profitable value results");
      for (const row of rows) {
        assert.equal(row.country, "Germany", "preset country constraint failed");
        assert.ok(finite(row.peRatio) && row.peRatio > 0 && row.peRatio <= 20, "preset P/E constraint failed");
        assert.ok(finite(row.latestNetIncome) && row.latestNetIncome > 0, "preset positive earnings constraint failed");
        assert.ok(finite(row.latestFreeCashflow) && row.latestFreeCashflow > 0, "preset positive free cash flow constraint failed");
      }
      assert.ok(rows.every((row, index) => index === 0 || row.peRatio >= rows[index - 1].peRatio), "preset P/E sorting failed");
      requireCoverage(data);
      requireInstant(data.retrievedAt, "retrievedAt");
      return { count: rows.length, matches: rows.map(row => ({ ticker: row.ticker, peRatio: row.peRatio })),
        resultLimitReached: data.coverage.resultLimitReached, completeUniverse: data.coverage.completeUniverse, retrievedAt: data.retrievedAt };
    });
    await check("MSFT classification peers", "find_stock_peers", { ticker: "MSFT", limit: 3 }, data => {
      const peers = requireArray(data.peers, "peers");
      assert.ok(peers.length > 0 && peers.length <= 3, "expected 1-3 MSFT classification peers");
      assert.equal(data.subject.ticker, "MSFT", "peer subject identity mismatch");
      for (const row of peers) {
        assert.notEqual(row.ticker, "MSFT", "subject returned as its own peer");
        assert.equal(row.primaryTicker, null, "secondary listing returned as peer");
        assert.ok(row.quoteType == null || row.quoteType === "EQUITY", "non-equity returned as peer");
        assert.equal(row[data.selection.effectiveMatchBy], data.selection.classificationValue, "peer classification mismatch");
      }
      assert.equal(new Set(peers.map(row => row.ticker)).size, peers.length, "duplicate peer ticker");
      assert.ok(data.comparison?.arguments?.tickers.length <= 5, "compare_stocks continuation exceeds five tickers");
      requireCoverage(data);
      requireInstant(data.retrievedAt, "retrievedAt");
      return { matchBy: data.selection.effectiveMatchBy, classification: data.selection.classificationValue,
        peers: peers.map(row => row.ticker), candidateCount: data.coverage.candidatesReturnedByBackend,
        backendMayBeTruncated: data.coverage.backendMayBeTruncated, retrievedAt: data.retrievedAt };
    });
    await check("AAPL daily prices and indicators", "get_stock_price_history", { ticker: "AAPL", limit: 60, indicators: ["sma", "rsi"] }, data => {
      const bars = requireArray(data.bars, "bars");
      assert.ok(bars.length >= 20 && bars.length <= 60, "expected 20-60 AAPL daily bars for indicator validation");
      assert.equal(data.ticker, "AAPL", "price ticker mismatch");
      assert.equal(data.interval, "daily", "unexpected price interval");
      assert.ok(bars.every((bar, index) => finite(bar.close) && bar.close > 0 && (index === 0 || bar.endDate > bars[index - 1].endDate)), "invalid price close/order");
      assert.ok(bars.slice(0, 19).every(bar => bar.sma === null), "SMA warm-up must remain null");
      const mean20 = bars.slice(0, 20).reduce((sum, bar) => sum + bar.close, 0) / 20;
      assert.ok(Math.abs(bars[19].sma - mean20) < 1e-6, "SMA20 differs from observed closing-price mean");
      assert.ok(bars.slice(0, 14).every(bar => bar.rsi === null), "RSI warm-up must remain null");
      assert.ok(bars.slice(14).every(bar => finite(bar.rsi) && bar.rsi >= 0 && bar.rsi <= 100), "RSI14 must be finite in [0,100] after warm-up");
      assert.equal(data.methodology.priceAdjustment, "unknown", "adjustment status must not be assumed");
      assert.equal(data.methodology.totalReturnVerified, false, "price performance must not be labelled total return");
      requireCoverage(data);
      requireInstant(data.coverage.retrievedAt, "retrievedAt");
      return { count: bars.length, firstDate: bars[0].startDate, lastDate: bars.at(-1).endDate,
        priceReturnPct: data.summary.priceReturnPct, maximumDrawdownPct: data.summary.maximumDrawdownPct,
        latestSma20: bars.at(-1).sma, latestRsi14: bars.at(-1).rsi,
        sourceLimitReached: data.coverage.sourceLimitReached, sourceFetchedAt: data.coverage.sourceFetchedAt, retrievedAt: data.coverage.retrievedAt };
    });
    await check("AAPL company news", "get_company_news", { ticker: "AAPL", limit: 3 }, data => {
      const articles = requireArray(data.articles, "articles");
      assert.ok(articles.length <= 3, "news result limit exceeded");
      assert.equal(data.ticker, "AAPL", "news ticker mismatch");
      assert.equal(data.status, articles.length ? "available" : "no_matching_stored_articles", "news availability status mismatch");
      assert.ok(["unknown", "stale", "recently_stored"].includes(data.freshness.status), "news freshness status missing");
      assert.equal(data.freshness.refresh.completed, null, "background news refresh must not be claimed completed");
      for (const [index, row] of articles.entries()) {
        requireInstant(row.publishedAt, "publishedAt");
        assert.ok(typeof row.headline === "string" && row.headline.length, "news headline missing");
        assert.ok(row.source === null || typeof row.source === "string", "invalid news source");
        assert.ok(row.url === null || ["https:", "http:"].includes(new URL(row.url).protocol), "invalid article URL");
        if (index) assert.ok(row.publishedAt <= articles[index - 1].publishedAt, "news order must be newest first");
      }
      requireCoverage(data);
      requireInstant(data.freshness.retrievedAt, "retrievedAt");
      return { count: articles.length, availability: data.status, latestPublication: articles[0]?.publishedAt ?? null,
        publishers: [...new Set(articles.map(row => row.source))], sourceFetchedAt: data.freshness.sourceFetchedAt,
        freshness: data.freshness.status, sourceLimitReached: data.coverage.sourceLimitReached,
        retrievedAt: data.freshness.retrievedAt, warnings: data.warnings.length };
    });
    log("summary", failures ? "fail" : "pass", { completed, failed: failures, startedAt, completedAt: new Date().toISOString() });
    return failures ? 1 : 0;
  } catch (error) {
    if (rateLimited) throw new RateLimited("Rate limiting observed; no retry or further calls were made.");
    throw error;
  } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}

try {
  const config = options(process.argv.slice(2));
  if (config.help) console.log(HELP);
  else process.exitCode = await run(config);
} catch (error) {
  const reason = error instanceof CheckFailure ? error.message : error?.code === "ERR_ASSERTION"
    ? String(error.message).split("\n")[0].slice(0, 220) : "Connection/catalog failed; check build, endpoint, credentials and deployment logs. No automatic retry was made.";
  log("smoke", error instanceof RateLimited ? "rate_limited" : "fail", { reason });
  process.exitCode = error instanceof RateLimited ? 3 : 1;
}
