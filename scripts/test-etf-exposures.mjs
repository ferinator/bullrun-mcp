import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let upstream;
let registerGetEtfExposures;
let clearEtfPublicReadCache;
let createPublicReadCache;
let unknownAssetClass = false;
let requests = [];
let holdingsOverride = null;
let identityOverride = null;
let batchStatus = 200;
let tickerAliases = {};

const stocks = [
  { ticker: "HBM", company: "Hornbach Baumarkt AG", country: "Germany", sector: "Consumer Cyclical", exchange: "XETRA", currency: "EUR" },
  { ticker: "S19", company: "Sumitomo Metal Mining Co Ltd", country: "Japan", sector: "Basic Materials", exchange: "DU", currency: "EUR" },
];

const holding = (holdingSymbol, holdingName, holdingCountry, weightPct, extra = {}) => ({
  ticker: "COPPER", asOfDate: "2026-10-09", holdingKey: holdingSymbol,
  holdingSymbol, holdingName, holdingCountry, weightPct,
  holdingAssetClass: "Equity", source: "ISSUER_FIXTURE", currency: null, ...extra,
});

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: url.pathname, input });
    let body;
    if (url.pathname.endsWith("/profile")) {
      body = {
        ticker: "COPPER", fundName: "Copper fund", holdingsCount: 4,
        // Raw provider asset_class may contain a fund name, while its label is Equity.
        assetClass: "Copper fund UCITS ETF - USD Acc",
        assetClassLabel: unknownAssetClass ? null : "Equity", categoryLabel: null,
      };
    } else if (url.pathname.endsWith("/holdings")) {
      body = holdingsOverride ?? [
        // HBM is also a different German company; accepting it would invent EUR/retail exposure.
        holding("HBM", "Hudbay Minerals Inc", "Canada", 60),
        // The right company on a German secondary venue still cannot supply its currency exposure.
        holding("S19", "Sumitomo Metal Mining Co Ltd", "Japan", 25),
        holding("A", "Another Miner Inc", "Canada", 10, { holdingSector: "Materials" }),
        holding("USD", "US Dollar", "US", 5, { holdingAssetClass: "Cash", currency: "USD" }),
      ];
    } else if (url.pathname === "/api/stocks/identity-batch") {
      if (batchStatus !== 200) {
        res.writeHead(batchStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture failure" }));
        return;
      }
      const rows = identityOverride ?? stocks;
      body = {
        isinMatches: Object.fromEntries(input.isins.map(isin => [isin, rows.filter(row => row.isin === isin)])),
        tickerMatches: Object.fromEntries(input.tickers.map(ticker => [ticker, tickerAliases[ticker] ?? rows.find(row => row.ticker === ticker) ?? null])),
      };
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
  ({ registerGetEtfExposures } = await import("../dist/tools/getEtfExposures.js"));
  ({ clearEtfPublicReadCache, createPublicReadCache } = await import("../dist/tools/etfPublicReads.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

beforeEach(() => {
  unknownAssetClass = false;
  holdingsOverride = null;
  identityOverride = null;
  batchStatus = 200;
  tickerAliases = {};
  requests = [];
  clearEtfPublicReadCache();
});

async function withClient(run) {
  const server = new McpServer({ name: "etf-exposures-test", version: "1" });
  registerGetEtfExposures(server);
  const client = new Client({ name: "etf-exposures-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

async function exposures(client, args = {}) {
  const result = await client.callTool({ name: "get_etf_exposures", arguments: { ticker: "COPPER", ...args } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}

test("symbol collisions and foreign secondary currencies cannot invent mining-fund exposures", async () => {
  await withClient(async client => {
    const result = await exposures(client);
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [
      ["Unclassified", 60], ["Basic Materials", 35], ["Cash & derivatives", 5],
    ]);
    assert.deepEqual(result.exposures.currency.map(row => [row.name, row.weightPct]), [
      ["CAD", 70], ["JPY", 25], ["USD", 5],
    ]);
    assert.deepEqual(result.coverage.currencyBasisWeightPct, {
      reported: 5, homeListing: 0, countryCurrency: 95, notReported: 0,
    });
    assert.equal(result.coverage.bucketCoverage.sector.totalWeightPct, 100);
    assert.equal(result.coverage.bucketCoverage.currency.totalWeightPct, 100);
    assert.equal(result.coverage.bucketCoverage.country.totalWeightPct, 95, "country excludes the disclosed 5% cash");
    assert.ok(result.warnings.some(warning => /currency shown is inferred/.test(warning)));
  });
});

test("asset exposure uses the normalized profile label and keeps an unknown label unavailable", async () => {
  await withClient(async client => {
    const result = await exposures(client, { types: ["asset"] });
    assert.deepEqual(result.exposures.asset, [{ name: "Equity", weightPct: 100, methodology: "fund_profile_classification" }]);
    assert.deepEqual(requests.map(request => request.path), ["/api/etfs/COPPER/profile"]);
    assert.equal(result.coverage.holdingsLoaded, false);
    assert.equal(result.coverage.storedHoldingRows, null);
    assert.equal(result.coverage.lookThroughWeightPct, null);
    assert.ok(!result.warnings.some(warning => /Holdings are partial/.test(warning)));
    unknownAssetClass = true;
    clearEtfPublicReadCache();
    const missing = await exposures(client, { types: ["asset"] });
    assert.deepEqual(missing.exposures.asset, []);
    assert.deepEqual(missing.unavailableTypes, ["asset"]);
  });
});

test("unsupported factor and thematic types require no backend reads", async () => {
  await withClient(async client => {
    const result = await exposures(client, { types: ["factor", "thematic"] });
    assert.deepEqual(result.unavailableTypes, ["factor", "thematic"]);
    assert.deepEqual(result.exposures, { factor: [], thematic: [] });
    assert.equal(result.coverage.holdingsLoaded, false);
    assert.equal(result.coverage.classifiedWeightPct.sector, null);
    assert.equal(result.warnings.length, 2);
    assert.equal(requests.length, 0);
  });
});

test("country and reported-currency requests do not resolve missing unrelated sectors", async () => {
  await withClient(async client => {
    const country = await exposures(client, { types: ["country"] });
    assert.equal(requests.filter(request => request.path === "/api/stocks/identity-batch").length, 0);
    holdingsOverride = [holding("UNKNOWN", "Unknown company", null, 100, { holdingSector: "Materials" })];
    clearEtfPublicReadCache();
    requests = [];
    const sector = await exposures(client, { types: ["sector"] });
    assert.deepEqual(sector.exposures.sector.map(row => [row.name, row.weightPct]), [["Basic Materials", 100]]);
    assert.equal(requests.filter(request => request.path === "/api/stocks/identity-batch").length, 0);
    assert.deepEqual(country.exposures.country.map(row => [row.name, row.weightPct]), [["Canada", 70], ["Japan", 25]]);
    holdingsOverride = [holding("UNKNOWN", "Unknown company", null, 100, { currency: "CHF" })];
    clearEtfPublicReadCache();
    requests = [];
    const currency = await exposures(client, { types: ["currency"] });
    assert.deepEqual(currency.exposures.currency.map(row => [row.name, row.weightPct]), [["CHF", 100]]);
    assert.equal(requests.filter(request => request.path === "/api/stocks/identity-batch").length, 0);
  });
});

test("hundreds of repeated holdings share one exact identity query and retain every row's weight", async () => {
  const isin = "JP3402600005";
  holdingsOverride = Array.from({ length: 300 }, (_, index) => holding("S19", "Sumitomo Metal Mining Co Ltd", "Japan", 0.3,
    { holdingKey: `ROW-${index}`, holdingIsin: isin }));
  identityOverride = [
    { ...stocks[1], isin, primaryTicker: "5713.T" },
    { ...stocks[1], ticker: "5713.T", isin, primaryTicker: null, exchange: "TSE", currency: "JPY" },
  ];
  await withClient(async client => {
    const result = await exposures(client);
    assert.equal(requests.length, 3, "holdings, profile and one bounded identity batch");
    const batch = requests.find(request => request.path === "/api/stocks/identity-batch").input;
    assert.deepEqual(batch.isins, [isin]);
    assert.deepEqual(batch.tickers, ["S19"]);
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [["Basic Materials", 90]]);
    assert.deepEqual(result.exposures.currency.map(row => [row.name, row.weightPct]), [["JPY", 90]]);
    assert.equal(result.coverage.storedHoldingRows, 300);
    assert.equal(result.coverage.currencyBasisWeightPct.homeListing, 90);
    assert.ok(!result.warnings.some(warning => /lookup cap/.test(warning)));
    const repeated = await exposures(client);
    assert.deepEqual(repeated, result);
    assert.equal(requests.length, 3, "repeated analysis reuses only public reads within the short TTL");
  });
});

test("identity batching remains capped by distinct identities and reports weight left unresolved", async () => {
  holdingsOverride = Array.from({ length: 160 }, (_, index) => holding(`MINE${index}`, `Miner ${index}`, "Canada", 0.625));
  identityOverride = holdingsOverride.map(row => ({ ticker: row.holdingSymbol, company: row.holdingName, country: "Canada",
    sector: "Basic Materials", exchange: "TSX", currency: "CAD" }));
  await withClient(async client => {
    const result = await exposures(client, { types: ["sector"] });
    const batch = requests.find(request => request.path === "/api/stocks/identity-batch").input;
    assert.equal(batch.tickers.length, 150);
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [["Basic Materials", 93.75], ["Unclassified", 6.25]]);
    assert.ok(result.warnings.some(warning => /^10 .*distinct-identity lookup cap/.test(warning)));
  });
});

test("a retired ticker alias is not accepted as an exact symbol holding identity", async () => {
  holdingsOverride = [holding("OLD", "New Mining Company", "Canada", 100)];
  tickerAliases = { OLD: { ticker: "NEW", company: "New Mining Company", country: "Canada", sector: "Basic Materials", exchange: "TSX", currency: "CAD" } };
  await withClient(async client => {
    const result = await exposures(client, { types: ["sector"] });
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [["Unclassified", 100]]);
  });
});

test("unsupported provider symbols are omitted without making the whole batch fail", async () => {
  holdingsOverride = [holding("???", "Unknown miner", "Canada", 75), holding("S19", "Sumitomo Metal Mining Co Ltd", "Japan", 25)];
  await withClient(async client => {
    const result = await exposures(client, { types: ["sector"] });
    const batch = requests.find(request => request.path === "/api/stocks/identity-batch").input;
    assert.deepEqual(batch.tickers, ["S19"]);
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [["Unclassified", 75], ["Basic Materials", 25]]);
    assert.equal(result.coverage.lookupFailures, undefined);
  });
});

test("a failed identity batch is retried and never cached as missing classification", async () => {
  await withClient(async client => {
    batchStatus = 503;
    const failed = await exposures(client, { types: ["sector"] });
    assert.equal(failed.coverage.lookupFailures.weightPct, 85);
    assert.ok(failed.exposures.sector.some(row => row.name === "Not loaded (lookup failed)"));
    batchStatus = 200;
    const healthy = await exposures(client, { types: ["sector"] });
    assert.equal(healthy.coverage.lookupFailures, undefined);
    assert.equal(requests.filter(request => request.path === "/api/stocks/identity-batch").length, 2);
  });
});

test("the public-data cache coalesces concurrent reads, isolates consumers, expires and retries failures", async () => {
  let now = 0;
  let reads = 0;
  const cache = createPublicReadCache(2, () => now);
  const load = async () => { reads++; return { rows: ["unchanged"] }; };
  const [first, second] = await Promise.all([cache.read("public", 10, load), cache.read("public", 10, load)]);
  assert.equal(reads, 1);
  first.rows.push("caller-only");
  assert.deepEqual(second.rows, ["unchanged"]);
  assert.deepEqual((await cache.read("public", 10, load)).rows, ["unchanged"]);
  now = 11;
  await cache.read("public", 10, load);
  assert.equal(reads, 2);
  await assert.rejects(cache.read("error", 10, async () => { throw new Error("upstream unavailable"); }));
  assert.deepEqual(await cache.read("error", 10, load), { rows: ["unchanged"] });
  assert.equal(reads, 3);
  const [refused, admitted] = await Promise.allSettled([
    cache.read("separate-leases", 10, async () => { throw new Error("operation-a capacity refused"); }, "a"),
    cache.read("separate-leases", 10, async () => ({ rows: ["operation-b"] }), "b"),
  ]);
  assert.equal(refused.status, "rejected");
  assert.deepEqual(admitted, { status: "fulfilled", value: { rows: ["operation-b"] } });
});

test("a bucket limit explicitly accounts for all omitted exposure weight", async () => {
  await withClient(async client => {
    const result = await exposures(client, { types: ["sector", "country", "currency"], limitPerType: 1 });
    assert.deepEqual(result.coverage.bucketCoverage.sector, {
      totalBuckets: 3, returnedBuckets: 1, totalWeightPct: 100, returnedWeightPct: 60, omittedWeightPct: 40,
    });
    assert.equal(result.coverage.bucketCoverage.country.omittedWeightPct, 25);
    assert.equal(result.coverage.bucketCoverage.currency.omittedWeightPct, 30);
    assert.equal(result.exposures.sector.length, 1);
    assert.equal(result.warnings.filter(warning => /because of limitPerType/.test(warning)).length, 3);
  });
});

test("the advertised contract discloses inferred currencies and the country denominator", async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    const { description } = tools.find(tool => tool.name === "get_etf_exposures");
    assert.match(description, /explicitly disclosed estimate/);
    assert.match(description, /country covers securities and excludes cash and derivatives/);
    assert.doesNotMatch(description, /reported currency only/);
  });
});
