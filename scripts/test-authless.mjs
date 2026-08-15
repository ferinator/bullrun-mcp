/**
 * Regression test for authless mode (MCP_REQUIRE_AUTH=false): public market-data tools still
 * work with no token, while the per-user tool returns a clean "auth required" error rather
 * than crashing. Boots the real compiled server against a stub bullrun-api.
 *   npm run build && node scripts/test-authless.mjs
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let etfPriceRequests = 0;
let lastEtfSearchParams = null;

const etfRows = [
  {
    ticker: "SPY", company: "SPDR S&P 500 ETF Trust", exchange: "NYSE ARCA", currency: "USD",
    sector: "Equity", industry: "Large Blend", country: "United States", isin: "US78462F1030",
    primaryTicker: null, quoteType: "ETF", expenseRatio: 0.0009,
    distributionPolicy: "DISTRIBUTING", indexKey: "SP500", fundIsin: "US78462F1030",
  },
  {
    ticker: "VTI", company: "Vanguard Total Stock Market ETF", exchange: "NYSE ARCA", currency: "USD",
    sector: "Equity", industry: "Large Blend", country: "United States", isin: "US9229087690",
    primaryTicker: null, quoteType: "ETF", expenseRatio: 0.0003,
    distributionPolicy: "DISTRIBUTING", indexKey: "CRSP_US_TOTAL", fundIsin: "US9229087690",
  },
];

const etfProfiles = {
  SPY: {
    ticker: "SPY", fundIsin: "US78462F1030", fundName: "SPDR S&P 500 ETF Trust", fundFamily: "State Street",
    category: "Equity", assetClass: "Large Blend", region: "United States", domicile: "United States",
    expenseRatio: 0.0009, totalAssets: 500_000_000_000, nav: 600.1, yieldTtm: 0.012,
    inceptionDate: "1993-01-22", benchmark: "S&P 500", indexKey: "SP500", website: "https://example.test/spy",
    description: "Tracks large-cap United States equities.", holdingsCount: 500,
    distributionPolicy: "DISTRIBUTING", productType: "FUND", source: "TEST", sourceUpdatedAt: "2026-08-10T23:30:00Z",
    updatedAt: "2026-08-10T23:31:00Z",
  },
  VTI: {
    ticker: "VTI", fundIsin: "US9229087690", fundName: "Vanguard Total Stock Market ETF", fundFamily: "Vanguard",
    category: "Equity", assetClass: "Total Market", region: "United States", domicile: "United States",
    expenseRatio: 0.0003, totalAssets: 450_000_000_000, nav: 320.5, yieldTtm: 0.013,
    inceptionDate: "2001-05-24", benchmark: "CRSP US Total Market Index", indexKey: "CRSP_US_TOTAL", website: "https://example.test/vti",
    description: "Tracks the broad United States equity market.", holdingsCount: 3500,
    distributionPolicy: "DISTRIBUTING", productType: "FUND", source: "TEST", sourceUpdatedAt: "2026-08-10T23:30:00Z",
    updatedAt: "2026-08-10T23:31:00Z",
  },
};

const spyHoldings = [
  { ticker: "SPY", asOfDate: "2026-08-08", holdingKey: "AAPL", holdingSymbol: "AAPL", holdingName: "Apple", weightPct: 7, shares: 10, marketValue: 1000, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
  { ticker: "SPY", asOfDate: "2026-08-08", holdingKey: "MSFT", holdingSymbol: "MSFT", holdingName: "Microsoft", weightPct: 5, shares: 8, marketValue: 800, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
  { ticker: "SPY", asOfDate: "2026-08-08", holdingKey: "NVDA", holdingSymbol: "NVDA", holdingName: "NVIDIA", weightPct: 3, shares: 6, marketValue: 600, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
];

const vtiHoldings = [
  { ticker: "VTI", asOfDate: "2026-08-08", holdingKey: "AAPL", holdingSymbol: "AAPL", holdingName: "Apple", weightPct: 6, shares: 20, marketValue: 2000, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
  { ticker: "VTI", asOfDate: "2026-08-08", holdingKey: "MSFT", holdingSymbol: "MSFT", holdingName: "Microsoft", weightPct: 4, shares: 16, marketValue: 1600, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
  { ticker: "VTI", asOfDate: "2026-08-08", holdingKey: "AMZN", holdingSymbol: "AMZN", holdingName: "Amazon", weightPct: 3, shares: 12, marketValue: 1200, currency: "USD", source: "TEST", updatedAt: "2026-08-10T23:31:00Z" },
];

function makePrices(ticker, latestClose, dailyDrift, wave) {
  const rows = [];
  for (let i = 0; i < 90; i++) {
    const date = new Date(Date.UTC(2026, 7, 10 - i)).toISOString().slice(0, 10);
    const close = Number((latestClose - i * dailyDrift + Math.sin(i / 4) * wave).toFixed(4));
    rows.push({
      ticker, tradeDate: date, closePrice: close, openPrice: close - 0.5,
      highPrice: close + 1, lowPrice: close - 1, volume: 10_000_000 + i * 1000,
    });
  }
  return rows;
}

const etfPrices = {
  SPY: makePrices("SPY", 600, 0.65, 2.4),
  VTI: makePrices("VTI", 320, 0.31, 1.9),
};

const holdingStocks = {
  AAPL: { ticker: "AAPL", company: "Apple", exchange: "NASDAQ", currency: "USD", sector: "Technology", industry: "Consumer Electronics", country: "United States", isin: "US0378331005", primaryTicker: null, quoteType: "EQUITY" },
  MSFT: { ticker: "MSFT", company: "Microsoft", exchange: "NASDAQ", currency: "USD", sector: "Technology", industry: "Software", country: "United States", isin: "US5949181045", primaryTicker: null, quoteType: "EQUITY" },
  NVDA: { ticker: "NVDA", company: "NVIDIA", exchange: "NASDAQ", currency: "USD", sector: "Technology", industry: "Semiconductors", country: "United States", isin: "US67066G1040", primaryTicker: null, quoteType: "EQUITY" },
  AMZN: { ticker: "AMZN", company: "Amazon", exchange: "NASDAQ", currency: "USD", sector: "Consumer Cyclical", industry: "Internet Retail", country: "United States", isin: "US0231351067", primaryTicker: null, quoteType: "EQUITY" },
};

const apiServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/api/etfs") {
    lastEtfSearchParams = new URLSearchParams(requestUrl.searchParams);
    const search = (requestUrl.searchParams.get("search") ?? "").toUpperCase();
    const indexKey = requestUrl.searchParams.get("indexKey");
    const distributionPolicy = requestUrl.searchParams.get("distributionPolicy");
    const maxExpenseRatio = Number(requestUrl.searchParams.get("maxExpenseRatio") ?? Number.POSITIVE_INFINITY);
    const rows = etfRows.filter((row) =>
      (!search || row.ticker === search || row.company.toUpperCase().includes(search)) &&
      (!indexKey || row.indexKey === indexKey) &&
      (!distributionPolicy || row.distributionPolicy === distributionPolicy) &&
      row.expenseRatio <= maxExpenseRatio
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }
  const profileMatch = requestUrl.pathname.match(/^\/api\/etfs\/([^/]+)\/profile$/);
  if (profileMatch) {
    const profile = etfProfiles[decodeURIComponent(profileMatch[1])];
    if (!profile) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(profile));
    return;
  }
  if (requestUrl.pathname === "/api/etfs/SPY/holdings") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(spyHoldings));
    return;
  }
  if (requestUrl.pathname === "/api/etfs/VTI/holdings") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(vtiHoldings));
    return;
  }
  const priceMatch = requestUrl.pathname.match(/^\/api\/prices\/([^/]+)$/);
  if (priceMatch && etfPrices[decodeURIComponent(priceMatch[1])]) {
    const ticker = decodeURIComponent(priceMatch[1]);
    if (ticker === "SPY") etfPriceRequests++;
    const limit = Number(requestUrl.searchParams.get("limit") ?? 30);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(etfPrices[ticker].slice(0, limit)));
    return;
  }
  const holdingStockMatch = requestUrl.pathname.match(/^\/api\/stocks\/([^/]+)$/);
  if (holdingStockMatch && holdingStocks[decodeURIComponent(holdingStockMatch[1])]) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(holdingStocks[decodeURIComponent(holdingStockMatch[1])]));
    return;
  }
  if (req.url === "/api/stocks/V") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ticker: "V", company: "Visa Inc.", exchange: "NYSE", currency: "USD",
      sector: "Financial Services", industry: "Credit Services", country: "United States",
      isin: "US92826C8394", lei: "549300JZ4OKEHW3DPJ59", cik: "0001403161",
      primaryTicker: null, quoteType: "EQUITY",
    }));
    return;
  }
  if (req.url?.startsWith("/api/financials/V")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      {
        ticker: "V", fiscalYear: 2025, fiscalQuarter: 0, sourceCurrency: "USD", reportingScale: 1,
        revenue: 130, costOfRevenue: 20, grossProfit: 110, operatingIncome: 80, pretaxIncome: 75,
        taxProvision: 15, ebitda: 85,
        netIncome: 30, dilutedEps: 3, operatingCashflow: 35, capitalExpenditure: -5, freeCashflow: 30,
        totalAssets: 200, totalDebt: 40, stockholdersEquity: 100, cashAndCashEquivalents: 20,
        dilutedAverageShares: 2000, dividendsPerShare: 1,
      },
      {
        ticker: "V", fiscalYear: 2024, fiscalQuarter: 0, sourceCurrency: "USD", reportingScale: 1,
        revenue: 100, costOfRevenue: 15, grossProfit: 85, operatingIncome: 60, pretaxIncome: 55,
        taxProvision: 11, ebitda: 65,
        netIncome: 20, dilutedEps: 2, operatingCashflow: 24, capitalExpenditure: -4, freeCashflow: 20,
        totalAssets: 180, totalDebt: 45, stockholdersEquity: 90, cashAndCashEquivalents: 10,
        dilutedAverageShares: 2100, dividendsPerShare: 0.8,
      },
      {
        ticker: "V", fiscalYear: 2025, fiscalQuarter: 1, sourceCurrency: "USD", reportingScale: 1,
        revenue: 30, grossProfit: 25, operatingIncome: 18, netIncome: 7,
        operatingCashflow: 8, freeCashflow: 7, totalAssets: 190, totalDebt: 42, stockholdersEquity: 95,
      },
    ]));
    return;
  }
  if (req.url.startsWith("/api/screener")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          ticker: "AAA", company: "Alpha", exchange: "NYSE", marketCap: 2e11, peRatio: 20,
          dividendYield: 1, sector: "Technology", industry: "Software", country: "United States",
          latestRevenue: 100, latestNetIncome: 20, latestEbitda: 30, latestFreeCashflow: 15,
          latestDilutedEps: 2, latestDividendsPerShare: 0.5, revenueSeries: [110, 100], netIncomeSeries: [22, 20],
        },
      ]),
    );
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
const apiPort = apiServer.address().port;

const mcpPort = 8232;
process.env.PORT = String(mcpPort);
process.env.MCP_REQUIRE_AUTH = "false";
process.env.BULLRUN_API_BASE = `http://127.0.0.1:${apiPort}`;
await import("../dist/index.js");
await new Promise((r) => setTimeout(r, 400));

const base = `http://127.0.0.1:${mcpPort}`;
let failures = 0;
const ok = (c, n, e = "") => {
  if (c) console.log(`PASS  ${n}`);
  else {
    failures++;
    console.log(`FAIL  ${n} ${e}`);
  }
};

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
const client = new Client({ name: "authless", version: "0.0.0" });
await client.connect(transport); // no token -> must succeed in authless mode

const { tools } = await client.listTools();
ok(
  tools.some((t) => t.name === "screen_stocks") &&
    tools.some((t) => t.name === "search_etfs") &&
    tools.some((t) => t.name === "get_etf_snapshot") &&
    tools.some((t) => t.name === "get_etf_holdings") &&
    tools.some((t) => t.name === "get_etf_timeseries") &&
    tools.some((t) => t.name === "get_etf_exposures") &&
    tools.some((t) => t.name === "get_etf_risk") &&
    tools.some((t) => t.name === "compare_etfs") &&
    tools.some((t) => t.name === "analyze_etf_overlap") &&
    tools.some((t) => t.name === "analyze_portfolio_fit") &&
    tools.some((t) => t.name === "simulate_etf_cost") &&
    tools.some((t) => t.name === "query_etfs") &&
    tools.some((t) => t.name === "get_financial_history") &&
    tools.some((t) => t.name === "get_quality_moat_metrics") &&
    tools.some((t) => t.name === "list_portfolios") &&
    tools.some((t) => t.name === "create_position_draft"),
  "anonymous connect + tools/list",
  tools.map((t) => t.name).join(","),
);

const rs = await client.callTool({ name: "screen_stocks", arguments: { sector: "Technology", limit: 1 } });
const ps = JSON.parse(rs.content?.[0]?.text ?? "{}");
ok(!rs.isError && ps.results?.[0]?.ticker === "AAA", "screen_stocks(no token) -> data (public authless)", JSON.stringify(ps).slice(0, 160));

const re = await client.callTool({
  name: "search_etfs",
  arguments: {
    indexKey: "CRSP_US_TOTAL",
    distributionPolicy: "DISTRIBUTING",
    productTypes: ["FUND"],
    maxExpenseRatioPct: 0.05,
    sortBy: "expense_ratio",
    sortDirection: "asc",
    scanLimit: 25,
  },
});
const pe = re.structuredContent ?? JSON.parse(re.content?.[0]?.text ?? "{}");
ok(
  !re.isError &&
    pe.returned === 1 &&
    pe.results?.[0]?.ticker === "VTI" &&
    pe.results?.[0]?.expenseRatioPct === 0.03 &&
    pe.results?.[0]?.indexKey === "CRSP_US_TOTAL" &&
    lastEtfSearchParams?.get("maxExpenseRatio") === "0.0005" &&
    lastEtfSearchParams?.get("indexKey") === "CRSP_US_TOTAL" &&
    lastEtfSearchParams?.get("distributionPolicy") === "DISTRIBUTING" &&
    pe.coverage?.candidateCapReached === false,
  "search_etfs -> quantitative expense filter + structured output",
  JSON.stringify(pe).slice(0, 240),
);

const snapshot = await client.callTool({
  name: "get_etf_snapshot",
  arguments: { ticker: "spy", include: ["identity", "costs", "income", "benchmark"] },
});
const snapshotPayload = snapshot.structuredContent ?? JSON.parse(snapshot.content?.[0]?.text ?? "{}");
ok(
  !snapshot.isError &&
    snapshotPayload.found === true &&
    snapshotPayload.modules?.identity?.name === "SPDR S&P 500 ETF Trust" &&
    snapshotPayload.modules?.identity?.fundIsin === "US78462F1030" &&
    snapshotPayload.modules?.costs?.expenseRatioPct === 0.09 &&
    snapshotPayload.modules?.income?.yieldTtmPct === 1.2 &&
    snapshotPayload.modules?.market === undefined &&
    etfPriceRequests === 0,
  "get_etf_snapshot(include) -> only requested modules fetched/returned",
  JSON.stringify(snapshotPayload).slice(0, 260),
);

const defaultSnapshot = await client.callTool({ name: "get_etf_snapshot", arguments: { ticker: "SPY" } });
const defaultSnapshotPayload = defaultSnapshot.structuredContent ?? JSON.parse(defaultSnapshot.content?.[0]?.text ?? "{}");
ok(
  !defaultSnapshot.isError &&
    defaultSnapshotPayload.requestedModules?.join(",") === "identity,classification,market,costs" &&
    defaultSnapshotPayload.modules?.market?.latestPrice?.close === 600 &&
    defaultSnapshotPayload.asOf?.marketDate === "2026-08-10" &&
    etfPriceRequests === 1,
  "get_etf_snapshot(default) -> core modules + latest market data",
  JSON.stringify(defaultSnapshotPayload).slice(0, 260),
);

const holdings1 = await client.callTool({ name: "get_etf_holdings", arguments: { ticker: "SPY", limit: 2 } });
const holdingsPayload1 = holdings1.structuredContent ?? JSON.parse(holdings1.content?.[0]?.text ?? "{}");
const holdings2 = await client.callTool({
  name: "get_etf_holdings",
  arguments: { ticker: "SPY", limit: 2, cursor: holdingsPayload1.nextCursor },
});
const holdingsPayload2 = holdings2.structuredContent ?? JSON.parse(holdings2.content?.[0]?.text ?? "{}");
ok(
  !holdings1.isError && !holdings2.isError &&
    holdingsPayload1.returned === 2 &&
    holdingsPayload1.nextCursor != null &&
    holdingsPayload1.coverage?.isComplete === false &&
    holdingsPayload1.coverage?.coveredWeightPct === 15 &&
    holdingsPayload2.returned === 1 &&
    holdingsPayload2.holdings?.[0]?.symbol === "NVDA" &&
    holdingsPayload2.nextCursor === null,
  "get_etf_holdings -> cursor pagination + partial-coverage contract",
  JSON.stringify({ first: holdingsPayload1, second: holdingsPayload2 }).slice(0, 320),
);

const wrongCursor = await client.callTool({
  name: "get_etf_holdings",
  arguments: { ticker: "VTI", cursor: holdingsPayload1.nextCursor },
});
ok(
  wrongCursor.isError === true && /Invalid holdings cursor/.test(wrongCursor.content?.[0]?.text ?? ""),
  "get_etf_holdings -> rejects a cursor bound to another ticker",
  wrongCursor.content?.[0]?.text ?? "",
);

const timeseries = await client.callTool({
  name: "get_etf_timeseries",
  arguments: { ticker: "SPY", series: ["price", "price_return", "nav", "total_return", "premium_discount"], interval: "weekly", limit: 90 },
});
const timeseriesPayload = timeseries.structuredContent ?? JSON.parse(timeseries.content?.[0]?.text ?? "{}");
ok(
  !timeseries.isError &&
    timeseriesPayload.availableSeries?.includes("price") &&
    timeseriesPayload.availableSeries?.includes("price_return") &&
    timeseriesPayload.unavailableSeries?.includes("nav") &&
    timeseriesPayload.unavailableSeries?.includes("total_return") &&
    timeseriesPayload.unavailableSeries?.includes("premium_discount") &&
    timeseriesPayload.series?.price?.length > 10,
  "get_etf_timeseries -> available price + explicit unavailable NAV/total-return/premium-discount",
  JSON.stringify(timeseriesPayload).slice(0, 300),
);

const risk = await client.callTool({
  name: "get_etf_risk",
  arguments: { ticker: "SPY", benchmarkTicker: "VTI", days: 370, riskFreeRatePct: 2 },
});
const riskPayload = risk.structuredContent ?? JSON.parse(risk.content?.[0]?.text ?? "{}");
ok(
  !risk.isError &&
    riskPayload.risk?.observations === 89 &&
    riskPayload.risk?.volatilityAnnualizedPct > 0 &&
    riskPayload.benchmarkRelative?.observations === 89 &&
    riskPayload.benchmarkRelative?.trackingErrorAnnualizedPct > 0,
  "get_etf_risk -> price risk + aligned benchmark-relative metrics",
  JSON.stringify(riskPayload).slice(0, 300),
);

const comparison = await client.callTool({
  name: "compare_etfs",
  arguments: { tickers: ["SPY", "VTI"], include: ["costs", "performance", "risk", "holdings"] },
});
const comparisonPayload = comparison.structuredContent ?? JSON.parse(comparison.content?.[0]?.text ?? "{}");
ok(
  !comparison.isError &&
    comparisonPayload.rows?.length === 2 &&
    comparisonPayload.leaders?.lowestExpenseRatio?.ticker === "VTI" &&
    comparisonPayload.rows?.every((row) => row.riskObservations === 89) &&
    comparisonPayload.rows?.every((row) => row.holdingsComplete === false),
  "compare_etfs -> normalized costs/performance/risk/holdings comparison",
  JSON.stringify(comparisonPayload).slice(0, 320),
);

const overlap = await client.callTool({ name: "analyze_etf_overlap", arguments: { tickers: ["SPY", "VTI"] } });
const overlapPayload = overlap.structuredContent ?? JSON.parse(overlap.content?.[0]?.text ?? "{}");
ok(
  !overlap.isError &&
    overlapPayload.pairs?.[0]?.sharedHoldings === 2 &&
    overlapPayload.pairs?.[0]?.weightedOverlapPct === 10 &&
    Number.isFinite(overlapPayload.pairs?.[0]?.similarityScore) &&
    ["High", "Medium", "Limited"].includes(overlapPayload.pairs?.[0]?.confidence) &&
    overlapPayload.pairs?.[0]?.components?.length === 3 &&
    overlapPayload.warnings?.[0]?.includes("lower bound"),
  "analyze_etf_overlap -> shared holdings + weighted lower-bound overlap",
  JSON.stringify(overlapPayload).slice(0, 300),
);

const exposures = await client.callTool({
  name: "get_etf_exposures",
  arguments: { ticker: "SPY", types: ["sector", "country", "currency", "asset", "factor", "thematic"] },
});
const exposuresPayload = exposures.structuredContent ?? JSON.parse(exposures.content?.[0]?.text ?? "{}");
ok(
  !exposures.isError &&
    exposuresPayload.exposures?.sector?.[0]?.name === "Technology" &&
    exposuresPayload.exposures?.sector?.[0]?.weightPct === 15 &&
    exposuresPayload.availableTypes?.includes("currency") &&
    exposuresPayload.unavailableTypes?.includes("factor") &&
    exposuresPayload.unavailableTypes?.includes("thematic") &&
    exposuresPayload.coverage?.resolvedWeightPct === 15,
  "get_etf_exposures -> holdings look-through + unavailable factor/thematic coverage",
  JSON.stringify(exposuresPayload).slice(0, 320),
);

const costs = await client.callTool({
  name: "simulate_etf_cost",
  arguments: { ticker: "SPY", initialInvestment: 10_000, contributionAmount: 500, years: 10, grossAnnualReturnPct: 6, spreadPct: 0.04, commissionPerTrade: 1 },
});
const costsPayload = costs.structuredContent ?? JSON.parse(costs.content?.[0]?.text ?? "{}");
ok(
  !costs.isError &&
    costsPayload.assumptions?.expenseRatioPctUsed === 0.09 &&
    costsPayload.costBreakdown?.tradeCount === 121 &&
    costsPayload.costBreakdown?.directCostsPaid > 0 &&
    costsPayload.results?.endingValueDrag > costsPayload.costBreakdown?.directCostsPaid,
  "simulate_etf_cost -> expense/spread/commission/contribution scenario",
  JSON.stringify(costsPayload).slice(0, 300),
);

const rm = await client.callTool({ name: "get_stock_metrics", arguments: { ticker: "V" } });
const pm = JSON.parse(rm.content?.[0]?.text ?? "{}");
ok(
  !rm.isError &&
    pm.identity?.ticker === "V" &&
    pm.identity?.company === "Visa Inc." &&
    pm.identity?.isPrimaryListing === true &&
    pm.identity?.identifiers?.isin === "US92826C8394" &&
    pm.identity?.identifiers?.cik === "0001403161",
  "get_stock_metrics(V) -> exact identity, not fuzzy search fallback",
  JSON.stringify(pm).slice(0, 220),
);

const rh = await client.callTool({ name: "get_financial_history", arguments: { ticker: "V", periodType: "both", years: 2 } });
const ph = JSON.parse(rh.content?.[0]?.text ?? "{}");
ok(
  !rh.isError &&
    ph.identity?.ticker === "V" &&
    ph.annual?.length === 2 &&
    ph.quarterly?.length === 1 &&
    ph.summary?.annualGrowth?.[0]?.revenueGrowthPct === 30 &&
    ph.summary?.annualGrowth?.[0]?.netIncomeGrowthPct === 50,
  "get_financial_history(V) -> annual + quarterly history with growth checks",
  JSON.stringify(ph).slice(0, 260),
);

const rq = await client.callTool({ name: "get_quality_moat_metrics", arguments: { ticker: "V", years: 2, estimatedWaccPct: 10 } });
const pq = JSON.parse(rq.content?.[0]?.text ?? "{}");
ok(
  !rq.isError &&
    pq.identity?.ticker === "V" &&
    pq.summary?.latestRoicPct === 53.33 &&
    pq.summary?.latestRoicSpreadVsWaccPct === 43.33 &&
    pq.summary?.yearsRoicAboveWacc === 2 &&
    pq.history?.[0]?.earningsQuality?.accrualsPctOfAssets === -2.5 &&
    pq.history?.[0]?.capitalAllocation?.buybackProxyShareReductionPct === 4.76,
  "get_quality_moat_metrics(V) -> ROIC, accruals, WACC spread, buyback proxy",
  JSON.stringify(pq).slice(0, 300),
);

const rp = await client.callTool({ name: "list_portfolios", arguments: {} });
ok(rp.isError === true && /Authentication required/i.test(rp.content?.[0]?.text ?? ""), "list_portfolios(no token) -> auth-required error", rp.content?.[0]?.text ?? "");

await client.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// Close the stub and exit on the next tick so libuv doesn't assert on a handle that is
// still closing (the compiled MCP server keeps the loop alive, so a forced exit is needed).
apiServer.close();
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
