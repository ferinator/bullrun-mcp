import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

let upstream;
let registerCompareStocks;
let runWithAuth;
let capturedCallback;
let mode = "normal";
let active = 0;
let maxActive = 0;
let requests = [];

function identity(ticker, currency = "USD") {
  return { ticker, company: `Company ${ticker}`, currency, quoteType: "EQUITY", exchange: "LOCAL", sector: "Technology", primaryTicker: null };
}

function financial(ticker, fiscalYear, changes = {}) {
  return { ticker, fiscalYear, fiscalQuarter: 0, sourceCurrency: "USD", reportingScale: 1_000_000,
    revenue: 200, grossProfit: 100, operatingIncome: 40, netIncome: 20, pretaxIncome: 40, taxProvision: 10,
    operatingCashflow: 30, freeCashflow: 25, totalDebt: 100, cashAndCashEquivalents: 20,
    totalAssets: 250, stockholdersEquity: 100, dilutedEps: 2, ...changes };
}

function responseFor(url) {
  const parts = url.pathname.split("/");
  const ticker = url.searchParams.get("ticker") ?? decodeURIComponent(parts[3] ?? "");
  if (mode === "all-failed") return { status: 503, body: { error: "upstream unavailable" } };
  if (mode === "identity-only" && parts[2] !== "stocks") return { body: [] };
  if (ticker === "NONE") {
    if (parts[2] === "stocks") return { status: 404, body: { error: "No such symbol" } };
    if (parts[2] === "ml-scores") return { body: { results: {} } };
    if (parts[2] === "company-intelligence") return { body: { dials: { ticker, dials: [], composite: null } } };
    return { body: [] };
  }
  if (parts[2] === "stocks") {
    if (mode === "wrong-identity" && ticker === "AAA") return { body: identity("AAAA") };
    if (mode === "all-etfs" || mode === "etf" && ticker === "AAA") return { body: { ...identity(ticker), quoteType: "ETF" } };
    return { body: identity(ticker, ticker === "BBB" ? "GBX" : "USD") };
  }
  if (parts[2] === "financials") {
    if (mode === "quarterly" && ticker === "AAA") return { body: [financial(ticker, 2026, { fiscalQuarter: 1 })] };
    if (mode === "zero-denominators" && ticker === "AAA") return { body: [financial(ticker, 2025, {
      revenue: 0, netIncome: -4, totalAssets: 0, stockholdersEquity: -10, cashAndCashEquivalents: null,
    })] };
    if (mode === "growth-currency" && ticker === "AAA") return { body: [
      financial(ticker, 2025), financial(ticker, 2024, { sourceCurrency: "EUR", revenue: 100 }),
    ] };
    if (mode === "growth-gap" && ticker === "AAA") return { body: [financial(ticker, 2025), financial(ticker, 2023, { revenue: 100 })] };
    return { body: ticker === "BBB"
      ? [financial(ticker, 2024, { sourceCurrency: "GBP", revenue: 500 }), financial(ticker, 2023, { sourceCurrency: "GBP", revenue: 400 })]
      : [financial(ticker, 2027, { revenue: null, netIncome: null, operatingIncome: null, operatingCashflow: null, freeCashflow: null }),
        financial(ticker, 2026, { fiscalQuarter: 1, revenue: 999 }), financial(ticker, 2025), financial(ticker, 2024, { revenue: 100 })] };
  }
  if (parts[2] === "prices") return { body: [{ ticker, tradeDate: "2026-10-16", closePrice: 123 }] };
  if (parts[2] === "valuations") {
    if (mode === "failure" && ticker === "BBB") return { status: 503, body: { error: "sensitive upstream details" } };
    return { body: [{ ticker, tradeDate: "2026-10-15", marketCap: 1_000_000, peRatio: 20, dividendYield: 2.5 }] };
  }
  if (parts[2] === "ml-scores") return { body: { results: {
    valuation: { ticker, asOfDate: "2026-10-15", predicted: 0.2, percentile: 0.8, currentMultiple: 20, fiscalPeriod: "FY2025 Q4", dataQuality: "partial" },
  } } };
  if (parts[2] === "company-intelligence") return { body: { dials: {
    ticker, asOfDate: "2026-10-14", formulaVersion: "v1", composite: null,
    dials: [{ key: "LEVERAGE", score: null, state: "NO_READING", waitingOn: "Financial history" }],
  } } };
  return { status: 404, body: {} };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    requests.push(new URL(req.url, "http://upstream.test"));
    try {
      const url = new URL(req.url, "http://upstream.test");
      if (mode === "timeout" && url.pathname === "/api/financials/AAA") {
        await new Promise(resolve => setTimeout(resolve, 800));
      } else await new Promise(resolve => setTimeout(resolve, 10));
      const reply = responseFor(url);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    } finally { active--; }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  process.env.BULLRUN_API_TIMEOUT_MS = "300";
  ({ registerCompareStocks } = await import("../dist/tools/compareStocks.js"));
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  registerCompareStocks({ registerTool(_name, _definition, callback) { capturedCallback = callback; } });
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function withClient(run) {
  const server = new McpServer({ name: "compare-stock-test", version: "1" });
  registerCompareStocks(server);
  const client = new Client({ name: "compare-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

function reset(nextMode = "normal") {
  mode = nextMode;
  requests = [];
  maxActive = 0;
}

test("SDK schema, annual periods, units, growth and model context remain explicit", async () => {
  reset();
  await withClient(async client => {
    const definitions = await client.listTools();
    const definition = definitions.tools.find(tool => tool.name === "compare_stocks");
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.inputSchema.properties.tickers.maxItems, 5);
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: [" aaa ", "BBB"] } });
    assert.equal(result.isError, undefined);
    assert.equal(CallToolResultSchema.safeParse(result).success, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const payload = result.structuredContent;
    assert.deepEqual(payload.tickers, ["AAA", "BBB"]);
    const [aaa, bbb] = payload.rows;
    assert.equal(aaa.fundamentals.annual.basis.fiscalYear, 2025);
    assert.equal(aaa.fundamentals.annual.revenue, 200, "reportingScale must not be applied to absolute API amounts");
    assert.equal(aaa.fundamentals.annual.revenueGrowthYoyPct, 100);
    assert.equal(bbb.fundamentals.annual.revenueGrowthYoyPct, 25);
    assert.equal(bbb.identity.quoteCurrency, "GBX");
    assert.equal(bbb.fundamentals.annual.basis.reportingCurrency, "GBP");
    assert.equal(bbb.fundamentals.latestPrice.close, 123, "native quote price is not silently rescaled");
    assert.equal(aaa.quality.operatingMarginPct, 20);
    assert.equal(aaa.quality.roePct, 20);
    assert.equal(aaa.quality.roicPct, 16.67);
    assert.equal(aaa.quality.operatingCashflowToNetIncome, 1.5);
    assert.equal(aaa.quality.accrualsPctOfAssets, -4);
    assert.equal(aaa.valuation.latest.dividendYieldPct, 2.5, "stored percentage must not be multiplied again");
    assert.equal(aaa.valuation.latest.marketCapCurrency, null);
    assert.equal(aaa.valuation.models[0].valuationGapPct, 20);
    assert.equal(aaa.valuation.models[0].modelTypicalPe, 24);
    assert.equal(aaa.valuation.models[0].asOfDate, "2026-10-15");
    assert.equal(payload.coverage[0].measuredRisk, false);
    assert.ok(payload.warnings.some(warning => /unmeasured/.test(warning)));
    assert.ok(payload.warnings.some(warning => /fiscal years differ/.test(warning)));
    assert.ok(payload.warnings.some(warning => /partial financial history/.test(warning)));
    assert.equal(Object.hasOwn(payload, "leaders"), false);
    assert.equal(requests.length, 12);
    assert.ok(maxActive <= 6);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024);
  });
});

test("selected modules bound fanout, normalized duplicates do not trigger duplicate reads", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "aaa", "BBB", "CCC", "DDD"], include: ["quality", "quality"] } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.requestedModules, ["quality"]);
    assert.equal(result.structuredContent.rows.length, 4);
    assert.equal(requests.length, 8);
    assert.ok(maxActive <= 6 && maxActive > 1);
    assert.ok(requests.every(url => /^\/api\/(stocks|financials)\//.test(url.pathname)));
    assert.equal(Object.hasOwn(result.structuredContent.rows[0], "valuation"), false);
    assert.equal(result.structuredContent.coverage[0].priceAvailable, null, "unrequested coverage is unknown rather than absent");
  });
});

test("maximal comparison remains bounded to thirty upstream reads and six concurrent reads", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB", "CCC", "DDD", "EEE"] } });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 30);
    assert.ok(maxActive <= 6 && maxActive > 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024);
  });
});

test("invalid ticker counts, blanks and modules are rejected before any upstream requests", async () => {
  reset();
  await withClient(async client => {
    for (const arguments_ of [
      { tickers: ["AAA"] }, { tickers: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] },
      { tickers: ["AAA", " "] }, { tickers: ["AAA", "BBB"], include: ["bogus"] },
      { tickers: ["AAA", "aaa"] },
    ]) {
      const result = await client.callTool({ name: "compare_stocks", arguments: arguments_ });
      assert.equal(result.isError, true);
    }
    assert.equal(requests.length, 0);
  });
});

test("financial gaps, currency changes and zero/negative denominators are never fabricated", async () => {
  await withClient(async client => {
    for (const nextMode of ["growth-currency", "growth-gap"]) {
      reset(nextMode);
      const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["fundamentals"] } });
      assert.equal(result.structuredContent.rows[0].fundamentals.annual.revenueGrowthYoyPct, null);
      assert.ok(result.structuredContent.warnings.some(warning => /annual YoY growth unavailable/.test(warning)));
    }
    reset("zero-denominators");
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["quality"] } });
    const quality = result.structuredContent.rows[0].quality;
    for (const metric of ["operatingMarginPct", "roePct", "roaPct", "roicPct", "operatingCashflowToNetIncome", "debtToEquity"]) {
      assert.equal(quality[metric], null, metric);
    }
  });
});

test("quarterly-only, unknown and wrong-identity tickers preserve explicit missing coverage", async () => {
  await withClient(async client => {
    reset("quarterly");
    const partial = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "NONE"], include: ["quality"] } });
    assert.equal(partial.structuredContent.rows[0].quality, null);
    assert.equal(partial.structuredContent.rows[0].status, "partial");
    assert.equal(partial.structuredContent.rows[1].status, "unavailable");
    assert.equal(partial.isError, true, "identity and quarterly rows alone cannot satisfy annual quality research");
    assert.ok(partial.structuredContent.warnings.some(warning => /quarterly rows were not substituted/.test(warning)));
    // GET /api/stocks/AAA answering with AAAA's row is how the API reports a retired
    // ticker: the comparison follows the survivor and says so.
    reset("wrong-identity");
    const renamed = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["quality"] } });
    assert.deepEqual(renamed.structuredContent.tickers, ["AAAA", "BBB"]);
    assert.equal(renamed.structuredContent.coverage[0].identityAvailable, true);
    assert.ok(renamed.structuredContent.warnings.some(warning => /AAA is a retired ticker; its listing is now AAAA/.test(warning)));
    reset("etf");
    const etf = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["quality"] } });
    assert.equal(etf.structuredContent.rows[0].status, "unsupported_instrument");
    assert.equal(etf.structuredContent.rows[0].quality, null);
  });
});

test("one failed source preserves other rows and does not expose upstream error bodies", async () => {
  reset("failure");
  await withClient(async client => {
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["valuation"] } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.rows[0].valuation.latest.peRatio, 20);
    assert.equal(result.structuredContent.rows[1].valuation.latest, null);
    assert.equal(result.structuredContent.coverage[1].endpoints.valuation, "unavailable");
    assert.equal(result.structuredContent.rows[1].status, "partial");
    assert.equal(JSON.stringify(result).includes("sensitive upstream details"), false);
  });
});

test("empty, unsupported and fully failed comparisons return errors with diagnostic coverage", async () => {
  await withClient(async client => {
    for (const nextMode of ["all-failed", "all-etfs", "identity-only"]) {
      reset(nextMode);
      const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["quality"] } });
      assert.equal(result.isError, true, nextMode);
      assert.equal(result.structuredContent.coverage.length, 2);
      assert.ok(result.structuredContent.warnings.some(warning => /No useful requested stock metrics/.test(warning)));
    }
    reset();
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["NONE", "MISSING"], include: ["risk"] } });
    assert.equal(result.isError, true, "known identities with only dark dials are no useful risk data");
    assert.equal(result.structuredContent.coverage.length, 2);
  });
});

test("upstream timeout returns partial comparison within the configured deadline", async () => {
  reset("timeout");
  await withClient(async client => {
    const started = Date.now();
    const result = await client.callTool({ name: "compare_stocks", arguments: { tickers: ["AAA", "BBB"], include: ["quality"] } });
    assert.ok(Date.now() - started < 750);
    assert.equal(result.structuredContent.rows[0].quality, null);
    assert.equal(result.structuredContent.coverage[0].endpoints.financials, "unavailable");
    assert.equal(result.structuredContent.rows[1].quality.roePct, 20);
  });
  // Let the mock finish before changing its response mode for subsequent tests.
  await new Promise(resolve => setTimeout(resolve, 550));
});

test("public-market scope is checked before starting fanout", async () => {
  reset();
  const result = await runWithAuth({ token: "fixture", scopes: ["read:portfolios"] }, () =>
    capturedCallback({ tickers: ["AAA", "BBB"], include: ["quality"] }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read:market/);
  assert.equal(requests.length, 0);
});
