// Regression for the MCP review: one year must use the same calendar anchor as
// the fund page, and the representative listing's currency must be explicit.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { anchoredWindow } from "../dist/tools/etfAnalytics.js";

const bar = (tradeDate, closePrice) => ({ tradeDate, closePrice });
const isin = "CH0139101593";
const listings = [
  { ticker: "GOLD.SW", currency: "CHF", exchange: "SW" },
  { ticker: "GOLD.DE", currency: "EUR", exchange: "XETRA" },
];
const prices = [bar("2025-10-01", 80), bar("2025-10-16", 100), bar("2026-10-16", 110)];
let upstream;
let registerCompareEtfs;
let registerGetEtfFund;

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    const parts = url.pathname.split("/");
    const ticker = decodeURIComponent(parts[3] ?? "");
    let body;
    if (url.pathname === "/api/etfs") {
      body = listings.filter(row => row.ticker.includes(url.searchParams.get("search") ?? ""))
        .map(row => ({ ...row, company: "Gold Fund", isin, fundIsin: isin }));
    } else if (parts[2] === "etfs" && parts[3] === "isin") {
      body = {
        fundIsin: isin, ticker: "GOLD.SW", fundName: "Gold Fund", assetClass: "Commodity",
        assetClassLabel: "Commodity", expenseRatio: 0.004, oneYearPriceReturnPct: 10,
        priceAsOf: "2026-10-16", oneYearPriceReturnFrom: "2025-10-16", listings,
      };
    } else if (parts[4] === "profile") {
      body = { ticker, fundIsin: isin, fundName: "Gold Fund", assetClass: "Commodity" };
    } else if (parts[2] === "prices") {
      body = ticker === "YOUNG" ? prices.slice(-1) : [...prices].reverse();
    } else {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerCompareEtfs } = await import("../dist/tools/compareEtfs.js"));
  ({ registerGetEtfFund } = await import("../dist/tools/getEtfFund.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function withClient(run) {
  const server = new McpServer({ name: "etf-returns-test", version: "1" });
  registerCompareEtfs(server);
  registerGetEtfFund(server);
  const client = new Client({ name: "etf-returns-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

test("one year starts at the last valid close on or before the calendar anchor", () => {
  const result = anchoredWindow([
    bar("2025-10-01", 80), bar("2025-10-16", 100),
    bar("2025-10-17", 0), bar("2025-10-19", null), bar("2026-10-19", 110),
  ], 365);
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows, [bar("2025-10-16", 100), bar("2026-10-19", 110)]);
});

test("a missing or too-old anchor is incomplete instead of a full-year return", () => {
  const recent = [bar("2025-11-01", 100), bar("2026-10-16", 110)];
  assert.deepEqual(anchoredWindow(recent, 365), { rows: recent, complete: false });
  assert.deepEqual(anchoredWindow([bar("2025-08-31", 80), ...recent], 365),
    { rows: recent, complete: false });
  assert.deepEqual(anchoredWindow([], 365), { rows: [], complete: false });
});

test("fund and comparison returns agree on dates and representative currency", async () => {
  await withClient(async client => {
    const fundResult = await client.callTool({ name: "get_etf_fund", arguments: { ticker: "GOLD.DE" } });
    assert.equal(fundResult.isError, undefined, JSON.stringify(fundResult));
    const { fund } = fundResult.structuredContent;
    const compared = await client.callTool({ name: "compare_etfs", arguments: {
      tickers: ["GOLD.SW", "GOLD.DE"], include: ["performance"],
    } });
    assert.equal(compared.isError, undefined, JSON.stringify(compared));
    const row = compared.structuredContent.rows[0];
    assert.equal(row.priceReturnPct, 10, "the earlier 80 close must not turn 10% into 37.5%");
    assert.equal(row.priceReturnPct, fund.oneYearPriceReturnPct);
    assert.equal(row.performanceStartDate, fund.oneYearPriceReturnBasis.fromDate);
    assert.equal(row.performanceEndDate, fund.oneYearPriceReturnBasis.toDate);
    assert.equal(row.performanceWindowComplete, true);
    assert.equal(fund.oneYearPriceReturnBasis.ticker, "GOLD.SW");
    assert.equal(fund.oneYearPriceReturnBasis.tradingCurrency, "CHF");
    assert.equal(row.performanceCurrency, "CHF");
    assert.ok(compared.structuredContent.warnings.some(w => /different currencies/.test(w)));
  });
});

test("comparison explicitly warns when the return covers less than a year", async () => {
  await withClient(async client => {
    const result = await client.callTool({ name: "compare_etfs", arguments: {
      tickers: ["GOLD.SW", "YOUNG"], include: ["performance"],
    } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.rows[1].performanceWindowComplete, false);
    assert.ok(result.structuredContent.warnings.some(w => /less than 365 days/.test(w)));
  });
});
