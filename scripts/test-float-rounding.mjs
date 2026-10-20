// Stored doubles and float32 closes reach the tools as 52.6853563664047, 1.3900000000000001
// or 3.8759276492061248. Agents quote such digits as if they were measured. The values
// below are the ones the 2026-10-19 review found in each tool.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const STOCK = { ticker: "AAA", company: "Company AAA", exchange: "NASDAQ", currency: "USD", sector: "Technology",
  industry: "Software", country: "United States", isin: null, primaryTicker: null, quoteType: "EQUITY" };
const annual = (ticker, fiscalYear, revenue) => ({ ticker, fiscalYear, fiscalQuarter: 0, sourceCurrency: "USD", revenue,
  grossProfit: revenue / 2, operatingIncome: revenue / 5, netIncome: revenue / 10, operatingCashflow: revenue / 8,
  freeCashflow: revenue / 9, totalAssets: revenue * 2, totalDebt: revenue / 3, stockholdersEquity: revenue,
  cashAndCashEquivalents: revenue / 6, dilutedEps: 2.0300000000000002, basicEps: 2.0400000000000005,
  dividendsPerShare: 1.3900000000000001, dividendYieldPct: 0.35047166517937545 });

let upstream;

function respond(url) {
  const parts = url.pathname.split("/");
  const ticker = decodeURIComponent(parts[3] ?? "");
  if (url.pathname.startsWith("/api/stocks/") && parts.length === 4) return { ...STOCK, ticker };
  if (parts[2] === "financials") return [annual(ticker, 2025, 200), annual(ticker, 2024, 100)];
  if (parts[2] === "prices") return [{ ticker, tradeDate: "2026-10-16", closePrice: 758.5999755859375 }];
  if (parts[2] === "valuations") return [{ ticker, tradeDate: "2026-10-16", marketCap: 1e9, peRatio: 329.57353897612194, dividendYield: 0.35047166517937545 }];
  if (parts[2] === "ml-scores") return { results: {} };
  if (parts[2] === "company-intelligence") return { dials: { ticker, asOfDate: "2026-10-16", formulaVersion: "v1",
    composite: { riskClass: "COMPOSITE", state: "LIVE", score: 52.6853563664047, displayScore: null, band: "ELEVATED" },
    dials: [{ key: "LEVERAGE", score: 41.49999999, band: "ELEVATED", state: "LIVE" }] } };
  if (url.pathname === "/api/screener/filter") return [{ ticker: "AAA", company: "Company AAA", peRatio: 14.9054575,
    dividendYield: 2.0300000000000002, latestDividendsPerShare: 1.3900000000000001, latestDilutedEps: 5.010000000000001,
    revenueSeries: [200, 100] }];
  if (url.pathname === "/api/etfs/screener") return { rows: [{ ticker: "EEE", company: "Fund EEE", isin: "IE0000000001",
    top10ConcentrationPct: 3.8759276492061248, return1yPct: 12.345678901234, volatility1yPct: 15.000000000000002,
    expenseRatio: 0.0007, avgTurnover90d: 1000, primaryTicker: null }], evaluatedCount: 1, matchCount: 1, truncated: false };
  return null;
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const body = respond(new URL(req.url, "http://stub"));
    res.writeHead(body == null ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

async function call(file, register, name, args) {
  const server = new McpServer({ name: "rounding-test", version: "1" });
  (await import(`../dist/tools/${file}.js`))[register](server);
  const client = new Client({ name: "rounding-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  } finally {
    await client.close();
    await server.close();
  }
}

test("compare_stocks rounds risk scores, multiples, yields, prices and EPS", async () => {
  const data = await call("compareStocks", "registerCompareStocks", "compare_stocks", { tickers: ["AAA", "BBB"] });
  const [row] = data.rows;
  assert.equal(row.risk.composite.score, 53, "whole points, as get_company_risk shows them");
  assert.equal(row.risk.dials[0].score, 41);
  assert.equal(row.valuation.latest.peRatio, 329.57);
  assert.equal(row.valuation.latest.dividendYieldPct, 0.35047);
  assert.equal(row.fundamentals.latestPrice.close, 758.6);
  assert.equal(row.fundamentals.annual.dilutedEps, 2.03);
});

test("screen_stocks rounds P/E, dividend yield, dividends per share and EPS", async () => {
  const data = await call("screenStocks", "registerScreenStocks", "screen_stocks", {});
  const [row] = data.results;
  assert.equal(row.peRatio, 14.905);
  assert.equal(row.dividendYield, 2.03);
  assert.equal(row.latestDividendsPerShare, 1.39);
  assert.equal(row.latestDilutedEps, 5.01);
});

test("screen_etfs rounds concentration, return and volatility percentages", async () => {
  const data = await call("screenEtfs", "registerScreenEtfs", "screen_etfs", {});
  const [row] = data.results;
  assert.equal(row.top10ConcentrationPct, 3.8759);
  assert.equal(row.return1yPct, 12.3457);
  assert.equal(row.volatility1yPct, 15);
});

test("get_financial_history rounds per-share amounts and the dividend yield", async () => {
  const data = await call("getFinancialHistory", "registerGetFinancialHistory", "get_financial_history", { ticker: "AAA", periodType: "annual" });
  const perShare = data.annual[0].perShare;
  assert.equal(perShare.dividendYieldPct, 0.35047);
  assert.equal(perShare.dividendsPerShare, 1.39);
  assert.equal(perShare.dilutedEps, 2.03);
  assert.equal(perShare.basicEps, 2.04);
});
