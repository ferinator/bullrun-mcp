import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

let upstream;
let registrations;
let runWithAuth;
let mode = "normal";
let requests = [];
const callbacks = new Map();

const stock = (ticker, company, extra = {}) => ({ ticker, company, exchange: "NASDAQ", currency: "USD", country: "United States",
  sector: "Technology", industry: "Software", quoteType: "EQUITY", primaryTicker: null, isin: null,
  lifecycleStatus: "ACTIVE", ...extra });
const SUBJECT = stock("ACME", "Acme Inc", { isin: "US0378331005", lei: "ACME-LEI", cik: "123" });

function reply(url) {
  if (mode === "failure") return { status: 503, body: { error: "do not leak upstream-secret or private.internal" } };
  if (url.pathname === "/api/stocks/ACME") return { body: mode === "wrong-identity" ? stock("WRONG", "Wrong")
    : mode === "fund-subject" ? { ...SUBJECT, quoteType: "ETF" }
    : mode === "no-industry" ? { ...SUBJECT, industry: null }
    : SUBJECT };
  if (url.pathname === "/api/stocks") {
    if (url.searchParams.has("industry") || url.searchParams.has("sector")) {
      const peers = [SUBJECT, stock("ACME-B", "Acme Inc Class B", { isin: "different-share-class" }),
        stock("ACME-SW", "Acme Swiss", { primaryTicker: "ACME" }),
        stock("OTHER-ACME", "Other name", { lei: "ACME-LEI" }),
        stock("ZETA", "Zeta Corp", { marketCap: 500, peRatio: 15, revenueGrowthPct: 20 }),
        stock("ZETA-B", "Zeta Corporation Class B", { isin: "another-share-class" }),
        stock("BETA", "Beta Inc", { country: "Canada", currency: "CAD" }),
        stock("ALPHA", "Alpha AG", { marketCap: 1000 }),
        stock("RENAMED", "Old peer", { lifecycleStatus: "RENAMED", succeededBy: "NEW" }),
        stock("FUND", "Software fund", { quoteType: "ETF" }),
        stock("BADCLASS", "Bad classification", { industry: "Banks", sector: "Financial Services" })];
      return { body: mode === "empty-peers" ? [SUBJECT] : peers };
    }
    const term = url.searchParams.get("search");
    if (term === "AAPL") return { body: [stock("AAPLL", "Similar"), stock("AAPL", "Apple Inc", { isin: "US0378331005" })] };
    if (term === "BMW.DE" || term === "0005.HK" || term === "ERIC-B.ST") return { body: [] };
    if (term === "BMW") return { body: [stock("BMW", "Bayerische Motoren Werke AG", { exchange: "XETRA", country: "Germany", currency: "EUR" }),
      stock("BMW@XNAS", "Wrong venue", { exchange: "NASDAQ" })] };
    if (term === "0005") return { body: [] };
    if (term === "5") return { body: [stock("5", "HSBC", { exchange: "XHKG", country: "Hong Kong", currency: "HKD" }), stock("55", "Other HK", { exchange: "XHKG" })] };
    if (term === "ERIC-B" || term === "ERIC B") return { body: [stock("ERIC B@XSTO", "Ericsson Class B", { exchange: "XSTO", country: "Sweden" }),
      stock("ERIC A@XSTO", "Ericsson Class A", { exchange: "XSTO" })] };
    if (term === "BRK.B") return { body: [stock("BRK.B", "Berkshire Hathaway Class B", { exchange: "NYSE" })] };
    if (term === "US0378331005") return { body: [stock("AAPL", "Apple Inc", { isin: term }), stock("APC", "Apple Inc", { isin: term, exchange: "F", primaryTicker: "AAPL" })] };
    if (term === "IE00B4L5Y983") return { body: [stock("IWDA", "iShares Core MSCI World", { quoteType: "ETF", isin: null, fundIsin: term })] };
    if (term === "Alpha Company") return { body: [stock("ALPHA", "Alpha Company"), stock("ALPHAB", "Alpha Company", { primaryTicker: "ALPHA" })] };
    if (term === "RETIRED") return { body: [stock("RETIRED", "Retired company", { lifecycleStatus: "RENAMED", succeededBy: "NEW" })] };
    if (term === "FUND") return { body: [stock("FUND", "A fund", { quoteType: "ETF" })] };
    if (term === "cap") return { body: Array.from({ length: 500 }, (_, i) => stock(`C${i}`, `Candidate ${i}`)) };
    return { body: [] };
  }
  if (url.pathname === "/api/screener/filter") return { body: mode === "bad-screen" ? {} : [
    { ticker: "PASS", company: "Passed company", country: "Germany", latestNetIncome: 10, latestFreeCashflow: 15,
      latestOperatingCashflow: 20, dividendYield: 3.5, peRatio: 12, revenueSeries: [150, null, 100],
      dilutedEpsSeries: [3, 2, 1], dividendsPerShareSeries: [1.21, 1.1, 1] },
  ] };
  return { status: 404, body: {} };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://upstream.test");
    requests.push({ url, method: req.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    const result = reply(url);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  const search = await import("../dist/tools/searchStocks.js");
  const screens = await import("../dist/tools/screenStocks.js");
  const presets = await import("../dist/tools/screenStockPresets.js");
  const peers = await import("../dist/tools/findStockPeers.js");
  registrations = [search.registerSearchStocks, screens.registerScreenStocks, presets.registerScreenStockPresets, peers.registerFindStockPeers];
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  for (const register of registrations) register({ registerTool(name, _definition, callback) { callbacks.set(name, callback); } });
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

function reset(nextMode = "normal") { mode = nextMode; requests = []; }

async function withClient(run) {
  const server = new McpServer({ name: "stock-discovery-test", version: "1" });
  for (const register of registrations) register(server);
  const client = new Client({ name: "discovery-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(CallToolResultSchema.safeParse(result).success, true);
  if (result.structuredContent) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result;
}

test("search exposes read-only SDK metadata and resolves native/MIC-qualified tickers", async () => {
  reset();
  await withClient(async client => {
    const defs = await client.listTools();
    assert.equal(defs.tools.length, 4);
    for (const definition of defs.tools) assert.equal(definition.annotations.readOnlyHint, true);
    const result = await call(client, "search_stocks", { query: "XNAS:AAPL", exchange: "NASDAQ" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "resolved");
    assert.equal(result.structuredContent.resolvedTicker, "AAPL");
    assert.equal(result.structuredContent.candidates.length, 1);
    assert.equal(requests[0].url.searchParams.get("search"), "AAPL");
    assert.equal(requests[0].url.searchParams.get("includeSecondary"), "true");
    const nativeClass = await call(client, "search_stocks", { query: "BRK.B" });
    assert.equal(nativeClass.structuredContent.resolvedTicker, "BRK.B");
    assert.equal(requests.filter(entry => entry.url.searchParams.get("search") === "BRK").length, 0);
    const wrongCurrency = await call(client, "search_stocks", { query: "AAPL", currency: "CHF" });
    assert.equal(wrongCurrency.structuredContent.status, "not_found");
    const lowerCurrency = await call(client, "search_stocks", { query: "AAPL", currency: "usd" });
    assert.equal(lowerCurrency.structuredContent.resolvedTicker, "AAPL");
    assert.equal(requests.at(-1).url.searchParams.get("currency"), "USD");
  });
});

test("Yahoo alternatives retain venue checks, numeric padding and share class; never auto-select", async () => {
  reset();
  await withClient(async client => {
    for (const [query, expected] of [["BMW.DE", "BMW"], ["0005.HK", "5"], ["ERIC-B.ST", "ERIC B@XSTO"]]) {
      const result = await call(client, "search_stocks", { query });
      const data = result.structuredContent;
      assert.equal(data.status, "candidate");
      assert.equal(data.resolvedTicker, null);
      assert.deepEqual(data.candidates.map(row => row.ticker), [expected]);
      assert.equal(data.candidates[0].match, "venue_checked_yahoo_alternative");
    }
  });
});

test("ISIN and exact company-name alternatives remain ambiguous even when output is limited", async () => {
  reset();
  await withClient(async client => {
    for (const query of ["US0378331005", "Alpha Company"]) {
      const result = await call(client, "search_stocks", { query, limit: 1 });
      assert.equal(result.structuredContent.status, "ambiguous");
      assert.equal(result.structuredContent.resolvedTicker, null);
      assert.equal(result.structuredContent.candidateCount, 2);
      assert.equal(result.structuredContent.coverage.mayBeTruncated, true);
    }
    const retired = await call(client, "search_stocks", { query: "RETIRED", includeInactive: true });
    assert.equal(retired.structuredContent.resolvedTicker, null);
    assert.equal(retired.structuredContent.candidates[0].succeededBy, "NEW");
    const fund = await call(client, "search_stocks", { query: "IE00B4L5Y983", quoteType: "ETF" });
    assert.equal(fund.structuredContent.resolvedTicker, "IWDA");
    assert.equal(fund.structuredContent.candidates[0].fundIsin, "IE00B4L5Y983");
    assert.equal(fund.structuredContent.candidates[0].match, "exact_isin");
  });
});

test("invalid identifiers, exchange conflicts and unsupported fund types cannot silently resolve", async () => {
  reset();
  await withClient(async client => {
    assert.equal((await call(client, "search_stocks", { query: "US0378331004" })).isError, true);
    assert.equal((await call(client, "search_stocks", { query: "XETRA:AAPL", exchange: "NASDAQ" })).isError, true);
    assert.equal(requests.length, 0);
    const fund = await call(client, "search_stocks", { query: "FUND" });
    assert.equal(fund.structuredContent.status, "not_found");
    const allowed = await call(client, "search_stocks", { query: "FUND", quoteType: "ETF" });
    assert.equal(allowed.structuredContent.resolvedTicker, "FUND");
    const capped = await call(client, "search_stocks", { query: "cap" });
    assert.equal(capped.structuredContent.coverage.mayBeTruncated, true);
    assert.equal(capped.structuredContent.coverage.completeUniverse, false);
  });
});

test("preset listing is free of upstream reads and discloses exact backend growth semantics", async () => {
  reset();
  await withClient(async client => {
    const result = await call(client, "screen_stock_presets", {});
    const data = result.structuredContent;
    assert.equal(data.presets.length, 5);
    assert.equal(requests.length, 0);
    const income = data.presets.find(row => row.key === "dividend_income");
    assert.ok(income.rules.some(rule => rule.metric === "dividendYield" && rule.value === "3" && rule.unit === ""));
    assert.match(data.methodology.growth, /skipped/);
    assert.match(data.methodology.annual, /four-quarter/);
    assert.match(data.methodology.coverage, /5,000/);
    assert.match(data.methodology.dividendYield, /provider fallback must not be labeled trailing or forward/);
    assert.ok(data.presets.every(preset => !/trailing yield|trailing dividend yield/i.test(preset.description)));
  });
});

test("running presets executes one existing screener call with exact AND rules and preserves missing observations", async () => {
  reset();
  await withClient(async client => {
    const missingName = await call(client, "screen_stock_presets", { action: "run" });
    assert.equal(missingName.isError, true);
    assert.equal(requests.length, 0);
    const result = await call(client, "screen_stock_presets", { action: "run", preset: "growth_and_cashflow", countries: ["Germany"], limit: 1 });
    const data = result.structuredContent;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url.pathname, "/api/screener/filter");
    assert.equal(requests[0].url.searchParams.get("includeInactive"), "false");
    assert.equal(requests[0].url.searchParams.get("sortBy"), "revenueGrowthPct");
    assert.equal(requests[0].body.includeSecondary, false);
    assert.deepEqual(requests[0].body.countries, ["Germany"]);
    assert.ok(requests[0].body.rules.every(rule => rule.groupId === 1));
    assert.ok(requests[0].body.rules.some(rule => rule.metric === "epsGrowthPct" && rule.value === "10"));
    assert.equal(data.coverage.totalMatches, null);
    assert.equal(data.coverage.evaluatedCount, null);
    assert.equal(data.coverage.resultLimitReached, true);
    assert.deepEqual(data.results[0].growthObservationsNewestFirst.revenuePct, [null, null]);
    assert.deepEqual(data.results[0].growthObservationsNewestFirst.epsPct, [50, 100]);
    assert.equal(data.results[0].reportingCurrency, null);
    assert.equal(data.continuation.tool, "screen_stocks");
    assert.deepEqual(data.continuation.arguments.rules, requests[0].body.rules);
  });
});

test("screen_stocks lists every preset without reads and executes exactly the disclosed rules and sorting", async () => {
  reset();
  await withClient(async client => {
    const listed = (await call(client, "screen_stocks", { action: "list_presets" })).structuredContent;
    assert.equal(listed.action, "list_presets");
    assert.equal(requests.length, 0);
    const legacy = (await call(client, "screen_stock_presets", {})).structuredContent;
    assert.deepEqual(listed.presets, legacy.presets);
    assert.deepEqual(listed.methodology, legacy.methodology);
    assert.equal(requests.length, 0);

    for (const preset of listed.presets) {
      reset();
      const result = await call(client, "screen_stocks", { preset: preset.key });
      assert.equal(result.isError, undefined, preset.key);
      const data = result.structuredContent;
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url.pathname, "/api/screener/filter");
      assert.equal(requests[0].url.searchParams.get("sortBy"), preset.sortBy);
      assert.equal(requests[0].url.searchParams.get("order"), preset.order);
      assert.equal(requests[0].url.searchParams.get("limit"), "20");
      assert.equal(requests[0].url.searchParams.get("includeInactive"), "false");
      assert.equal(requests[0].body.lookbackMode, "annual");
      assert.equal(requests[0].body.lookback, 3);
      assert.equal(requests[0].body.includeSecondary, false);
      assert.deepEqual(requests[0].body.rules.map(({ id, ...rule }) => rule), preset.rules);
      assert.equal(data.preset.key, preset.key);
      assert.deepEqual(data.query.rules, requests[0].body.rules);
      assert.equal(data.coverage.completeUniverse, false);
      assert.equal(data.coverage.totalMatches, null);
      assert.equal(data.results[0].reportingCurrency, null);
      assert.deepEqual(data.results[0].growthObservationsNewestFirst.revenuePct, [null, null]);
      assert.ok(data.warnings.some(warning => /fiscal periods, source timestamps and reporting currencies/.test(warning)));
    }
  });
});

test("screen_stocks validates incompatible preset controls before any metered request", async () => {
  reset();
  await withClient(async client => {
    for (const controls of [
      { rules: [] },
      { rules: [{ metric: "peRatio", value: 5 }] },
      { minMarketCap: 0 },
      { lookbackMode: "quarterly" },
      { mode: "quarterly" },
      { includeSecondary: true },
      { includeInactive: true },
      { sortBy: "marketCap" },
      { order: "desc" },
      { lookback: 1 },
      { periods: 11 },
      { limit: 51 },
    ]) {
      const result = await call(client, "screen_stocks", { preset: "profitable_value", ...controls });
      assert.equal(result.isError, true, JSON.stringify(controls));
      assert.equal(requests.length, 0, JSON.stringify(controls));
    }
    const unknown = await call(client, "screen_stocks", { preset: "unknown" });
    assert.equal(unknown.isError, true);
    assert.equal(requests.length, 0);
    const result = await call(client, "screen_stocks", { action: "run", preset: "profitable_value",
      country: "Germany", lookback: 5, limit: 1, sortBy: "peRatio", order: "asc" });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.countries, ["Germany"]);
    assert.equal(requests[0].body.lookback, 5);
    assert.equal(result.structuredContent.coverage.resultLimitReached, true);
  });
});

test("custom screen defaults and rule-group controls remain available alongside presets", async () => {
  reset();
  await withClient(async client => {
    const defaultResult = await call(client, "screen_stocks", {});
    assert.equal(defaultResult.isError, undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.rules, []);
    assert.equal(requests[0].body.lookbackMode, "annual");
    assert.equal(requests[0].body.lookback, 3);
    assert.equal(requests[0].body.includeSecondary, false);
    assert.equal(requests[0].url.searchParams.get("sortBy"), "marketCap");
    assert.equal(requests[0].url.searchParams.get("order"), "desc");
    assert.equal(requests[0].url.searchParams.get("limit"), "25");
    reset();
    const custom = await call(client, "screen_stocks", { action: "run", mode: "quarterly", periods: 8,
      rules: [{ metric: "peRatio", operator: "<=", value: 15, groupId: 1 },
        { metric: "dividendYield", operator: ">=", value: 3, groupId: 2 }],
      minMarketCap: 1_000_000_000, includeSecondary: true, includeInactive: true,
      sortBy: "revenueGrowth", limit: 100 });
    assert.equal(custom.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.lookbackMode, "quarterly");
    assert.equal(requests[0].body.lookback, 8);
    assert.equal(requests[0].body.rules.length, 4);
    assert.equal(requests[0].body.includeSecondary, true);
    assert.equal(requests[0].url.searchParams.get("includeInactive"), "true");
    assert.equal(requests[0].url.searchParams.get("sortBy"), "revenueGrowthPct");
    assert.equal(requests[0].url.searchParams.get("limit"), "100");
    assert.equal(JSON.parse(custom.content[0].text).returned, 1);
  });
});

test("peer discovery excludes same issuers, share classes, secondaries and wrong classification", async () => {
  reset();
  await withClient(async client => {
    const result = await call(client, "find_stock_peers", { ticker: "ACME" });
    const data = result.structuredContent;
    assert.equal(data.selection.effectiveMatchBy, "industry");
    assert.deepEqual(data.peers.map(row => row.ticker), ["ALPHA", "ZETA", "BETA"]);
    assert.equal(data.coverage.duplicateIssuerExclusions, 4);
    assert.deepEqual(data.comparison.arguments.tickers, ["ACME", "ALPHA", "ZETA", "BETA"]);
    assert.equal(data.peers[1].storedMetrics.marketCapCurrency, null);
    assert.equal(data.peers[1].storedMetrics.asOfDate, null);
    assert.match(data.selection.order, /not ranked/);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.searchParams.get("industry"), "Software");
    assert.equal(requests[1].url.searchParams.get("includeSecondary"), "false");
    assert.equal(requests.some(entry => entry.url.pathname.includes("/build")), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 240 * 1024);
  });
});

test("peer country filters, classification fallback and empty results are explicit", async () => {
  reset();
  await withClient(async client => {
    const sameCountry = await call(client, "find_stock_peers", { ticker: "ACME", sameCountryOnly: true });
    assert.deepEqual(sameCountry.structuredContent.peers.map(row => row.ticker), ["ALPHA", "ZETA"]);
    assert.equal(requests[1].url.searchParams.get("country"), "United States");
    reset("no-industry");
    const fallback = await call(client, "find_stock_peers", { ticker: "ACME" });
    assert.equal(fallback.structuredContent.selection.effectiveMatchBy, "sector");
    reset("empty-peers");
    const empty = await call(client, "find_stock_peers", { ticker: "ACME" });
    assert.deepEqual(empty.structuredContent.peers, []);
    assert.equal(empty.structuredContent.comparison, null);
    assert.ok(empty.structuredContent.warnings.some(warning => /does not establish/.test(warning)));
  });
});

test("non-equities, scope errors and upstream failures fail closed without sensitive errors; a renamed ticker is followed openly", async () => {
  await withClient(async client => {
    reset("fund-subject");
    const fund = await call(client, "find_stock_peers", { ticker: "ACME" });
    assert.equal(fund.isError, true);
    assert.equal(requests.length, 1);
    // GET /api/stocks/{ticker} answers a retired ticker with its survivor's row, so a
    // different ticker coming back is followed as a rename, and the response says so.
    reset("wrong-identity");
    const renamed = await call(client, "find_stock_peers", { ticker: "ACME" });
    assert.equal(renamed.isError, undefined);
    assert.equal(renamed.structuredContent.ticker, "WRONG");
    assert.match(renamed.structuredContent.tickerResolution, /ACME is a retired ticker; its listing is now WRONG/);
    reset("bad-screen");
    assert.equal((await call(client, "screen_stock_presets", { action: "run", preset: "profitable_value" })).isError, true);
    reset("failure");
    for (const [name, args] of [["search_stocks", { query: "AAPL" }], ["screen_stocks", { preset: "dividend_income" }], ["screen_stock_presets", { action: "run", preset: "dividend_income" }], ["find_stock_peers", { ticker: "ACME" }]]) {
      const result = await call(client, name, args);
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /upstream-secret|private\.internal|127\.0\.0\.1/);
    }
    reset();
    for (const [name, callback] of callbacks) {
      const result = await runWithAuth({ token: "wrong-scope", scopes: [] }, () => callback({}));
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /read:market/);
    }
    assert.equal(requests.length, 0);
  });
});
