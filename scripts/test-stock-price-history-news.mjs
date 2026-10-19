import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  aggregateDailyPrices, closePerformance, emaSeries, macdSeries, normalizeDailyPrices, rsiSeries, smaSeries,
} from "../dist/tools/stockPriceHistoryData.js";
import { newsCutoff, newsInstant, selectCompanyNews } from "../dist/tools/companyNewsData.js";

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const price = (tradeDate, closePrice, rest = {}) => ({ ticker: "AAPL", tradeDate, closePrice,
  openPrice: closePrice - 1, highPrice: closePrice + 2, lowPrice: closePrice - 2, volume: 10, ...rest });
const article = (newsId, publishedAt, rest = {}) => ({ ticker: "AAPL", newsId, publishedAt, headline: `News ${newsId}`,
  summary: "Provider summary", publisher: "Publisher", url: `https://publisher.example/${newsId}`, ...rest });

test("SMA and SMA-seeded EMA match hand-calculated changing-price values", () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4, 8], 3), [null, null, 2, 3, 5]);
  assert.deepEqual(emaSeries([1, 2, 3, 4, 8], 3), [null, null, 2, 3, 5.5]);
  assert.deepEqual(emaSeries([1, 2], 3), [null, null]);
});

test("Wilder RSI matches the canonical 14-change example and handles flat/rising/falling histories", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
  const result = rsiSeries(closes, 14);
  assert.ok(result.slice(0, 14).every(value => value === null));
  near(result[14], 70.46413502109705);
  near(result[15], 66.24961855355505);
  assert.equal(rsiSeries([10, 10, 10, 10], 3)[3], 50);
  assert.equal(rsiSeries([10, 11, 12, 13], 3)[3], 100);
  assert.equal(rsiSeries([13, 12, 11, 10], 3)[3], 0);
  assert.deepEqual(rsiSeries([10, 11, 12], 3), [null, null, null]);
});

test("MACD warm-up and response to a single price jump match independent closed-form expectations", () => {
  const result = macdSeries([...Array(34).fill(1), 14]);
  assert.ok(result.slice(0, 25).every(value => value.macd === null));
  assert.equal(result[25].macd, 0);
  assert.equal(result[32].signal, null);
  assert.deepEqual(result[33], { macd: 0, signal: 0, histogram: 0 });
  // The jump of 13 moves the fast EMA by 13*(2/13)=2 and slow by 13*(2/27).
  const difference = 2 - 26 / 27;
  near(result[34].macd, difference);
  near(result[34].signal, difference / 5);
  near(result[34].histogram, difference * 4 / 5);
  const linear = macdSeries(Array.from({ length: 40 }, (_, index) => index + 1));
  near(linear[39].macd, 7);
  near(linear[39].signal, 7);
  near(linear[39].histogram, 0);
});

test("price normalization isolates the listing, preserves gaps and does not invent partial OHLCV", () => {
  const raw = [price("2026-10-09", 110), price("2026-10-05", 100), price("2026-10-06", 120, { volume: null, highPrice: null }),
    price("2026-10-06", 999), price("2026-10-12", 90), price("2026-02-31", 150), price("2026-10-07", 500, { ticker: "OTHER" }), price("2026-10-08", 0)];
  const normalized = normalizeDailyPrices(raw, "AAPL");
  assert.equal(normalized.omittedRows, 3);
  assert.equal(normalized.duplicateDates, 1);
  assert.deepEqual(normalized.prices.map(row => row.tradeDate), ["2026-10-05", "2026-10-06", "2026-10-09", "2026-10-12"]);
  const weekly = aggregateDailyPrices(normalized.prices, "weekly");
  assert.equal(weekly.length, 2);
  assert.deepEqual(weekly[0], { period: "2026-10-05", startDate: "2026-10-05", endDate: "2026-10-09", sourceDailyBars: 3,
    open: 99, high: null, low: 98, close: 110, volume: null });
  assert.equal(aggregateDailyPrices(normalized.prices, "monthly")[0].sourceDailyBars, 4);
});

test("price performance measures observed close peaks and returns, with insufficient history kept unknown", () => {
  const bars = aggregateDailyPrices(normalizeDailyPrices([100, 120, 90, 110].map((close, index) => price(`2026-10-0${index + 5}`, close)), "AAPL").prices, "daily");
  const result = closePerformance(bars);
  assert.deepEqual(result.summary, { startClose: 100, endClose: 110, priceReturnPct: 10, maximumDrawdownPct: -25 });
  assert.equal(result.observations[0].periodReturnPct, null);
  assert.equal(result.observations[2].periodReturnPct, -25);
  assert.equal(result.observations[2].drawdownPct, -25);
  assert.equal(closePerformance(bars.slice(0, 1)).summary.maximumDrawdownPct, null);
  assert.equal(closePerformance([]).summary.priceReturnPct, null);
});

test("news cutoffs compare absolute instants across offsets and reject impossible or timezone-free dates", () => {
  assert.equal(newsCutoff("2026-10-19"), "2026-10-19T00:00:00.000Z");
  assert.equal(newsCutoff("2026-02-31"), null);
  assert.equal(newsInstant("2026-10-19T00:00:00"), null);
  assert.equal(newsInstant("2026-02-31T12:00:00Z"), null);
  const result = selectCompanyNews([
    article("before", "2026-10-19T00:30:00+02:00"),
    article("after", "2026-10-18T23:00:00-02:00"),
    article("equal", "2026-10-19T00:00:00Z"),
    article("bad", "2026-10-19T02:00:00"),
    article("wrong", "2026-10-19T05:00:00Z", { ticker: "OTHER" }),
    article("after", "2026-10-18T23:00:00-02:00"),
  ], "AAPL", newsCutoff("2026-10-19"), 10);
  assert.deepEqual(result.articles.map(row => row.newsId), ["after", "equal"]);
  assert.equal(result.articles[0].publishedAt, "2026-10-19T01:00:00.000Z");
  assert.equal(result.omittedRows, 2);
  assert.equal(result.duplicateArticles, 1);
});

let upstream;
let registerGetStockPriceHistory;
let registerGetCompanyNews;
let runWithAuth;
let mode = "normal";
let requests = [];
const identity = { ticker: "AAPL", company: "Apple", exchange: "TEST", currency: "GBX", primaryTicker: null,
  sector: null, industry: null, country: null, isin: null, quoteType: "EQUITY" };
const fixturePrices = [100, 120, 90, 110].map((close, index) => price(`2026-10-0${index + 5}`, close)).reverse();

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://upstream.test");
    requests.push(url);
    const reply = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (mode === "failed" && url.pathname.startsWith("/api/prices/")) return reply({ secret: "internal-host/token" }, 503);
    if (url.pathname === "/api/stocks/MISSING") return reply({}, 404);
    if (url.pathname === "/api/stocks") return reply([]);
    if (url.pathname === "/api/stocks/AAPL") return reply(identity);
    if (url.pathname === "/api/prices/AAPL") return reply(fixturePrices.slice(0, Number(url.searchParams.get("limit"))));
    if (url.pathname.endsWith("/news")) {
      if (mode === "news-failed") return reply({ secret: "internal-host/token" }, 503);
      return reply(mode === "empty" ? [] : [article("older", "2026-10-18T21:00:00Z"), article("newer", "2026-10-19T01:00:00Z")]);
    }
    if (url.pathname.endsWith("/data-coverage")) {
      if (mode === "coverage-failed") return reply({ secret: "internal-host/token" }, 503);
      const fetched = mode === "stale" ? new Date(Date.now() - 48 * 3_600_000).toISOString() : new Date().toISOString();
      return reply({ ticker: "AAPL", datasets: [{ dataset: "company_news", status: "available", latestStoredAt: fetched, storedAtMeaning: "latest stored article fetch" }] });
    }
    reply({}, 404);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerGetStockPriceHistory } = await import("../dist/tools/getStockPriceHistory.js"));
  ({ registerGetCompanyNews } = await import("../dist/tools/getCompanyNews.js"));
  ({ runWithAuth } = await import("../dist/auth/context.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function withClient(run) {
  const server = new McpServer({ name: "prices-news-test", version: "1" });
  registerGetStockPriceHistory(server);
  registerGetCompanyNews(server);
  const client = new Client({ name: "prices-news-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

function reset(nextMode = "normal") { mode = nextMode; requests = []; }

test("stock price SDK call returns ascending bars, truthful adjustment/currency, indicators and source cap disclosure", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "get_stock_price_history", arguments: { ticker: " aapl ", limit: 4,
      indicators: ["sma", "ema", "rsi", "macd"], movingAveragePeriod: 2, rsiPeriod: 2 } });
    assert.equal(result.isError, undefined);
    assert.equal(CallToolResultSchema.safeParse(result).success, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const data = result.structuredContent;
    assert.deepEqual(data.bars.map(row => row.close), [100, 120, 90, 110]);
    assert.equal(data.bars[0].sma, null);
    assert.equal(data.bars[1].sma, 110);
    assert.equal(data.bars[2].rsi, 40);
    assert.deepEqual(data.bars[3].macd, { value: null, signal: null, histogram: null });
    assert.equal(data.summary.maximumDrawdownPct, -25);
    assert.equal(data.methodology.quoteCurrency, "GBX");
    assert.equal(data.methodology.priceAdjustment, "unknown");
    assert.equal(data.methodology.totalReturnVerified, false);
    assert.equal(data.coverage.sourceLimitReached, true);
    assert.ok(data.warnings.some(warning => warning.includes("MACD requires 34")));
    const url = requests.find(value => value.pathname.startsWith("/api/prices/"));
    assert.equal(url.searchParams.get("limit"), "4");
  });
});

test("date filters operate inside recent daily window; invalid dates, excessive source limits and intraday requests never hit upstream", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "get_stock_price_history", arguments: { ticker: "AAPL", limit: 2, endDate: "2020-01-01" } });
    assert.deepEqual(result.structuredContent.bars, []);
    assert.equal(result.structuredContent.coverage.loadedDailyRows, 2);
    assert.equal(result.structuredContent.coverage.completeSessionCoverage, "unknown");
    requests = [];
    for (const fields of [{ limit: 2601 }, { startDate: "2026-02-31" }, { interval: "1m" }, { startDate: "2026-10-10", endDate: "2026-10-01" }]) {
      const invalid = await client.callTool({ name: "get_stock_price_history", arguments: { ticker: "AAPL", ...fields } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(requests.length, 0);
  });
});

test("news SDK call sorts publication instants, filters inclusively and discloses cache-refresh effects", async () => {
  reset();
  await withClient(async client => {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(tool => tool.name === "get_company_news").annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "get_company_news").annotations.destructiveHint, false);
    const result = await client.callTool({ name: "get_company_news", arguments: { ticker: " aapl ", since: "2026-10-19", limit: 1 } });
    const data = result.structuredContent;
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), data);
    assert.equal(data.articles.length, 1);
    assert.equal(data.articles[0].newsId, "newer");
    assert.equal(data.articles[0].source, "Publisher");
    assert.equal(data.freshness.status, "recently_stored");
    assert.equal(data.freshness.refresh.completed, null);
    assert.ok(data.warnings.some(warning => warning.includes("does not")) || data.warnings.some(warning => warning.includes("not returned")));
    assert.equal(requests.find(url => url.pathname.endsWith("/news")).searchParams.get("limit"), "50");
  });
});

test("news remains useful with unavailable freshness; stale and empty cached news remain explicit", async () => {
  await withClient(async client => {
    reset("coverage-failed");
    const unknown = (await client.callTool({ name: "get_company_news", arguments: { ticker: "AAPL" } })).structuredContent;
    assert.equal(unknown.articles.length, 2);
    assert.equal(unknown.freshness.sourceFetchedAt, null);
    assert.equal(unknown.freshness.status, "unknown");
    assert.ok(!JSON.stringify(unknown).includes("internal-host"));
    reset("stale");
    const stale = (await client.callTool({ name: "get_company_news", arguments: { ticker: "AAPL" } })).structuredContent;
    assert.equal(stale.freshness.status, "stale");
    assert.ok(stale.warnings.some(warning => warning.includes("older than 24 hours")));
    reset("empty");
    const empty = (await client.callTool({ name: "get_company_news", arguments: { ticker: "AAPL" } })).structuredContent;
    assert.equal(empty.status, "no_matching_stored_articles");
    assert.ok(empty.warnings.some(warning => warning.includes("not proof")));
  });
});

test("unknown news identity cannot queue a refresh, invalid news cutoff fails before I/O, errors hide upstream details", async () => {
  reset();
  await withClient(async client => {
    const missing = await client.callTool({ name: "get_company_news", arguments: { ticker: "MISSING" } });
    assert.equal(missing.isError, true);
    assert.ok(!requests.some(url => url.pathname.endsWith("/news")));
    requests = [];
    const invalid = await client.callTool({ name: "get_company_news", arguments: { ticker: "AAPL", since: "2026-10-19T00:00:00" } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 0);
    for (const [nextMode, tool] of [["failed", "get_stock_price_history"], ["news-failed", "get_company_news"]]) {
      reset(nextMode);
      const failed = await client.callTool({ name: tool, arguments: { ticker: "AAPL" } });
      assert.equal(failed.isError, true);
      assert.ok(!JSON.stringify(failed).includes("internal-host"));
    }
  });
});

test("both tools enforce authenticated market scope before data reads or refresh side effects", async () => {
  reset();
  for (const register of [registerGetStockPriceHistory, registerGetCompanyNews]) {
    let callback;
    register({ registerTool(_name, _definition, handler) { callback = handler; } });
    const result = await runWithAuth({ token: "secret", scopes: ["read:portfolios"], userId: 1 }, () => callback({ ticker: "AAPL" }));
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("read:market"));
  }
  assert.equal(requests.length, 0);
});
