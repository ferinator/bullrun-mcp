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

const etfRows = [
  {
    ticker: "SPY", company: "SPDR S&P 500 ETF Trust", exchange: "NYSE ARCA", currency: "USD",
    sector: "Equity", industry: "Large Blend", country: "United States", isin: "US78462F1030",
    primaryTicker: null, quoteType: "ETF",
  },
  {
    ticker: "VTI", company: "Vanguard Total Stock Market ETF", exchange: "NYSE ARCA", currency: "USD",
    sector: "Equity", industry: "Large Blend", country: "United States", isin: "US9229087690",
    primaryTicker: null, quoteType: "ETF",
  },
];

const etfProfiles = {
  SPY: {
    ticker: "SPY", fundName: "SPDR S&P 500 ETF Trust", fundFamily: "State Street",
    category: "Equity", assetClass: "Large Blend", region: "United States", domicile: "United States",
    expenseRatio: 0.0009, totalAssets: 500_000_000_000, nav: 600.1, yieldTtm: 0.012,
    inceptionDate: "1993-01-22", benchmark: "S&P 500", website: "https://example.test/spy",
    description: "Tracks large-cap United States equities.", holdingsCount: 500,
    distributionPolicy: "DISTRIBUTING", source: "TEST", sourceUpdatedAt: "2026-08-10T23:30:00Z",
    updatedAt: "2026-08-10T23:31:00Z",
  },
  VTI: {
    ticker: "VTI", fundName: "Vanguard Total Stock Market ETF", fundFamily: "Vanguard",
    category: "Equity", assetClass: "Total Market", region: "United States", domicile: "United States",
    expenseRatio: 0.0003, totalAssets: 450_000_000_000, nav: 320.5, yieldTtm: 0.013,
    inceptionDate: "2001-05-24", benchmark: "CRSP US Total Market Index", website: "https://example.test/vti",
    description: "Tracks the broad United States equity market.", holdingsCount: 3500,
    distributionPolicy: "DISTRIBUTING", source: "TEST", sourceUpdatedAt: "2026-08-10T23:30:00Z",
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

// ── Risk, relationships, Global Markets and valuation-model fixtures ─────────────────
const reading = (riskClass, score, band, extra = {}) => ({
  riskClass, state: "LIVE", score, displayScore: Math.round(score), band, bandLabel: band, direction: "STABLE",
  priorScore: score, inputsAvailable: 2, inputsRequired: 2, driverMetricKey: "x", driverValue: 1,
  weightProfile: null, explanation: `${riskClass} ${Math.round(score)}`, waitingOn: null,
  terms: [{ key: "x", rawValue: 1, mappedScore: score, weight: 1, periodKey: "FY2025", sourceTable: "t", excludedWhy: null }],
  ...extra,
});
const dial = (key, score, band) => score == null
  ? { key, label: key, state: "NO_READING", score: null, band: null, bandLabel: null, direction: null, priorScore: null, worstCategory: null, reads: ["a"], waitingOn: "Reads a. No reading is stored for this company.", readings: [] }
  : { key, label: key, state: "LIVE", score, band, bandLabel: band, direction: "STABLE", priorScore: score, worstCategory: key, reads: ["a"], waitingOn: null, readings: [reading(key, score, band)] };
const riskPreviewV = {
  dials: {
    ticker: "V", asOfDate: "2026-10-10", formulaVersion: "risk-score-v1",
    composite: reading("COMPOSITE", 41.6, "ELEVATED", { inputsAvailable: 5, inputsRequired: 9, weightProfile: "PLATFORM" }),
    compositeAbsentWhy: null,
    dials: [dial("MARKET", 18, "CONTAINED"), dial("OPERATING", 30, "NORMAL"), dial("CASH_CONVERSION", 22, "NORMAL"),
      dial("LEVERAGE", 47, "ELEVATED"), dial("COMPETITIVE", 63, "STRETCHED"), dial("CONCENTRATION", null, null)],
  },
  headline: { headline: "Visa does a thing", url: "https://example.test/v", publisher: "Wire", publishedAt: "2026-10-09T00:00:00Z" },
};
const riskProfileV = [
  { riskLabel: "Low thing", riskClass: "MARKET", severity: "LOW", confidence: 0.9, mechanism: "m", status: "SUGGESTED", sourceQuality: "PRIMARY", sourceTitle: "Item 1A", sourceUrl: "https://example.test/10k", asOfDate: "2025-11-01" },
  { riskLabel: "Regulation of interchange", riskClass: "REGULATORY", severity: "HIGH", confidence: 0.6, mechanism: "m", status: "SUGGESTED", sourceQuality: "PRIMARY", sourceTitle: "Item 1A", sourceUrl: "https://example.test/10k", asOfDate: "2025-11-01" },
];
const supplierExposureV = {
  ticker: "V", currency: "USD", identifiedSpend: 100, costOfRevenue: 1000, costOfRevenueYear: 2025, coveragePctOfCogs: 10,
  hhiOfIdentified: 5200, top1SharePct: 60, soleSourceCount: 1, unpricedSuppliers: [],
  suppliers: [{ supplier: "Supp Co", ticker: "SUPP", disclosedPct: 30, period: "FY2025", soleSource: true, supplierRevenue: 200, supplierCurrency: "USD", fxRate: 1, spendInSubjectCcy: 60, shareOfIdentifiedPct: 60 }],
};
const networkV = {
  status: "ready", subject: { name: "Visa", ticker: "V" },
  coverage: { nodes: 4, edges: 3, competitorEdges: 1, supplierEdges: 1, customerEdges: 1, partnerEdges: 0, verifiedEdges: 2, quantifiedEdges: 1 },
  nodes: [
    { id: "1", name: "Visa", role: "SELECTED", ticker: "V" },
    { id: "2", name: "Mastercard", role: "COMPETITOR", ticker: "MA" },
    { id: "3", name: "Supp Co", role: "SUPPLIER", ticker: "SUPP" },
    { id: "4", name: "Big Bank", role: "CUSTOMER", ticker: null },
  ],
  edges: [
    { from: "2", to: "1", type: "COMPETES_WITH", status: "SUGGESTED", confidence: 0.8, soleSource: false, evidenceCount: 1, lastVerifiedAt: null, metrics: [], evidence: [{ sourceUrl: "https://example.test/s", title: "Search", excerpt: "overlap", sourceType: "TAVILY_SEARCH", publishedAt: null }] },
    { from: "3", to: "1", type: "SUPPLIES_TO", status: "VERIFIED", confidence: 0.95, soleSource: true, evidenceCount: 1, lastVerifiedAt: "2026-09-01T00:00:00Z", metrics: [{ metricType: "CUSTOMER_REVENUE_PCT", value: 30, unit: "PCT", period: "FY2025", measurementClass: "EXPLICIT", note: "10-K" }], evidence: [{ sourceUrl: "https://example.test/10k", title: "10-K", excerpt: "Visa is 30%", sourceType: "PRIMARY_FILING", publishedAt: null }] },
    { from: "1", to: "4", type: "SUPPLIES_TO", status: "VERIFIED", confidence: 0.9, soleSource: false, evidenceCount: 1, lastVerifiedAt: "2026-09-01T00:00:00Z", metrics: [], evidence: [] },
  ],
  caveats: ["Public disclosures may be incomplete; a missing edge is not proof of no relationship."],
};
const boardEntry = (ticker, score, band, priorScore, extra = {}) => ({
  ticker, company: `${ticker} Corp`, exchange: "NYSE", sector: "Technology", industry: "Software", country: "United States",
  asOfDate: "2026-10-10", score, band, bandLabel: band, bandMeaning: "m", direction: score > priorScore ? "WORSENING" : "IMPROVING",
  directionLabel: "d", priorScore, priorBand: "NORMAL", priorBandLabel: "Normal", delta: score - priorScore, moved: true,
  driverKey: "LEVERAGE", driverLabel: "Leverage", driverValue: score, driverText: `Leverage · ${score}`, weightProfile: "PLATFORM",
  explanation: "e", dialsLit: 5, dialCount: 6, basisChanged: false, priorDialsLit: 5, marketCapUsd: 1e11, ...extra,
});
const riskBoard = {
  entries: [boardEntry("AAA", 72, "STRETCHED", 70), boardEntry("BBB", 64, "STRETCHED", 66)],
  total: 2, offset: 0,
  summary: { companies: 9000, asOfDate: "2026-10-10", mechanism: "LEVERAGE",
    bands: [{ band: "STRETCHED", label: "Stretched", meaning: "several inputs deteriorating together", companies: 1600, sharePct: 17.8 }],
    changes: { newlyAcute: 1, newlyStretched: 2, improved: 3, worsened: 4, moved: 7, asOfDate: "2026-10-10" } },
  mechanisms: [{ key: "LEVERAGE", label: "Leverage and coverage", reads: "total_debt", companies: 9000 }],
};
const riskMovers = [boardEntry("UPP", 65, "STRETCHED", 50), boardEntry("DWN", 35, "NORMAL", 45)];
const marketsOverview = {
  asOf: "2026-10-10T07:00:00Z",
  metrics: [{ key: "vix", label: "VIX", value: "14.84", changePct: -3.7, changeLabel: null, sub: "CBOE volatility", tone: "pos", spark: [1, 2] }],
  indices: [
    { name: "S&P 500", region: "United States", currency: "USD", price: 7800, changePct: 0.5, trend: [7700, 7750, 7800], proxy: false },
    { name: "DAX", region: "Germany", currency: "EUR", price: 24000, changePct: -0.2, trend: [24100, 24000], proxy: false },
  ],
  centralBanks: [{ bank: "Federal Reserve (Fed)", code: "US", ratePct: 3.875, changeBps: 25, trend: [3.875] }],
  commodities: [{ name: "Brent Oil", price: 104.4, changePct: 0.1, trend: [100, 104.4] }],
  currencies: [{ pair: "EUR/USD", price: 1.12, changePct: -0.06 }],
  yields: [{ name: "United States 10Y", yieldPct: 5.24, changeBps: 1.1, asOf: "2026-10-09", spreadBps: null, anchor: null, seriesCode: "CNBC_US10Y", frequency: "D" }],
  calendar: [{ date: "2026-10-14", time: "8:30 AM ET", event: "US CPI", countryCode: "US", impact: "High", actual: null, forecast: null, previous: null }],
  rateDecisions: [{ date: "2026-10-28", time: "2:00 PM ET", event: "Fed Interest Rate Decision", countryCode: "US", impact: "High", actual: null, forecast: null, previous: null }],
  news: [{ headline: "Stocks up", minutesAgo: 10, source: "Wire", url: "https://example.test/n" }],
  usHousing: null,
  inflationMap: [
    { country: "United States", growthPct: 3.4, period: "2026-08", source: "BLS" },
    { country: "Germany", growthPct: 2.86, period: "2026-08", source: "OECD" },
    { country: "Japan", growthPct: 1.9, period: "2026-08", source: "OECD" },
  ],
  stressMap: [{ country: "Germany", growthPct: 24, period: "2026-08", source: "Bullrun" }],
};
const germanyDetail = {
  country: "Germany",
  score: { value: 24, band: "calm", pillarsCovered: 6, pillarsTotal: 6, pillarsRequired: 4, state: "scored" },
  pillars: [{ key: "labour", label: "Labour", score: 19, band: "calm", inputs: 1, inputsHeld: 1, indicators: [
    { key: "unemployment", label: "Unemployment rate", value: 4, unit: "%", period: "2026-08", source: "OECD", frequency: "M", stale: false, stress: 15, basis: "fixed scale", percentile: null, observations: null, histCode: "UNEMPLOYMENT:Germany" },
  ] }],
  newestInput: "2026-08", oldestInput: "2025", indicatorsHeld: 1, indicatorsScored: 1,
};
const fedHistory = {
  code: "BIS_CBPOL_US", title: "Fed Funds Policy Rate", unit: "Percent", frequency: "D",
  points: [
    { date: "2021-10-06", value: 0.125 }, { date: "2025-10-06", value: 4.125 },
    { date: "2026-09-06", value: 3.625 }, { date: "2026-10-06", value: 3.875 },
  ],
};
const mlScore = (model, predicted, percentile, extra = {}) => ({
  ticker: "V", company: "Visa Inc.", sector: "Financial Services", exchange: "NYSE", country: "United States", currency: "USD",
  predicted, percentile, rank: 100, asOfDate: "2026-10-09", horizonQ: 4, nPeriods: 40, currentMultiple: 30, marketCap: 6e11,
  financialDate: "2026-06-30", dataQuality: "complete", fiscalPeriod: "2026 Q2", ...extra,
});
const riskBoardHits = { count: 0, lastQuery: null };
const mlBoardQueries = [];
const mlSummaryQueries = [];

const apiServer = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (requestUrl.pathname === "/api/stocks/identity-batch") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    return json({
      isinMatches: Object.fromEntries(input.isins.map(isin => [isin, Object.values(holdingStocks).filter(row => row.isin === isin)])),
      tickerMatches: Object.fromEntries(input.tickers.map(ticker => [ticker, holdingStocks[ticker] ?? null])),
    });
  }
  if (requestUrl.pathname === "/api/etfs/search-summary") {
    const search = (requestUrl.searchParams.get("search") ?? "").toUpperCase();
    const rows = search ? etfRows.filter(row => row.ticker === search || row.company.toUpperCase().includes(search)) : etfRows;
    return json(rows.map(listing => ({ listing, profile: etfProfiles[listing.ticker] ?? null })));
  }
  const ci = "/api/company-intelligence";
  if (requestUrl.pathname === `${ci}/V/risk-preview`) return json(riskPreviewV);
  if (requestUrl.pathname === `${ci}/V/risk-profile`) return json(riskProfileV);
  if (requestUrl.pathname === `${ci}/V/supplier-exposure`) return json(supplierExposureV);
  if (requestUrl.pathname === `${ci}/V/events`) return json([]);
  if (requestUrl.pathname === "/api/stocks/V/relationships") return json(networkV);
  if (requestUrl.pathname === `${ci}/risk-board`) {
    riskBoardHits.count++;
    riskBoardHits.lastQuery = Object.fromEntries(requestUrl.searchParams);
    return json(riskBoard);
  }
  if (requestUrl.pathname === `${ci}/risk-movers`) return json(riskMovers);
  if (requestUrl.pathname === "/api/markets/overview") return json(marketsOverview);
  if (requestUrl.pathname === "/api/markets/quotes") {
    return json([{ symbol: "^GSPC", name: "S&P 500", price: 7850, changePct: 1.1, asOf: "2026-10-10T15:00:00Z" }]);
  }
  if (requestUrl.pathname === "/api/markets/country") {
    const name = requestUrl.searchParams.get("name");
    return json(name === "Germany" ? germanyDetail : { ...germanyDetail, country: name, score: { value: null, band: null, pillarsCovered: 0, pillarsTotal: 6, pillarsRequired: 4, state: "insufficient" }, pillars: [] });
  }
  if (requestUrl.pathname === "/api/markets/history") {
    const code = requestUrl.searchParams.get("code");
    return json(code === "BIS_CBPOL_US" ? fedHistory : { code, title: null, unit: null, frequency: null, points: [] });
  }
  if (requestUrl.pathname === "/api/ml-scores/summary") {
    mlSummaryQueries.push(Object.fromEntries(requestUrl.searchParams));
    if (requestUrl.searchParams.get("ticker") !== "V") return json({ results: {} });
    return json({ results: {
      valuation: mlScore("valuation", 0.1, 0.7),
      forecast: mlScore("forecast", 0.2, 0.92),
    } });
  }
  if (requestUrl.pathname === "/api/ml-scores") {
    mlBoardQueries.push(Object.fromEntries(requestUrl.searchParams));
    const asc = requestUrl.searchParams.get("order") === "asc";
    const rows = [
      { ...mlScore("valuation", 0.5, 0.99), ticker: "CHEAP", sector: "Technology" },
      { ...mlScore("valuation", 0.0, 0.5), ticker: "MID", sector: "Energy" },
      { ...mlScore("valuation", -0.4, 0.01), ticker: "RICH", sector: "Technology" },
    ];
    return json({ access: "full", total: 3, rows: asc ? rows.reverse() : rows });
  }
  if (requestUrl.pathname === "/api/etfs") {
    const search = (requestUrl.searchParams.get("search") ?? "").toUpperCase();
    const rows = search ? etfRows.filter((row) => row.ticker === search || row.company.toUpperCase().includes(search)) : etfRows;
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
// The opt-in compatibility endpoint preserves legacy ETF payload units and shape.
const legacyClient = new Client({ name: "legacy-authless", version: "0.0.0" });
await legacyClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/legacy/mcp`)));
const legacyEtf = await legacyClient.callTool({ name: "query_etfs", arguments: { ticker: "SPY", includeHoldings: false, priceLimit: 0 } });
const legacyPayload = legacyEtf.structuredContent ?? JSON.parse(legacyEtf.content?.[0]?.text ?? "{}");
ok(!legacyEtf.isError && legacyPayload.detail?.identity?.ticker === "SPY" &&
  legacyPayload.detail?.profile?.expenseRatio === 0.0009 && legacyPayload.detail?.profile?.yieldTtm === 0.012 &&
  legacyPayload.detail?.prices?.length === 0 && legacyPayload.detail?.holdings?.length === 0,
  "legacy query_etfs -> raw fractional ratios and unchanged detail shape", JSON.stringify(legacyPayload).slice(0, 180));
await legacyClient.close();
ok(
  tools.some((t) => t.name === "screen_stocks") &&
    tools.some((t) => t.name === "search_etfs") &&
    tools.some((t) => t.name === "get_etf_snapshot") &&
    tools.some((t) => t.name === "get_etf_holdings") &&
    tools.some((t) => t.name === "get_etf_timeseries") &&
    tools.some((t) => t.name === "get_etf_exposures") &&
    tools.some((t) => t.name === "get_etf_risk") &&
    tools.some((t) => t.name === "compare_etfs") &&
    !tools.some((t) => t.name === "analyze_etf_overlap") &&
    !tools.some((t) => t.name === "analyze_portfolio_fit") &&
    tools.some((t) => t.name === "simulate_etf_cost") &&
    !tools.some((t) => t.name === "query_etfs") &&
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
  arguments: { maxExpenseRatioPct: 0.05, sortBy: "expense_ratio", sortDirection: "asc", scanLimit: 25 },
});
const pe = re.structuredContent ?? JSON.parse(re.content?.[0]?.text ?? "{}");
ok(
  !re.isError &&
    pe.returned === 1 &&
    pe.results?.[0]?.ticker === "VTI" &&
    pe.results?.[0]?.expenseRatioPct === 0.03 &&
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

const overlap = await client.callTool({ name: "compare_etfs", arguments: { tickers: ["SPY", "VTI"], include: ["overlap"] } });
const overlapPayload = (overlap.structuredContent ?? JSON.parse(overlap.content?.[0]?.text ?? "{}")).overlap;
ok(
  !overlap.isError &&
    overlapPayload.pairs?.[0]?.sharedHoldings === 2 &&
    overlapPayload.pairs?.[0]?.weightedOverlapPct === 10 &&
    overlapPayload.warnings?.[0]?.includes("lower bound"),
  "compare_etfs(overlap) -> shared holdings + weighted lower-bound overlap",
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
    exposuresPayload.coverage?.classifiedWeightPct?.sector === 15 &&
    exposuresPayload.coverage?.sectorBasisWeightPct?.bullrunInstrument === 15,
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

// ── Risk, relationships, Global Markets and the valuation model ──────────────────────
const parse = (r) => r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}");
const newTools = [
  "get_company_risk", "get_company_relationships", "screen_risk_board", "get_risk_movers",
  "get_global_markets_overview", "get_country_macro", "get_macro_indicators", "get_macro_history",
  "get_valuation_model", "screen_valuation_model",
];
ok(newTools.every((n) => tools.some((t) => t.name === n)), "tools/list includes the risk, markets and valuation-model tools",
  newTools.filter((n) => !tools.some((t) => t.name === n)).join(","));

const cr = await client.callTool({ name: "get_company_risk", arguments: { ticker: "v", include: ["dials", "risk_factors", "supplier_exposure", "headline"] } });
const crp = parse(cr);
ok(
  !cr.isError &&
    crp.identity?.ticker === "V" &&
    crp.modules?.dials?.composite?.score === 42 &&
    crp.modules?.dials?.dials?.length === 6 &&
    crp.modules?.dials?.dials?.[5]?.state === "NO_READING" &&
    crp.modules?.dials?.dials?.[0]?.categories?.[0]?.terms === undefined &&
    crp.modules?.riskFactors?.factors?.[0]?.severity === "HIGH" &&
    crp.modules?.supplierExposure?.coveragePctOfCogs === 10 &&
    crp.modules?.supplierExposure?.suppliers?.[0]?.supplierRevenueFromThisCompanyPct === 30 &&
    crp.modules?.headline?.headline === "Visa does a thing" &&
    crp.warnings?.some((w) => /CONCENTRATION/.test(w) && /unmeasured/.test(w)),
  "get_company_risk -> composite + six dials (dark one flagged), severity-sorted factors, supplier coverage",
  JSON.stringify(crp).slice(0, 320),
);

const crUnknown = await client.callTool({ name: "get_company_risk", arguments: { ticker: "ZZZZ" } });
ok(!crUnknown.isError && /No Bullrun listing for "ZZZZ"/.test(crUnknown.content?.[0]?.text ?? ""), "get_company_risk(unknown) -> not-found message, not six dark dials",
  crUnknown.content?.[0]?.text ?? "");

const rel = await client.callTool({ name: "get_company_relationships", arguments: { ticker: "V" } });
const relp = parse(rel);
ok(
  !rel.isError &&
    relp.counts?.competitors === 1 && relp.counts?.suppliers === 1 && relp.counts?.customers === 1 &&
    relp.relationships?.suppliers?.[0]?.ticker === "SUPP" &&
    relp.relationships?.suppliers?.[0]?.soleSource === true &&
    relp.relationships?.suppliers?.[0]?.quantified?.[0]?.value === 30 &&
    relp.relationships?.customers?.[0]?.company === "Big Bank" &&
    relp.relationships?.competitors?.[0]?.evidence?.[0]?.excerpt === undefined,
  "get_company_relationships -> roles from edge direction, quantified dependence, sources without excerpts",
  JSON.stringify(relp).slice(0, 320),
);

const relVerified = await client.callTool({ name: "get_company_relationships", arguments: { ticker: "V", roles: ["competitors"], verifiedOnly: true } });
const relVp = parse(relVerified);
ok(
  !relVerified.isError && relVp.counts?.competitors === 0 && relVp.warnings?.some((w) => /1 search-suggested/.test(w)),
  "get_company_relationships(verifiedOnly) -> suggested edges hidden and counted",
  JSON.stringify(relVp).slice(0, 240),
);

const boardArgs = { mechanism: "LEVERAGE", bands: ["STRETCHED", "ACUTE"], sortBy: "score_desc", limit: 2 };
const board1 = parse(await client.callTool({ name: "screen_risk_board", arguments: boardArgs }));
const board2 = parse(await client.callTool({ name: "screen_risk_board", arguments: boardArgs }));
ok(
  board1.rows?.length === 2 &&
    board1.rows?.[0]?.ticker === "AAA" &&
    board1.rows?.[0]?.dialsLit === "5/6" &&
    riskBoardHits.lastQuery?.mechanism === "LEVERAGE" &&
    riskBoardHits.lastQuery?.band === "STRETCHED,ACUTE" &&
    riskBoardHits.lastQuery?.sort === "score" &&
    board2.rows?.length === 2 &&
    riskBoardHits.count === 2,
  "screen_risk_board -> mechanism/band/sort forwarded, rows compacted, repeat fetches live data",
  JSON.stringify({ hits: riskBoardHits, first: board1.rows?.[0] }).slice(0, 320),
);

const movers = parse(await client.callTool({ name: "get_risk_movers", arguments: { direction: "worsening" } }));
ok(movers.returned === 1 && movers.movers?.[0]?.ticker === "UPP", "get_risk_movers(worsening) -> only worsening band changes",
  JSON.stringify(movers).slice(0, 240));

const gm = parse(await client.callTool({ name: "get_global_markets_overview", arguments: {} }));
ok(
  gm.indices?.[0]?.level === 7850 && /live/.test(gm.indices?.[0]?.basis ?? "") &&
    gm.indices?.[0]?.historyCode === "YAHOO_GSPC" &&
    gm.indices?.[1]?.basis === "last daily close" &&
    gm.rates?.centralBanks?.[0]?.historyCode === "BIS_CBPOL_US" &&
    gm.yields?.[0]?.historyCode === "CNBC_US10Y" &&
    gm.news === undefined,
  "get_global_markets_overview -> live index overlay, history codes, default sections",
  JSON.stringify(gm).slice(0, 320),
);

const de = parse(await client.callTool({ name: "get_country_macro", arguments: { country: "germany" } }));
ok(de.country === "Germany" && de.stress?.score === 24 && de.pillars?.[0]?.indicators?.[0]?.historyCode === "UNEMPLOYMENT:Germany",
  "get_country_macro(lower-case name) -> canonical country + stress pillars", JSON.stringify(de).slice(0, 240));

const infl = parse(await client.callTool({ name: "get_macro_indicators", arguments: { indicator: "inflation", countries: ["US", "japan"], order: "asc" } }));
ok(
  infl.rows?.length === 2 && infl.rows?.[0]?.country === "Japan" && infl.rows?.[1]?.historyCode === "BLS_US_CPI_YOY",
  "get_macro_indicators(countries, asc) -> aliases resolved, ordered, US CPI history code",
  JSON.stringify(infl).slice(0, 240),
);

const fed = parse(await client.callTool({ name: "get_macro_history", arguments: { instrument: "Fed" } }));
ok(
  fed.found === true && fed.code === "BIS_CBPOL_US" &&
    fed.summary?.latest?.value === 3.875 &&
    fed.summary?.changes?.["1M"]?.changeBps === 25 &&
    fed.summary?.changes?.["5Y"]?.changeBps === 375 &&
    fed.summary?.changes?.["5Y"]?.changePct === undefined,
  "get_macro_history(instrument) -> resolved code, rate changes in bps",
  JSON.stringify(fed.summary).slice(0, 300),
);

const vm = parse(await client.callTool({ name: "get_valuation_model", arguments: { tickers: ["v", "NOPE"] } }));
ok(
  vm.results?.[0]?.headline?.valuation?.valuationGapPct === 10 &&
    vm.results?.[0]?.headline?.valuation?.modelTypicalPe === 33 &&
    vm.results?.[0]?.headline?.forecast?.reading === "top decile of the scored universe" &&
    vm.results?.[1]?.scored === false &&
    mlSummaryQueries.every((q) => q.includePs === "true"),
  "get_valuation_model -> gap %, model-typical P/E, forecast reading, P/S requested, unscored ticker flagged",
  JSON.stringify(vm.results).slice(0, 320),
);

const vs = parse(await client.callTool({ name: "screen_valuation_model", arguments: { end: "bottom", sector: "technology", limit: 5 } }));
ok(
  vs.rows?.length === 2 && vs.rows?.[0]?.ticker === "RICH" &&
    mlBoardQueries.at(-1)?.order === "asc" && mlBoardQueries.at(-1)?.limit === "1000" &&
    vs.warnings?.length === 0,
  "screen_valuation_model(bottom, sector) -> asc order forwarded, sector filtered",
  JSON.stringify(vs).slice(0, 300),
);

const rp = await client.callTool({ name: "list_portfolios", arguments: {} });
ok(rp.isError === true && /Authentication required/i.test(rp.content?.[0]?.text ?? ""), "list_portfolios(no token) -> auth-required error", rp.content?.[0]?.text ?? "");
// The refusal must link a readable setup guide rather than a machine OAuth endpoint.
const anonSave = await client.callTool({ name: "save_research_shortlist", arguments: { tickers: ["AAPL"] } });
ok(anonSave.isError === true && (anonSave.content?.[0]?.text ?? "").includes("https://bull-run.org/mcp#mcp-connect")
  && !(anonSave.content?.[0]?.text ?? "").includes("https://mcp.bull-run.org/account/mcp"),
  "save_research_shortlist(no token) -> links the account setup guide", anonSave.content?.[0]?.text ?? "");
const anonymousCapabilities = parse(await client.callTool({ name: "get_capabilities", arguments: {} }));
ok(anonymousCapabilities.authenticated === false
  && anonymousCapabilities.message.includes("https://bull-run.org/mcp#mcp-connect")
  && anonymousCapabilities.message.includes("free Bullrun account"),
  "get_capabilities(no token) -> explains free account setup", anonymousCapabilities.message);

// The dedicated login endpoint must 401-challenge even in authless mode, so an OAuth client
// (Claude) is driven into the sign-in flow while /mcp stays open for anonymous callers. A raw
// request is used because a real MCP client would try to *satisfy* the challenge, not surface it.
const authPath = process.env.MCP_AUTH_PATH ?? "/account/mcp";
const challenge = await fetch(`${base}${authPath}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "authless-probe", version: "0.0.0" } } }),
});
ok(
  challenge.status === 401 && /resource_metadata=/.test(challenge.headers.get("www-authenticate") ?? ""),
  `${authPath} (no token) -> 401 + WWW-Authenticate challenge (login path gated even in authless mode)`,
  `status=${challenge.status} www-authenticate=${challenge.headers.get("www-authenticate") ?? "(none)"}`,
);

await client.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// Close the stub and exit on the next tick so libuv doesn't assert on a handle that is
// still closing (the compiled MCP server keeps the loop alive, so a forced exit is needed).
apiServer.close();
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
