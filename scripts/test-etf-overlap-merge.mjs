import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let upstream;
let registerCompareEtfs;
let registerAnalyzeEtfOverlap;
let requests = [];
let mode = "normal";

const identity = ticker => ({
  ticker, company: `Fund ${ticker}`, exchange: "LOCAL", currency: "USD",
  sector: "Equity", industry: "Global", country: "Ireland", primaryTicker: null,
});
const profile = ticker => ({
  ticker, fundName: `Fund ${ticker}`, fundFamily: "Fixture", assetClass: "Equity",
  category: "Global", totalAssets: 1_000_000, expenseRatio: 0.002,
  yieldTtm: 0.01, holdingsCount: ticker === "BBB" && mode === "partial" ? 40
    : ticker === "BBB" && mode === "no-shared" ? 1 : 4,
  sourceUpdatedAt: "2026-10-17T12:00:00Z",
});
const holding = (ticker, symbol, name, isin, weightPct, extra = {}) => ({
  ticker, asOfDate: ticker === "AAA" ? "2026-10-15" : "2026-10-16",
  holdingKey: symbol, holdingSymbol: symbol, holdingName: name, holdingIsin: isin,
  holdingCountry: "US", holdingAssetClass: "Equity", weightPct,
  source: "ISSUER_FIXTURE", ...extra,
});

function holdings(ticker) {
  if (ticker === "BBB" && mode === "missing") return [];
  if (ticker === "BBB" && mode === "partial") {
    return [holding(ticker, "DIFFERENT-VENUE", "Alpha Inc", "US0000000001", 10)];
  }
  if (ticker === "BBB" && mode === "no-shared") {
    return [holding(ticker, "GAMMA", "Gamma Inc", "US0000000003", 100)];
  }
  return [
    holding(ticker, ticker === "AAA" ? "ALPHA" : "ALPHA.DE", "Alpha Inc", "US0000000001", ticker === "AAA" ? 60 : 40),
    holding(ticker, "BETA", "Beta Inc", "US0000000002", ticker === "AAA" ? 30 : 50),
    holding(ticker, "USD", "US Dollar", null, 5, { holdingAssetClass: "Cash" }),
    holding(ticker, "FUTURE", "INDEX FUTURE", null, 5, { holdingAssetClass: "Derivative" }),
  ];
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    requests.push(url);
    let body;
    const parts = url.pathname.split("/");
    const ticker = decodeURIComponent(parts[3] ?? "");
    if (url.pathname === "/api/etfs") body = mode === "holdings-only-data" ? [] : [identity(url.searchParams.get("search"))];
    else if (parts[2] === "prices") body = [{ ticker, tradeDate: "2026-10-16", closePrice: 100 }];
    else if (parts[4] === "profile") body = mode === "holdings-only-data" ? null : profile(ticker);
    else if (parts[4] === "holdings") {
      if (ticker === "BBB" && mode === "failed") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture unavailable" }));
        return;
      }
      body = holdings(ticker);
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerCompareEtfs } = await import("../dist/tools/compareEtfs.js"));
  ({ registerAnalyzeEtfOverlap } = await import("../dist/tools/analyzeEtfOverlap.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

beforeEach(() => {
  requests = [];
  mode = "normal";
});

async function withClient(run, legacy = false) {
  const server = new McpServer({ name: "etf-overlap-test", version: "1" });
  registerCompareEtfs(server);
  if (legacy) registerAnalyzeEtfOverlap(server);
  const client = new Client({ name: "etf-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

async function compare(client, args = {}) {
  const result = await client.callTool({ name: "compare_etfs", arguments: { tickers: [" aaa ", "BBB"], ...args } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

const countPath = suffix => requests.filter(url => url.pathname.endsWith(suffix)).length;
const priceCalls = () => requests.filter(url => url.pathname.startsWith("/api/prices/")).length;

test("the SDK advertises opt-in overlap while default comparison keeps its response and backend work", async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    const definition = tools.find(tool => tool.name === "compare_etfs");
    assert.ok(definition.inputSchema.properties.include.items.enum.includes("overlap"));
    assert.equal(definition.inputSchema.properties.topSharedLimit.default, 20);
    const result = await compare(client);
    assert.deepEqual(result.requestedModules, ["classification", "market", "fund_data", "costs", "income", "benchmark"]);
    assert.equal(Object.hasOwn(result, "overlap"), false);
    assert.equal(result.rows[0].expenseRatioPct, 0.2);
    assert.equal(result.rows[0].latestPrice, 100);
    assert.equal(result.rows[0].holdingsComplete, undefined);
    assert.equal(requests.length, 6, "two identities, two profiles and two prices remain the default");
    assert.equal(countPath("/holdings"), 0);
    assert.equal(priceCalls(), 2);
  });
});

test("holdings summaries do not automatically run overlap", async () => {
  await withClient(async client => {
    const result = await compare(client, { include: ["holdings"] });
    assert.equal(Object.hasOwn(result, "overlap"), false);
    assert.equal(result.rows[0].holdingsComplete, true);
    assert.equal(countPath("/holdings"), 2);
    assert.equal(priceCalls(), 0);
  });
});

test("overlap-only matches shared ISINs across symbols, excludes cash/derivatives and fetches no prices", async () => {
  await withClient(async client => {
    const result = await compare(client, { include: ["overlap"], topSharedLimit: 1 });
    const { overlap } = result;
    const [pair] = overlap.pairs;
    assert.deepEqual(result.tickers, ["AAA", "BBB"]);
    assert.equal(pair.available, true);
    assert.equal(pair.sharedHoldings, 2);
    assert.equal(pair.weightedOverlapPct, 70, "topSharedLimit does not truncate the calculation");
    assert.equal(pair.sharedWeightPctA, 90);
    assert.equal(pair.sharedWeightPctB, 90);
    assert.deepEqual(pair.matchedOn, { isin: 2 });
    assert.equal(pair.topShared.length, 1);
    assert.equal(pair.topShared[0].overlapWeightPct, 40);
    assert.equal(pair.topShared[0].matchedOn, "isin");
    assert.equal(overlap.coverage[0].asOfDate, "2026-10-15");
    assert.equal(overlap.coverage[1].asOfDate, "2026-10-16");
    assert.equal(overlap.coverage[0].cashAndDerivativesWeightPct, 10);
    assert.equal(overlap.coverage[0].distinctSecurities, 2);
    assert.equal(overlap.coverage[0].isComplete, true);
    assert.equal(overlap.methodology.snapshotSelection, "latest_stored_per_fund");
    assert.match(overlap.methodology.holdingMatch, /isin/);
    assert.match(overlap.methodology.excluded, /cash.*derivative/);
    assert.equal(requests.length, 6);
    assert.equal(countPath("/holdings"), 2);
    assert.equal(countPath("/profile"), 2);
    assert.equal(priceCalls(), 0);
  });
});

test("requesting holdings and overlap shares one snapshot/profile fetch per fund", async () => {
  await withClient(async client => {
    const result = await compare(client, { include: ["holdings", "overlap"] });
    assert.equal(result.rows[0].storedHoldings, 4);
    assert.equal(result.overlap.pairs[0].weightedOverlapPct, 70);
    assert.equal(countPath("/holdings"), 2);
    assert.equal(countPath("/profile"), 2);
    assert.equal(requests.length, 6);
    assert.equal(priceCalls(), 0);
  });
});

test("partial snapshots retain numeric lower bounds and both coverage warnings", async () => {
  mode = "partial";
  await withClient(async client => {
    const result = await compare(client, { include: ["overlap"] });
    assert.equal(result.overlap.pairs[0].available, true);
    assert.equal(result.overlap.pairs[0].weightedOverlapPct, 10);
    assert.equal(result.overlap.coverage[1].isComplete, false);
    assert.equal(result.overlap.coverage[1].reportedHoldingsCount, 40);
    assert.ok(result.overlap.warnings.some(warning => /lower bound/.test(warning)));
    assert.ok(result.warnings.some(warning => /lower bound/.test(warning)));
  });
});

test("stored holdings remain usable when identity and profile coverage are absent", async () => {
  mode = "holdings-only-data";
  await withClient(async client => {
    const result = await compare(client, { include: ["overlap"] });
    assert.equal(result.rows[0].found, true);
    assert.equal(result.coverage[0].identityAvailable, false);
    assert.equal(result.coverage[0].profileAvailable, false);
    assert.equal(result.overlap.pairs[0].available, true);
    assert.equal(result.overlap.pairs[0].weightedOverlapPct, 70);
    assert.equal(result.overlap.coverage[0].isComplete, null);
    assert.ok(result.warnings.some(warning => /lower bound/.test(warning)));
    assert.equal(priceCalls(), 0);
  });
});

for (const missingMode of ["missing", "failed"]) {
  test(`${missingMode} holdings make overlap unavailable instead of measured zero`, async () => {
    mode = missingMode;
    await withClient(async client => {
      const result = await compare(client, { include: ["overlap"] });
      const [pair] = result.overlap.pairs;
      assert.equal(pair.available, false);
      assert.equal(pair.sharedHoldings, null);
      assert.equal(pair.weightedOverlapPct, null);
      assert.equal(pair.sharedWeightPctA, null);
      assert.equal(pair.sharedWeightPctB, null);
      assert.deepEqual(pair.topShared, []);
      assert.equal(result.overlap.coverage[1].storedRows, 0);
      assert.equal(result.overlap.coverage[1].asOfDate, null);
      assert.ok(result.warnings.some(warning => /cannot be measured/.test(warning)));
      // A failed read is not a coverage answer and must not be reported as nothing stored.
      assert.equal(result.overlap.coverage[1].holdingsLoaded, missingMode === "missing");
      assert.equal(result.warnings.some(warning => /No stored holdings for BBB/.test(warning)), missingMode === "missing");
      assert.equal(result.warnings.some(warning => /Holdings for BBB could not be loaded.*not a coverage answer/.test(warning)), missingMode === "failed");
    });
  });
}

test("two stored snapshots with no shared securities still report a measured zero", async () => {
  mode = "no-shared";
  await withClient(async client => {
    const result = await compare(client, { include: ["overlap"] });
    const [pair] = result.overlap.pairs;
    assert.equal(pair.available, true);
    assert.equal(pair.sharedHoldings, 0);
    assert.equal(pair.weightedOverlapPct, 0);
    assert.equal(result.overlap.coverage[1].isComplete, true);
    assert.equal(result.overlap.warnings.length, 0);
  });
});

test("legacy overlap wrapper retains its output layout and numeric compatibility", async () => {
  await withClient(async client => {
    let result = await client.callTool({ name: "analyze_etf_overlap", arguments: { tickers: ["AAA", "BBB"] } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.pairs[0].weightedOverlapPct, 70);
    assert.equal(result.structuredContent.coverage[0].asOfDate, "2026-10-15");
    assert.match(result.structuredContent.methodology.holdingMatch, /isin/);
    assert.equal(requests.length, 4, "legacy wrapper still reads only holdings and profiles");
    mode = "missing";
    result = await client.callTool({ name: "analyze_etf_overlap", arguments: { tickers: ["AAA", "BBB"] } });
    assert.equal(result.structuredContent.pairs[0].weightedOverlapPct, 0);
    assert.equal(result.structuredContent.pairs[0].available, false);
    assert.ok(result.structuredContent.warnings.some(warning => /cannot be measured/.test(warning)));
    assert.equal(priceCalls(), 0);
  }, true);
});
