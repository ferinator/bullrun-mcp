// What an agent types vs how Bullrun stores the ticker. Tokyo is mostly NNNN.T but a
// few majors are bare codes (Toyota 7203); Europe is bare (BMW); Hong Kong is padded
// (0700.HK). Resolution must follow the stored form and never guess between listings.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const listing = (ticker, company, exchange, country, extra = {}) => ({ ticker, company, exchange, country,
  currency: country === "Japan" ? "JPY" : "USD", sector: "Industrials", industry: "Machinery", isin: null,
  primaryTicker: null, quoteType: "EQUITY", ...extra });
const STORED = {
  "6324.T": listing("6324.T", "Harmonic Drive Systems Inc.", "TSE", "Japan"),
  "7203": listing("7203", "Toyota Motor Corporation", "TSE", "Japan"),
  "2050.T": listing("2050.T", "Some Tokyo Co", "TSE", "Japan"),
  "2050.HK": listing("2050.HK", "Zhejiang Sanhua", "HK", "China"),
  "0700.HK": listing("0700.HK", "Tencent Holdings Limited", null, "China"),
  "BMW": listing("BMW", "Bayerische Motoren Werke", "XETRA", "Germany"),
  "ABC": listing("ABC", "A US Company", "NASDAQ", "United States"),
  "OLD": listing("NEW", "Renamed Co", "NYSE", "United States"),
};
// Rows keyed by the stored ticker only, as the API keys them.
const KEYED = new Set(Object.values(STORED).map((row) => row.ticker));

let upstream;
let resolveStockTicker;
let mode = "normal";
let requests = [];

function respond(url) {
  const parts = url.pathname.split("/");
  const ticker = decodeURIComponent(parts[3] ?? "");
  if (url.pathname.startsWith("/api/stocks/") && parts.length === 4) return STORED[ticker] ? [200, STORED[ticker]] : [404, { error: "not found" }];
  if (url.pathname === "/api/stocks") return [200, []];
  if (url.pathname.startsWith("/api/calendar/")) return [200, []];
  if (url.pathname === "/api/ml-scores/summary") return [200, { results: {} }];
  const keyed = KEYED.has(ticker);
  if (parts[2] === "prices") return [200, keyed ? [{ ticker, tradeDate: "2026-10-16", closePrice: 9876.5, openPrice: 9800, highPrice: 9900, lowPrice: 9700, volume: 100 },
    { ticker, tradeDate: "2026-10-15", closePrice: 9700, openPrice: 9650, highPrice: 9750, lowPrice: 9600, volume: 90 }] : []];
  if (parts[2] === "financials" || parts[2] === "valuations") return [200, []];
  if (parts[4] === "relationships") return [200, keyed ? { status: "ready", subject: { ticker },
    nodes: [{ id: `n-${ticker}`, name: ticker, ticker, role: "SELECTED" }], edges: [], coverage: { edges: 0 } }
    : { status: "none", subject: { name: null, ticker }, nodes: [], edges: [], coverage: {} }];
  // The research manifests match stored tickers exactly, like CompanyResearchController.
  if (parts[4] === "data-coverage") return keyed ? [200, { ticker, companyName: STORED[ticker]?.company ?? "Renamed Co", checkedAt: "2026-10-20T00:00:00Z", datasets: [], graph: null, caveats: [] }] : [404, { error: "ticker not found" }];
  if (parts[4] === "risk-history") return keyed ? [200, { ticker, companyName: "Example", history: [{ asOfDate: "2026-10-16", dials: [] }], caveats: [] }] : [404, { error: "ticker not found" }];
  if (parts[4] === "news") return [200, []];
  if (parts[2] === "company-intelligence" && parts[4] === "risk-preview") return [200, { dials: { ticker, asOfDate: null, formulaVersion: "v1", composite: null, compositeAbsentWhy: "none", dials: [] }, headline: null }];
  if (parts[2] === "company-intelligence") return [200, []];
  return [404, { error: "not found" }];
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    requests.push(url);
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (mode === "down") return send(503, { error: "unavailable" });
    if (mode === "quota") return send(429, { error: "quota_exceeded" });
    const [status, body] = respond(url);
    return send(status, body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ resolveStockTicker } = await import("../dist/tools/stockIdentity.js"));
});

after(() => { upstream.closeAllConnections(); upstream.close(); });

test("a stored ticker resolves to itself", async () => {
  const r = await resolveStockTicker("7203");
  assert.equal(r.ticker, "7203");
  assert.equal(r.note, null);
});

test("a bare Tokyo code resolves to its only suffixed listing", async () => {
  const r = await resolveStockTicker("6324");
  assert.equal(r.ticker, "6324.T");
  assert.match(r.note, /6324 resolved to 6324\.T/);
});

test("a code stored under two markets is returned as candidates, not guessed", async () => {
  const r = await resolveStockTicker("2050");
  assert.equal(r.ticker, null);
  assert.deepEqual(r.candidates.map((s) => s.ticker).sort(), ["2050.HK", "2050.T"]);
});

test("an unpadded Hong Kong code is padded", async () => {
  assert.equal((await resolveStockTicker("700")).ticker, "0700.HK");
  assert.equal((await resolveStockTicker("700.HK")).ticker, "0700.HK");
});

test("a Yahoo suffix on a bare-stored listing resolves only when the venue agrees", async () => {
  assert.equal((await resolveStockTicker("7203.T")).ticker, "7203");
  assert.equal((await resolveStockTicker("BMW.DE")).ticker, "BMW");
  // ABC is a NASDAQ line: ABC.L must not become it.
  const london = await resolveStockTicker("ABC.L");
  assert.equal(london.ticker, null);
  assert.deepEqual(london.candidates, []);
});

test("a retired ticker resolves to its survivor and says so", async () => {
  const r = await resolveStockTicker("old");
  assert.equal(r.ticker, "NEW");
  assert.match(r.note, /retired ticker/);
});

test("an outage or quota error is reported, never read as not covered", async () => {
  mode = "down";
  await assert.rejects(resolveStockTicker("6324"), /not reachable right now.*not a coverage answer/);
  mode = "quota";
  await assert.rejects(resolveStockTicker("6324"), /quota.*not a coverage answer/);
  mode = "normal";
});

// ── The newer tools resolve what they are given the same way ──────────────────────

const TOOL_MODULES = [
  ["getStockPriceHistory", "registerGetStockPriceHistory"], ["compareStocks", "registerCompareStocks"],
  ["getCompanyNews", "registerGetCompanyNews"], ["findStockPeers", "registerFindStockPeers"],
  ["compareCompanyExposures", "registerCompareCompanyExposures"], ["getCorporateCalendar", "registerGetCorporateCalendar"],
  ["getEarningsCallTranscript", "registerGetEarningsCallTranscript"], ["getForwardEstimates", "registerGetForwardEstimates"],
  ["getOperatingKpis", "registerGetOperatingKpis"], ["getCompanyDataCoverage", "registerGetCompanyDataCoverage"],
  ["getCompanyRiskHistory", "registerGetCompanyRiskHistory"],
];

async function call(name, args) {
  const server = new McpServer({ name: "resolver-tools-test", version: "1" });
  for (const [file, register] of TOOL_MODULES) (await import(`../dist/tools/${file}.js`))[register](server);
  const client = new Client({ name: "resolver-tools-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    let data = result.structuredContent ?? null;
    if (!data) { try { data = JSON.parse(text); } catch { data = null; } }
    return { result, text, data };
  } finally {
    await client.close();
    await server.close();
  }
}

function reset(nextMode = "normal") { mode = nextMode; requests = []; }

test("get_stock_price_history reads a bare Tokyo code's stored listing", async () => {
  reset();
  const { result, data } = await call("get_stock_price_history", { ticker: "6324" });
  assert.equal(result.isError, undefined);
  assert.equal(data.ticker, "6324.T");
  assert.match(data.tickerResolution, /6324 resolved to 6324\.T/);
  assert.deepEqual(data.bars.map((bar) => bar.close), [9700, 9876.5]);
  assert.ok(requests.some((url) => url.pathname === "/api/prices/6324.T"));
  assert.ok(!requests.some((url) => url.pathname === "/api/prices/6324"), "the bare code is never read as a ticker");
});

test("get_stock_price_history lists candidates for an ambiguous code instead of guessing", async () => {
  reset();
  const { text } = await call("get_stock_price_history", { ticker: "2050" });
  assert.match(text, /matches more than one Bullrun listing: 2050\.(T|HK)/);
  assert.ok(!requests.some((url) => url.pathname.startsWith("/api/prices/")));
});

test("a quota error during resolution is reported as such, not as missing history", async () => {
  reset("quota");
  const { result, text } = await call("get_stock_price_history", { ticker: "6324" });
  assert.equal(result.isError, true);
  assert.match(text, /quota.*not a coverage answer/);
  reset();
});

test("compare_stocks resolves both of 6324 and 7203 and names search_stocks for an unknown ticker", async () => {
  reset();
  const { data } = await call("compare_stocks", { tickers: ["6324", "7203"], include: ["fundamentals"] });
  assert.deepEqual(data.tickers, ["6324.T", "7203"]);
  assert.equal(data.coverage[0].identityAvailable, true);
  assert.equal(data.coverage[1].identityAvailable, true);
  assert.ok(data.warnings.some((warning) => /6324 resolved to 6324\.T/.test(warning)));
  assert.equal(data.rows[0].fundamentals.latestPrice.close, 9876.5);
  reset();
  const missing = await call("compare_stocks", { tickers: ["7203", "ZZZZ"], include: ["fundamentals"] });
  const text = missing.data.warnings.join(" ");
  assert.match(text, /No Bullrun listing for "ZZZZ".*search_stocks/);
  assert.doesNotMatch(text, /screen_stocks/);
});

test("compare_stocks compares one listing once when two inputs name it", async () => {
  reset();
  const { data, result } = await call("compare_stocks", { tickers: ["6324", "6324.T", "7203"], include: ["fundamentals"] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(data.tickers, ["6324.T", "7203"]);
  assert.ok(data.warnings.some((warning) => /6324\.T is the same listing as 6324\.T|6324 is the same listing/.test(warning)));
  const only = await call("compare_stocks", { tickers: ["6324", "6324.T"], include: ["fundamentals"] });
  assert.equal(only.result.isError, true);
  assert.match(only.text, /only one listing \(6324\.T\)/);
});

test("news, peers, transcripts, estimates and KPIs read the resolved listing", async () => {
  for (const [name, path] of [
    ["get_company_news", "/api/stocks/6324.T/news"],
    ["find_stock_peers", "/api/stocks"],
    ["get_earnings_call_transcript", "/api/company-intelligence/6324.T/earnings-call-transcripts"],
    ["get_forward_estimates", "/api/company-intelligence/6324.T/forward-estimates"],
    ["get_operating_kpis", "/api/company-intelligence/6324.T/operating-kpis"],
  ]) {
    reset();
    const { data } = await call(name, { ticker: "6324" });
    assert.equal(data.ticker, "6324.T", name);
    assert.match(data.tickerResolution, /6324 resolved to 6324\.T/, name);
    assert.ok(requests.some((url) => url.pathname === path), `${name} read ${path}`);
    assert.ok(!requests.some((url) => /\/6324(\/|$)/.test(url.pathname) && !/^\/api\/stocks\/6324$/.test(url.pathname)), `${name} never reads data under the bare code`);
  }
});

test("an unknown ticker gets the convention, not an empty dataset", async () => {
  for (const name of ["get_company_news", "find_stock_peers", "get_earnings_call_transcript", "get_forward_estimates", "get_operating_kpis"]) {
    reset();
    const { text } = await call(name, { ticker: "ZZZZ" });
    assert.match(text, /No Bullrun listing for "ZZZZ".*keep their exchange suffix/, name);
  }
});

test("coverage and risk history stay one exact read, and resolve only after a miss", async () => {
  for (const [name, path] of [["get_company_data_coverage", "data-coverage"], ["get_company_risk_history", "risk-history"]]) {
    reset();
    const exact = await call(name, { ticker: "7203" });
    assert.equal(exact.data.ticker, "7203", name);
    assert.equal(requests.length, 1, `${name}: an exact ticker is one cheap read`);
    reset();
    const bare = await call(name, { ticker: "6324" });
    assert.equal(bare.result.isError, undefined, name);
    assert.equal(bare.data.ticker, "6324.T", name);
    assert.match(bare.data.tickerResolution, /6324 resolved to 6324\.T/);
    assert.equal(requests.at(-1).pathname, `/api/stocks/6324.T/${path}`);
    reset();
    const missing = await call(name, { ticker: "ZZZZ" });
    assert.equal(missing.result.isError, true);
    assert.match(missing.text, /No Bullrun listing for "ZZZZ"/);
  }
});

test("compare_company_exposures looks up only a ticker without a graph", async () => {
  reset();
  const { data, result } = await call("compare_company_exposures", { tickers: ["6324", "7203"] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(data.tickers, ["6324.T", "7203"]);
  assert.equal(data.companies[0].status, "available");
  assert.ok(data.companies[0].warnings.some((warning) => /6324 resolved to 6324\.T/.test(warning)));
  // 7203 has a graph under the typed ticker: one read, no lookup.
  assert.deepEqual(requests.filter((url) => url.pathname.includes("7203")).map((url) => url.pathname), ["/api/stocks/7203/relationships"]);
});

test("get_corporate_calendar searches a Yahoo symbol under the stored ticker", async () => {
  reset();
  const { data } = await call("get_corporate_calendar", { q: "7203.T", include: ["earnings"] });
  assert.equal(requests.find((url) => url.pathname === "/api/calendar/earnings").searchParams.get("q"), "7203");
  assert.ok(data.warnings.some((warning) => /q "7203\.T" was searched as 7203/.test(warning)));
  reset();
  await call("get_corporate_calendar", { q: "toyota", include: ["earnings"] });
  assert.equal(requests.length, 1, "a name is searched as typed, without a ticker lookup");
  assert.equal(requests[0].searchParams.get("q"), "toyota");
});
