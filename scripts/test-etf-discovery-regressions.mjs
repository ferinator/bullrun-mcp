// Anya's ETF discovery review cases, exercised through registered MCP tools.
// Search ranking/issuer aliases live in the API (InstrumentSearchServiceTest);
// these stubs verify the MCP forwards the query and preserves that ordering.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const listing = (ticker, isin, extra = {}) => ({
  ticker, isin, company: ticker, exchange: "SW", currency: "CHF", country: "Ireland",
  sector: "Equity", industry: null, quoteType: "ETF", primaryTicker: null, ...extra,
});
const AI_ISIN = "IE000LCKJ888";
const COPPER_ISIN = "IE0003Z9E2Y3";
const COPPER = [
  listing("COPX", "US37954Y8306", { company: "Global X Copper Miners ETF", exchange: "NYSE ARCA", currency: "USD", country: "United States" }),
  listing("COPX.L", COPPER_ISIN, { fundIsin: COPPER_ISIN, company: "Global X Copper Miners UCITS ETF", exchange: "LSE", currency: "USD" }),
  listing("COPX.MI", COPPER_ISIN, { fundIsin: COPPER_ISIN, exchange: "ETFP", currency: "EUR" }),
  listing("COPX.SW", COPPER_ISIN, { fundIsin: COPPER_ISIN }),
];
const GOLD = ["ZGLD.SW", "ZGLDEU.SW", "ZGLDGB.SW", "ZGLDHC.SW", "ZGLDHE.SW", "ZGLDHG.SW", "ZGLDUS.SW"]
  .map((ticker, i) => listing(ticker, `CH000000000${i}`, { company: "Swisscanto (CH) Gold ETF", country: "Switzerland" }));
const VUSA = listing("VUSA.SW", "IE00B3XXRP09", { company: "Vanguard S&P 500 UCITS ETF" });
const SCREEN = [
  listing("WPAI.MI", AI_ISIN, { fundIsin: AI_ISIN, exchange: "ETFP", currency: "EUR", avgTurnover90d: 50, totalAssets: 200 }),
  listing("PAIW.DE", AI_ISIN, { fundIsin: AI_ISIN, exchange: "XETRA", currency: "EUR", avgTurnover90d: 300, totalAssets: 200 }),
  listing("WPAI.SW", AI_ISIN, { fundIsin: AI_ISIN, currency: "USD", avgTurnover90d: 100, totalAssets: 200 }),
  // A different share class is a distinct fund even when its name is identical.
  listing("OTHER.DE", "IE0000000001", { company: "WisdomTree Physical AI", avgTurnover90d: 400, totalAssets: 100 }),
];

let upstream;
let registrations;
let requests = [];
let truncated = false;

function reply(url, body) {
  if (url.pathname === "/api/etfs/screener") {
    const rows = SCREEN.filter(row => (!body.exchange || row.exchange === body.exchange)
      && (!body.currency || row.currency === body.currency));
    return { body: { rows, evaluatedCount: 1000, matchCount: truncated ? 500 : rows.length, truncated } };
  }
  if (url.pathname === "/api/etfs") {
    const search = url.searchParams.get("search");
    const rows = search === "COPX" ? COPPER
      : search === "COPX.L" ? [COPPER[1]]
      : search === "VUSA.SW" ? [VUSA]
      : search === "ZGLD" || search === "ZKB Gold" ? GOLD : [];
    return { body: rows.slice(0, Number(url.searchParams.get("limit") ?? 100)) };
  }
  const profile = /^\/api\/etfs\/([^/]+)\/profile$/.exec(url.pathname);
  if (profile) {
    const ticker = decodeURIComponent(profile[1]);
    const row = [...COPPER, ...GOLD, VUSA].find(candidate => candidate.ticker === ticker);
    if (!row) return { status: 404, body: {} };
    return { body: { ticker, fundName: row.company, fundIsin: ticker === "COPX" ? null : row.isin,
      fundFamily: ticker.startsWith("ZGLD") ? "Zürcher Kantonalbank" : null,
      assetClass: "Equity", assetClassLabel: "Equity", categoryLabel: null,
      expenseRatio: 0.0007, totalAssets: 100, distributionPolicy: "DISTRIBUTING" } };
  }
  if (url.pathname === `/api/etfs/isin/${COPPER_ISIN}`) return { body: {
    fundIsin: COPPER_ISIN, ticker: "COPX.L", fundName: "Global X Copper Miners UCITS ETF",
    expenseRatio: 0.0055, assetClassLabel: "Equity", categoryLabel: null,
    listings: COPPER.slice(1),
  } };
  return { status: 404, body: {} };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, "http://upstream.test");
    requests.push({ url, body });
    const result = reply(url, body);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  const search = await import("../dist/tools/searchEtfs.js");
  const screen = await import("../dist/tools/screenEtfs.js");
  const fund = await import("../dist/tools/getEtfFund.js");
  const compare = await import("../dist/tools/compareEtfs.js");
  registrations = [search.registerSearchEtfs, screen.registerScreenEtfs,
    fund.registerGetEtfFund, compare.registerCompareEtfs];
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function call(name, args) {
  const server = new McpServer({ name: "etf-discovery-regressions", version: "1" });
  for (const register of registrations) register(server);
  const client = new Client({ name: "etf-discovery-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  } finally { await client.close(); await server.close(); }
}

test("the Harmonic Drive UCITS screen collapses all primary venue rows by fund before limiting", async () => {
  requests = [];
  const data = await call("screen_etfs", { holdingSearch: "Harmonic Drive", ucitsStatus: "UCITS", limit: 1 });
  assert.equal(requests[0].body.holdingSearch, "Harmonic Drive");
  assert.equal(requests[0].body.ucitsStatus, "UCITS");
  assert.equal(data.coverage.distinctFundsInReturnedRows, 2);
  assert.equal(data.coverage.rowsReturnedByUpstream, 4);
  assert.equal(data.matchCount, 4); // Explicitly venue count, not a fund count.
  assert.equal(data.returned, 1);
  assert.equal(data.results[0].ticker, "PAIW.DE");
  assert.equal(data.results[0].listingCount, 3);
  assert.deepEqual(data.results[0].otherListings.map(row => row.ticker).sort(), ["WPAI.MI", "WPAI.SW"]);
});

test("secondary opt-in returns the venue listings while exchange and currency select a venue", async () => {
  const everyVenue = await call("screen_etfs", { includeSecondary: true });
  assert.equal(everyVenue.returned, 4);
  assert.equal(everyVenue.results.filter(row => row.fundIsin === AI_ISIN).length, 3);
  assert.ok(everyVenue.results.every(row => row.listingCount === undefined));
  const swiss = await call("screen_etfs", { exchange: "SW", currency: "USD" });
  assert.deepEqual(swiss.results.map(row => row.ticker), ["WPAI.SW"]);
  assert.equal(swiss.results[0].listingCount, 1);
});

test("a capped screen discloses that a locally sorted top result may not be global", async () => {
  truncated = true;
  try {
    const data = await call("screen_etfs", { sortBy: "totalAssets", limit: 1 });
    assert.equal(data.coverage.upstreamTruncated, true);
    assert.ok(data.warnings.some(warning => /not guaranteed to be the global top 1/.test(warning)));
  } finally { truncated = false; }
});

test("COPX is identified as an ETF without a fund record and its UCITS sibling is listed separately", async () => {
  const data = await call("get_etf_fund", { ticker: "COPX" });
  assert.equal(data.found, false);
  assert.equal(data.query.isin, "US37954Y8306");
  assert.ok(data.warnings.some(warning => /COPX is an ETF listing/.test(warning)));
  assert.ok(data.warnings.some(warning => /get_etf_snapshot or compare_etfs/.test(warning)));
  assert.ok(data.warnings.every(warning => !/Equity ISINs are not covered/i.test(warning)));
  assert.equal(data.otherFundsSharingThisSymbol.length, 1);
  assert.equal(data.otherFundsSharingThisSymbol[0].fundIsin, COPPER_ISIN);
  assert.deepEqual(data.otherFundsSharingThisSymbol[0].tickers.sort(), ["COPX.L", "COPX.MI", "COPX.SW"]);
});

test("the explicit COPX.L venue resolves the UCITS fund and warns its venues are the same holding", async () => {
  const data = await call("get_etf_fund", { ticker: "COPX.L" });
  assert.equal(data.found, true);
  assert.equal(data.fund.fundIsin, COPPER_ISIN);
  assert.equal(data.listings.length, 3);
  assert.ok(data.warnings.some(warning => /same fund.*do not treat them as separate holdings/.test(warning)));
});

test("issuer-word searches and exact ticker relevance reach the MCP output unchanged", async () => {
  requests = [];
  const issuer = await call("search_etfs", { search: "ZKB Gold" });
  assert.equal(requests[0].url.searchParams.get("search"), "ZKB Gold");
  assert.equal(issuer.returned, 7);
  assert.ok(issuer.results.every(row => row.issuer === "Zürcher Kantonalbank"));
  requests = [];
  const exact = await call("search_etfs", { search: "ZGLD", limit: 5 });
  assert.equal(requests[0].url.searchParams.get("search"), "ZGLD");
  assert.equal(requests[0].url.searchParams.get("limit"), "5");
  assert.equal(exact.returned, 5);
  assert.equal(exact.results[0].ticker, "ZGLD.SW");
});

test("an unknown comparison ticker is explicit and cannot silently look like zero", async () => {
  const data = await call("compare_etfs", { tickers: ["VUSA.SW", "NOTREAL.XX"], include: ["classification", "costs"] });
  assert.equal(data.rows[0].found, true);
  assert.equal(data.rows[1].found, false);
  assert.equal(data.rows[1].name, null);
  assert.equal(data.rows[1].expenseRatioPct, null);
  assert.ok(data.warnings.some(warning => /NOTREAL\.XX did not match/.test(warning)));
  assert.equal(data.coverage[1].identityAvailable, false);
  assert.equal(data.coverage[1].profileAvailable, false);
});
