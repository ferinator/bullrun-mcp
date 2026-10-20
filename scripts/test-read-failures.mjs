// A read that failed (429 quota or per-minute rate limit, 5xx, timeout) is not an empty
// read. During a 429 burst get_company_risk told an agent that Tesla had no risk dials,
// risk factors, suppliers or events stored -- "unmeasured, not low" -- while all six dials
// were lit. Every tool that reports emptiness must say "could not be loaded" instead.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TSLA = { ticker: "TSLA", company: "Tesla, Inc.", exchange: "NASDAQ", currency: "USD", sector: "Consumer Cyclical",
  industry: "Auto Manufacturers", country: "United States", isin: "US88160R1014", primaryTicker: null, quoteType: "EQUITY" };
const VWRL = { ticker: "VWRL", company: "Vanguard FTSE All-World UCITS ETF", exchange: "LSE", currency: "GBP", sector: null,
  industry: null, country: "Ireland", isin: "IE00B3RBWM25", primaryTicker: null, quoteType: "ETF" };
const NEWCO = { ...TSLA, ticker: "NEWCO", company: "Newco AG", exchange: "XETRA", currency: "EUR", country: "Germany",
  isin: "DE000A0D9PT0", sector: null, industry: null };
const bars = (ticker) => Array.from({ length: 40 }, (_, index) => ({ ticker,
  tradeDate: new Date(Date.UTC(2026, 9, 16) - index * 86_400_000).toISOString().slice(0, 10),
  closePrice: 100 + Math.sin(index) * 3, openPrice: 100, highPrice: 104, lowPrice: 96, volume: 10 }));
const holding = (holdingSymbol, holdingName, weightPct, extra = {}) => ({ ticker: "VWRL", asOfDate: "2026-10-16",
  holdingKey: holdingSymbol, holdingSymbol, holdingName, weightPct, shares: null, marketValue: null, currency: null,
  source: "ISSUER_FIXTURE", updatedAt: null, holdingAssetClass: "Equity", ...extra });
// Nestle needs no lookup (the provider classified it), Tesla resolves by ISIN, Apple's ISIN
// lookup is the one a test fails, and the last line has no Bullrun instrument at all.
const AAPL_ISIN = "US0378331005";
const VWRL_HOLDINGS = [
  holding("NESN", "Nestle SA", 40, { holdingCountry: "Switzerland", holdingSector: "Consumer Staples", currency: "CHF" }),
  holding("TSLA", "Tesla Inc", 30, { holdingIsin: TSLA.isin }),
  holding("AAPL", "Apple Inc", 20, { holdingIsin: AAPL_ISIN }),
  holding("ZZZZ", "Unlisted Holdings plc", 10, { holdingIsin: "GB00B03MLX29", currency: "GBP" }),
];

let upstream;
let failures = [];
let requests = [];

function respond(url) {
  const path = url.pathname;
  if (path === "/api/stocks/TSLA") return [200, TSLA];
  if (path === "/api/stocks/NEWCO") return [200, NEWCO];
  if (path === "/api/stocks") return [200, url.searchParams.get("search") === TSLA.isin ? [TSLA] : []];
  if (path === "/api/stocks/TSLA/profile") return [200, { ticker: "TSLA", longBusinessSummary: "Tesla designs and sells electric vehicles.",
    website: "https://www.tesla.com" }];
  if (path === "/api/valuations/TSLA") return [200, [{ ticker: "TSLA", tradeDate: "2026-10-16", marketCap: 1.4e12, peRatio: 180.5,
    dividendYield: null, annualDividendPerShare: null }]];
  if (path === "/api/financials/TSLA") return [200, [{ ticker: "TSLA", fiscalYear: 2026, fiscalQuarter: 2, sourceCurrency: "USD",
    revenue: 22.5e9, grossProfit: 4e9, operatingIncome: 1e9, ebitda: 3e9, netIncome: 1.2e9, dilutedEps: 0.33, freeCashflow: 1e9,
    operatingCashflow: 2e9, totalDebt: 1e10, cashAndCashEquivalents: 1.6e10, totalAssets: 1.2e11, stockholdersEquity: 7e10,
    dividendsPerShare: null }]];
  if (path === "/api/company-intelligence/risk-board") return [200, { entries: [], total: 0, offset: 0, summary: null, mechanisms: [] }];
  if (path === "/api/company-intelligence/risk-board/slices") return [200, {
    sectors: [{ name: "Technology", companies: 40, meanScore: 52, meanBand: "ELEVATED" }], countries: [] }];
  if (path === "/api/company-intelligence/TSLA/risk-preview") return [200, { dials: { ticker: "TSLA", asOfDate: "2026-10-16",
    formulaVersion: "v1", composite: null, compositeAbsentWhy: "Too few categories scored.",
    dials: [{ key: "MARKET", label: "Market", state: "NO_READING", score: null, waitingOn: "Prices" }] }, headline: null }];
  if (path === "/api/company-intelligence/TSLA/supplier-exposure") return [200, { ticker: "TSLA", suppliers: [] }];
  if (path.startsWith("/api/company-intelligence/TSLA/")) return [200, []];
  if (path === "/api/ml-scores/summary") return [200, { results: {} }];
  if (path === "/api/prices/TSLA") return [200, bars("TSLA").slice(0, 1)];
  if (path === "/api/etfs") return [200, [VWRL]];
  if (path === "/api/etfs/VWRL/profile") return [200, { ticker: "VWRL", fundName: VWRL.company, fundIsin: VWRL.isin,
    expenseRatio: 0.0019, yieldTtm: 0.018, category: "Global", assetClass: "Equity", benchmark: "FTSE All-World" }];
  if (path === `/api/etfs/isin/${VWRL.isin}`) return [200, { fundIsin: VWRL.isin, name: VWRL.company, listings: [{ ticker: "VWRL" }] }];
  if (path === "/api/etfs/VWRL/holdings") return [200, VWRL_HOLDINGS];
  if (path === "/api/prices/VWRL" || path === "/api/prices/SPY") return [200, bars(path.split("/").at(-1))];
  return [404, { error: "not found" }];
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    requests.push(url);
    // A pattern can also name the query (search=<ISIN>) to fail one lookup among many.
    const failure = failures.find(([pattern]) => pattern.test(url.pathname) || pattern.test(url.pathname + url.search));
    const [status, body] = failure
      ? [failure[1], failure[1] === 429 ? { error: "quota_exceeded" } : { error: "upstream-secret at private.internal" }]
      : respond(url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

const TOOL_MODULES = [
  ["getCompanyRisk", "registerGetCompanyRisk"], ["getRevenueBreakdown", "registerGetRevenueBreakdown"],
  ["getValuationModel", "registerGetValuationModel"], ["getForwardEstimates", "registerGetForwardEstimates"],
  ["getEtfSnapshot", "registerGetEtfSnapshot"], ["getEtfFund", "registerGetEtfFund"], ["getEtfRisk", "registerGetEtfRisk"],
  ["getEtfTimeseries", "registerGetEtfTimeseries"], ["simulateEtfCost", "registerSimulateEtfCost"], ["searchEtfs", "registerSearchEtfs"],
  ["getStockMetrics", "registerGetStockMetrics"], ["getEtfExposures", "registerGetEtfExposures"], ["queryEtfs", "registerQueryEtfs"],
  ["screenRiskBoard", "registerScreenRiskBoard"],
];

async function call(name, args, failing = []) {
  failures = failing;
  requests = [];
  const server = new McpServer({ name: "read-failures-test", version: "1" });
  for (const [file, register] of TOOL_MODULES) (await import(`../dist/tools/${file}.js`))[register](server);
  const client = new Client({ name: "read-failures-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    let data = result.structuredContent ?? null;
    if (!data) { try { data = JSON.parse(text); } catch { data = null; } }
    return { result, text, data, all: JSON.stringify(result) };
  } finally {
    await client.close();
    await server.close();
    failures = [];
  }
}

const UNMEASURED = /risk is unmeasured, not low/;
const ALL_MODULES = ["dials", "risk_factors", "supplier_exposure", "events"];

test("get_company_risk: a 429 on one module is reported, and the unmeasured claim is not made", async () => {
  const { result, data, all } = await call("get_company_risk", { ticker: "TSLA", include: ALL_MODULES }, [[/risk-preview$/, 429]]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(data.unavailableModules, ["dials"]);
  assert.equal(data.modules.dials, null);
  assert.ok(data.warnings.some((warning) => /^Risk dials could not be loaded: .*quota.*not a coverage answer/.test(warning)));
  assert.ok(!data.warnings.some((warning) => UNMEASURED.test(warning)), "a failed read is no evidence that nothing is stored");
  assert.doesNotMatch(all, /quota_exceeded|127\.0\.0\.1/);
});

test("get_company_risk: an outage on events is named as an outage, other modules still answer", async () => {
  const { data } = await call("get_company_risk", { ticker: "TSLA", include: ALL_MODULES }, [[/\/events$/, 503]]);
  assert.equal(data.modules.events, null);
  assert.ok(data.warnings.some((warning) => /^Company events could not be loaded: .*not reachable right now/.test(warning)));
  assert.ok(!data.warnings.some((warning) => /No company events are stored/.test(warning)));
  assert.equal(data.modules.riskFactors.total, 0);
  assert.ok(!data.warnings.some((warning) => UNMEASURED.test(warning)));
});

test("get_company_risk: every module failing is an error, not an empty profile", async () => {
  const { result, text } = await call("get_company_risk", { ticker: "TSLA" }, [[/^\/api\/company-intelligence\//, 429]]);
  assert.equal(result.isError, true);
  assert.match(text, /Risk data for TSLA could not be loaded: .*quota.*not a coverage answer/);
});

test("get_company_risk: a genuinely empty profile still says unmeasured, naming only what was read", async () => {
  const everything = await call("get_company_risk", { ticker: "TSLA", include: ALL_MODULES });
  assert.ok(everything.data.warnings.some((warning) => /no risk dials, filing risk factors, supplier data or events are stored/.test(warning)));
  const eventsOnly = await call("get_company_risk", { ticker: "TSLA", include: ["events"] });
  const claim = eventsOnly.data.warnings.find((warning) => UNMEASURED.test(warning));
  assert.match(claim, /no events are stored/);
  assert.doesNotMatch(claim, /risk dials/, "dials were not read, so nothing is claimed about them");
});

test("get_revenue_breakdown and get_valuation_model report a 429 instead of 'no rows' or 'no model score'", async () => {
  const breakdown = await call("get_revenue_breakdown", { ticker: "TSLA" }, [[/revenue-breakdown$/, 429]]);
  assert.equal(breakdown.result.isError, true);
  assert.match(breakdown.text, /revenue breakdown could not be loaded: .*not a coverage answer/);
  assert.doesNotMatch(breakdown.text, /No revenue breakdown rows/);
  const model = await call("get_valuation_model", { tickers: ["TSLA"] }, [[/ml-scores/, 429]]);
  assert.equal(model.result.isError, true);
  assert.match(model.text, /Model scores could not be loaded/);
  assert.doesNotMatch(model.text, /no model score/);
  const scored = await call("get_valuation_model", { tickers: ["TSLA"] });
  assert.ok(scored.data.warnings.some((warning) => /TSLA: no model score/.test(warning)), "an empty read keeps its own explanation");
});

test("get_forward_estimates names a failed price read as the reason forward P/E is null", async () => {
  const { data } = await call("get_forward_estimates", { ticker: "TSLA" }, [[/^\/api\/prices\//, 503]]);
  assert.equal(data.derived.forwardPe, null);
  assert.ok(data.warnings.some((warning) => /^The latest price could not be loaded/.test(warning)));
});

test("ETF snapshot and fund lookups never turn a 429 into 'not found'", async () => {
  const snapshot = await call("get_etf_snapshot", { ticker: "VWRL" }, [[/^\/api\/(etfs|prices)/, 429]]);
  assert.equal(snapshot.result.isError, true);
  assert.match(snapshot.text, /ETF data for VWRL could not be loaded/);
  assert.doesNotMatch(snapshot.text, /No ETF data found/);
  const partial = await call("get_etf_snapshot", { ticker: "VWRL", include: ["identity", "costs"] }, [[/\/profile$/, 429]]);
  const costs = partial.data.dataQuality.warnings.find((warning) => warning.module === "costs");
  assert.equal(costs.code, "module_not_loaded");
  assert.match(costs.message, /not a coverage answer/);
  const fund = await call("get_etf_fund", { ticker: "VWRL" }, [[/^\/api\/etfs/, 429]]);
  assert.equal(fund.result.isError, true);
  assert.match(fund.text, /fund lookup for VWRL could not be loaded/);
  assert.doesNotMatch(fund.text, /No ETF listing matches/);
});

test("ETF risk, time series and cost tools name failed price and profile reads", async () => {
  const risk = await call("get_etf_risk", { ticker: "VWRL" }, [[/^\/api\/prices\/VWRL$/, 429]]);
  assert.equal(risk.result.isError, true);
  assert.match(risk.text, /Prices for VWRL could not be loaded/);
  assert.doesNotMatch(risk.text, /Fewer than 20/);
  const benchmark = await call("get_etf_risk", { ticker: "VWRL", benchmarkTicker: "SPY" }, [[/^\/api\/prices\/SPY$/, 503]]);
  assert.ok(benchmark.data.warnings.some((warning) => /^Benchmark prices for SPY could not be loaded/.test(warning)));
  const series = await call("get_etf_timeseries", { ticker: "VWRL", series: ["price", "benchmark"], benchmarkTicker: "SPY" }, [[/^\/api\/prices\/SPY$/, 429]]);
  assert.ok(series.data.warnings.some((warning) => /^Benchmark prices for SPY could not be loaded/.test(warning)));
  assert.ok(!series.data.warnings.some((warning) => /No price history was found/.test(warning)));
  const cost = await call("simulate_etf_cost", { ticker: "VWRL", years: 10, grossAnnualReturnPct: 6 }, [[/\/profile$/, 429]]);
  assert.equal(cost.result.isError, true);
  assert.match(cost.text, /stored expense ratio for VWRL could not be loaded/);
  assert.doesNotMatch(cost.text, /No expense ratio is stored/);
});

test("search_etfs counts failed profile reads apart from missing profiles", async () => {
  const { data } = await call("search_etfs", { search: "VWRL" }, [[/\/profile$/, 429]]);
  assert.ok(data.warnings.some((warning) => /1 scanned ETF profile\(s\) could not be loaded/.test(warning)));
  assert.ok(!data.warnings.some((warning) => /had no profile data/.test(warning)));
});

test("readExactStock keeps a failed lookup apart from no such listing", async () => {
  const { readExactStock } = await import("../dist/tools/stockIdentity.js");
  failures = [[/^\/api\/stocks\/AAPL$/, 429]];
  try {
    assert.deepEqual(await readExactStock("AAPL"), { data: null, failure: "quota" });
  } finally {
    failures = [];
  }
  assert.deepEqual(await readExactStock("AAPL"), { data: null, failure: null });
  assert.equal((await readExactStock("tsla")).data.ticker, "TSLA");
});

test("get_stock_metrics: a 429 on one read nulls that section with a warning, the others still answer", async () => {
  const { result, data, all } = await call("get_stock_metrics", { ticker: "TSLA" }, [[/^\/api\/valuations\//, 429]]);
  assert.equal(result.isError, undefined);
  assert.equal(data.valuation, null);
  assert.ok(data.warnings.some((warning) => /^The latest valuation could not be loaded: .*HTTP 429.*not a coverage answer/.test(warning)));
  assert.equal(data.latestPrice.date, "2026-10-16");
  assert.equal(data.latestFinancials.period, "FY2026 Q2");
  assert.match(data.description, /electric vehicles/);
  assert.doesNotMatch(all, /quota_exceeded|127\.0\.0\.1/);
});

test("get_stock_metrics: an outage on financials and the profile is named for each, not shown as nothing reported", async () => {
  const { data, all } = await call("get_stock_metrics", { ticker: "TSLA" }, [[/^\/api\/financials\//, 503], [/\/profile$/, 503]]);
  assert.equal(data.latestFinancials, null);
  assert.equal(data.description, null);
  assert.equal(data.website, null);
  assert.ok(data.warnings.some((warning) => /^The latest reported financials could not be loaded: .*not reachable right now/.test(warning)));
  assert.ok(data.warnings.some((warning) => /^The company description and website could not be loaded/.test(warning)));
  assert.equal(data.valuation.peRatio, 180.5);
  assert.doesNotMatch(all, /upstream-secret|private\.internal/);
});

test("get_stock_metrics: every read failing is an error, and a listing with nothing stored is no failure", async () => {
  const failed = await call("get_stock_metrics", { ticker: "TSLA" }, [[/^\/api\/(valuations|prices|financials)\/|\/profile$/, 429]]);
  assert.equal(failed.result.isError, true);
  assert.match(failed.text, /Metrics for TSLA could not be loaded: .*HTTP 429.*not a coverage answer/);
  const empty = await call("get_stock_metrics", { ticker: "NEWCO" });
  assert.equal(empty.result.isError, undefined);
  assert.equal(empty.data.valuation, null);
  assert.equal(empty.data.latestPrice, null);
  assert.deepEqual(empty.data.warnings, [], "a 404 is nothing stored, not a failed read");
});

const LOOKUP_FAILED = "Not loaded (lookup failed)";
const bucket = (rows, name) => rows.find((row) => row.name === name)?.weightPct ?? null;

test("get_etf_exposures: weight whose lookup failed is reported as not loaded, apart from genuinely unclassified weight", async () => {
  const { result, data, all } = await call("get_etf_exposures", { ticker: "VWRL" }, [[new RegExp(`search=${AAPL_ISIN}`), 429]]);
  assert.equal(result.isError, undefined);
  for (const type of ["sector", "country", "currency"]) {
    assert.equal(bucket(data.exposures[type], LOOKUP_FAILED), 20, `${type}: Apple's failed lookup`);
  }
  assert.equal(bucket(data.exposures.sector, "Unclassified"), 10, "only the line with no Bullrun instrument");
  assert.equal(bucket(data.exposures.country, "Unclassified"), 10);
  assert.equal(bucket(data.exposures.currency, "Not reported"), null);
  assert.deepEqual(data.coverage.lookupFailures, {
    positions: 1, weightPct: 20, notLoadedWeightPct: { sector: 20, country: 20, currency: 20 },
  });
  assert.equal(data.coverage.sectorBasisWeightPct.unclassified, 10);
  assert.equal(data.coverage.sectorBasisWeightPct.bullrunInstrument, 30, "Tesla still resolved by ISIN");
  assert.equal(data.coverage.countryBasisWeightPct.unclassified, 10);
  assert.ok(data.warnings.some((warning) =>
    /^The Bullrun classification of 1 position\(s\) \(20% of fund weight\) could not be loaded: .*HTTP 429.*not a coverage answer/.test(warning)));
  assert.doesNotMatch(all, /quota_exceeded|127\.0\.0\.1/);

  const healthy = await call("get_etf_exposures", { ticker: "VWRL" });
  assert.equal(bucket(healthy.data.exposures.sector, "Unclassified"), 30, "with every lookup answered, Apple is simply not in the stub");
  assert.equal(bucket(healthy.data.exposures.sector, LOOKUP_FAILED), null);
  assert.equal(healthy.data.coverage.lookupFailures, undefined);
  assert.ok(!healthy.data.warnings.some((warning) => /could not be loaded/.test(warning)));
});

test("get_etf_exposures: a failed holdings read is an error, never an empty fund", async () => {
  const { result, text, all } = await call("get_etf_exposures", { ticker: "VWRL" }, [[/\/holdings$/, 429]]);
  assert.equal(result.isError, true);
  assert.match(text, /Holdings for VWRL could not be loaded: .*HTTP 429.*not a coverage answer/);
  assert.doesNotMatch(all, /unavailableTypes|Unclassified|quota_exceeded|127\.0\.0\.1/);
});

test("get_etf_exposures: a failed profile read leaves asset exposure not loaded, not unavailable", async () => {
  const { result, data, all } = await call("get_etf_exposures", { ticker: "VWRL" }, [[/\/profile$/, 503]]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(data.notLoadedTypes, ["asset"]);
  assert.ok(!data.unavailableTypes.includes("asset"));
  assert.equal(data.exposures.asset, null);
  assert.ok(data.availableTypes.includes("sector"));
  assert.match(data.warnings[0], /^The fund profile of VWRL could not be loaded: .*not reachable right now/);
  assert.doesNotMatch(all, /upstream-secret|private\.internal/);
  const assetOnly = await call("get_etf_exposures", { ticker: "VWRL", types: ["asset"] }, [[/\/profile$/, 429]]);
  assert.equal(assetOnly.result.isError, true);
  assert.match(assetOnly.text, /The fund profile of VWRL could not be loaded: .*HTTP 429/);
  const healthy = await call("get_etf_exposures", { ticker: "VWRL", types: ["asset"] });
  assert.deepEqual(healthy.data.exposures.asset, [{ name: "Equity", weightPct: 100, methodology: "fund_profile_classification" }]);
  assert.equal(healthy.data.notLoadedTypes, undefined);
});

test("query_etfs: failed detail reads are null with a warning, never empty price or holdings lists", async () => {
  const { result, data } = await call("query_etfs", { ticker: "VWRL" }, [[/^\/api\/prices\/VWRL$/, 429], [/\/holdings$/, 429]]);
  assert.equal(result.isError, undefined);
  assert.equal(data.detail.prices, null);
  assert.equal(data.detail.holdings, null);
  assert.equal(data.detail.holdingsReturned, null);
  assert.ok(data.detail.warnings.some((warning) => /^Prices for VWRL could not be loaded: .*HTTP 429/.test(warning)));
  assert.ok(data.detail.warnings.some((warning) => /^Holdings for VWRL could not be loaded: .*not a coverage answer/.test(warning)));
  assert.equal(data.detail.profile.fundName, VWRL.company);

  const profile = await call("query_etfs", { ticker: "VWRL" }, [[/\/profile$/, 503]]);
  assert.equal(profile.data.detail.profile, null);
  assert.ok(profile.data.detail.warnings.some((warning) => /^The fund profile of VWRL could not be loaded: .*not reachable right now/.test(warning)));

  const healthy = await call("query_etfs", { ticker: "VWRL" });
  assert.ok(healthy.data.detail.prices.length > 0);
  assert.equal(healthy.data.detail.holdings.length, VWRL_HOLDINGS.length);
  assert.deepEqual(healthy.data.detail.warnings, []);

  const search = await call("query_etfs", { search: "world" }, [[/^\/api\/etfs$/, 429]]);
  assert.equal(search.result.isError, true);
  assert.match(search.text, /^The ETF search could not be loaded: .*HTTP 429/);
  assert.doesNotMatch(search.all, /quota_exceeded|127\.0\.0\.1/);
});

test("screen_risk_board names requested slices that failed to load instead of leaving them out", async () => {
  const { data } = await call("screen_risk_board", { includeSlices: true }, [[/\/risk-board\/slices$/, 429]]);
  assert.equal(data.slices, undefined);
  assert.ok(data.warnings.some((warning) => /^The sector and country slices could not be loaded: .*HTTP 429/.test(warning)));
  const healthy = await call("screen_risk_board", { includeSlices: true });
  assert.equal(healthy.data.slices.sectors[0].name, "Technology");
  assert.ok(!healthy.data.warnings.some((warning) => /could not be loaded/.test(warning)));
});
