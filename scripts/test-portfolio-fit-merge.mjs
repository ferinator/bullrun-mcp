import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { z } from "zod";

let upstream;
let runWithAuth;
const tools = new Map();
let requests = [];
let mode = "normal";
const auth = { token: "portfolio-user-7", userId: 7, scopes: ["read:portfolios"] };
const holding = (ticker, holdingSymbol, holdingName, weightPct) => ({ ticker, holdingSymbol, holdingName,
  holdingKey: holdingSymbol, weightPct, asOfDate: "2026-09-30", holdingCountry: "US", holdingAssetClass: "Equity" });
const holdings = {
  CAND: [holding("CAND", "AAPL", "Apple Inc", 60), holding("CAND", "MSFT", "Microsoft Corp", 30)],
  QQQM: [holding("QQQM", "AAPL", "Apple Inc", 50), holding("QQQM", "MSFT", "Microsoft Corp", 40),
    { ...holding("QQQM", "USD", "US Dollar", 10), holdingAssetClass: "Cash" }],
};
const positions = [
  { symbol: "AAPL", ticker: "AAPL", name: "Apple Inc", country: "United States", marketValueUsd: 200 },
  { symbol: "QQQM", ticker: "QQQM", name: "Nasdaq ETF", marketValueUsd: 600 },
  { symbol: "MSFT", ticker: "MSFT", name: "Microsoft Corp", country: "United States", marketValueUsd: 200 },
  { symbol: "UNPRICED", ticker: null, name: "Unknown holding", marketValueUsd: null },
];
const riskCoverage = { totalHoldings: 4, pricedHoldings: 3, analyticsHoldings: 1,
  excludedSymbols: ["QQQM", "MSFT"], warnings: ["Insufficient history for two priced holdings."] };
const risk = ticker => ({ coverage: riskCoverage, summary: { investedValueUsd: 1000, annualVolatilityPct: 18 },
  correlationMatrix: { values: [[1]] }, riskContributions: [{ ticker: "AAPL", riskContributionPct: 100, valueUsd: 200 }],
  candidateFit: ticker ? { ticker: ticker.toUpperCase(), correlationToPortfolio: 0.4, volatilityDeltaPctPoints: -0.5 } : null,
  notes: ["The risk subset has one analyzed holding."] });

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://upstream.test");
    requests.push({ url, method: req.method, authorization: req.headers.authorization });
    let payload;
    let status = 200;
    if (url.pathname === "/api/portfolios/7/risk") payload = risk(url.searchParams.get("candidateTicker"));
    else if (url.pathname === "/api/portfolios/7") {
      if (mode === "detail-failed") { status = 503; payload = { error: "private upstream diagnostic" }; }
      else if (mode === "missing-identities") payload = { positions: [
        { symbol: null, ticker: null, name: "No instrument identity", marketValueUsd: 400 },
        { symbol: "Invalid imported name", ticker: null, name: "Unrecognized fund", marketValueUsd: 600 },
      ] };
      else if (mode === "partial-identities") payload = { positions: [positions[0],
        { symbol: null, ticker: null, name: "No instrument identity", marketValueUsd: 800 },
      ] };
      else payload = { positions };
    } else {
      const [, , domain, ticker, module] = url.pathname.split("/");
      if (domain === "etfs" && module === "holdings" && holdings[ticker]) payload = holdings[ticker];
      else if (domain === "etfs" && module === "holdings" && ticker === "EMPTYETF") payload = [];
      else if (domain === "etfs" && module === "profile" && ["CAND", "EMPTYETF"].includes(ticker)) {
        payload = { ticker, holdingsCount: 10, fundName: "Candidate ETF" };
      } else if (domain === "stocks" && !module && ["AAPL", "EMPTYETF"].includes(ticker)) {
        payload = { ticker, company: ticker === "AAPL" ? "Apple Inc" : "Empty ETF", isin: ticker === "AAPL" ? "US0378331005" : null,
          quoteType: ticker === "AAPL" ? "EQUITY" : "ETF", country: "United States" };
      } else if (url.pathname === "/api/stocks") payload = [];
      else { status = 404; payload = {}; }
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  const { registerGetPortfolioAnalytics } = await import("../dist/tools/getPortfolioAnalytics.js");
  const { registerAnalyzePortfolioFit } = await import("../dist/tools/analyzePortfolioFit.js");
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  const server = { registerTool(name, definition, callback) { tools.set(name, { definition, callback }); } };
  registerGetPortfolioAnalytics(server);
  registerAnalyzePortfolioFit(server);
});
after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
function reset(nextMode = "normal") { requests = []; mode = nextMode; }
function invoke(name, args, identity = auth) {
  const tool = tools.get(name);
  const parsed = z.object(tool.definition.inputSchema).parse(args);
  return runWithAuth(identity, () => tool.callback(parsed));
}
const call = (args = {}, identity = auth) => invoke("get_portfolio_analytics", { portfolioId: 7, ...args }, identity);
const body = result => JSON.parse(result.content[1].text);
const riskReads = () => requests.filter(request => request.url.pathname.endsWith("/risk"));
const holdingsReads = () => requests.filter(request => request.url.pathname.endsWith("/holdings"));

test("default analytics keeps its risk request, response shape and coverage banner without holdings reads", async () => {
  reset();
  const result = await call({ candidateTicker: "AAPL" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 2);
  assert.match(result.content[0].text, /COVERAGE GAP.*1 of 4 holdings/);
  assert.match(result.content[0].text, /renormalized over only the analyzed holdings/);
  assert.deepEqual(body(result), { privacyMode: "full", ...risk("AAPL") });
  assert.equal(requests.length, 1);
  assert.equal(holdingsReads().length, 0);
  assert.equal(requests[0].url.searchParams.get("days"), "370");
  assert.equal(requests[0].url.searchParams.get("candidateWeightPct"), "5");
  assert.equal(requests[0].authorization, "Bearer portfolio-user-7");
  assert.equal(tools.get("get_portfolio_analytics").definition.inputSchema.includeLookThrough.parse(undefined), false);
});

test("opt-in ETF fit combines direct and ETF-contained constituents without re-fetching risk", async () => {
  reset();
  const result = await call({ candidateTicker: "CAND", candidateWeightPct: 10, includeLookThrough: true });
  const payload = body(result);
  assert.equal(result.isError, undefined);
  assert.equal(riskReads().length, 1);
  assert.deepEqual(payload.coverage, riskCoverage);
  assert.deepEqual(payload.candidateFit, risk("CAND").candidateFit);
  assert.equal(payload.lookThroughFit.duplicateUnderlyingCount, 2);
  assert.equal(payload.lookThroughFit.candidateHoldingsWeightAlreadyPresentPct, 90);
  assert.equal(payload.lookThroughFit.proposedPortfolioWeightInDuplicateUnderlyingsPct, 9);
  const apple = payload.lookThroughFit.topDuplicateUnderlyings.find(row => row.symbol === "AAPL");
  assert.equal(apple.existingPortfolioLookThroughWeightPct, 50, "20% direct + 60% ETF allocation * 50% ETF Apple weight");
  assert.deepEqual(apple.existingSources, ["AAPL", "QQQM"]);
  const microsoft = payload.lookThroughFit.topDuplicateUnderlyings.find(row => row.symbol === "MSFT");
  assert.equal(microsoft.existingPortfolioLookThroughWeightPct, 44);
  assert.equal(payload.lookThroughCoverage.pricedPortfolioPositions, 3);
  assert.equal(payload.lookThroughCoverage.portfolioEtfPositionWeightWithLookThroughPct, 60);
  assert.equal(payload.lookThroughCoverage.candidateCoveredWeightPct, 90);
  assert.equal(payload.lookThroughCoverage.candidateHoldingsComplete, false);
  assert.equal(payload.lookThroughCoverage.independentOfPriceHistoryRiskCoverage, true);
  assert.equal(payload.lookThroughCoverage.weightDenominator, "positive_priced_position_values");
  assert.deepEqual(payload.lookThroughCoverage.candidateAsOfDates, ["2026-09-30"]);
  assert.ok(payload.lookThroughWarnings.some(warning => /lower bound/.test(warning)));
  assert.ok(payload.lookThroughWarnings.some(warning => /Unpriced portfolio positions/.test(warning)));
  assert.ok(payload.lookThroughWarnings.some(warning => /independently.*risk subset/.test(warning)));
  assert.match(result.content[0].text, /Optional holdings look-through has separate coverage/);
  assert.ok(requests.every(request => request.method === "GET" && request.authorization === "Bearer portfolio-user-7"));
});

test("stock candidate uses confirmed exact equity identity and finds direct plus ETF-contained holdings", async () => {
  reset();
  const result = await call({ candidateTicker: "AAPL", candidateWeightPct: 5, includeLookThrough: true });
  const payload = body(result);
  assert.equal(payload.lookThroughFit.candidateType, "stock");
  assert.equal(payload.lookThroughFit.duplicateUnderlyingCount, 1);
  assert.equal(payload.lookThroughFit.candidateHoldingsWeightAlreadyPresentPct, 100);
  assert.equal(payload.lookThroughFit.proposedPortfolioWeightInDuplicateUnderlyingsPct, 5);
  assert.equal(payload.lookThroughFit.topDuplicateUnderlyings[0].existingPortfolioLookThroughWeightPct, 50);
  assert.equal(riskReads().length, 1);
  assert.equal(holdingsReads().filter(request => request.url.pathname.includes("/AAPL/")).length, 1,
    "candidate/held ticker shares one holdings read");
});

test("weights_only applies to both enriched and default analytics without losing relative coverage", async () => {
  for (const includeLookThrough of [false, true]) {
    reset();
    const result = await call({ candidateTicker: "CAND", includeLookThrough, privacyMode: "weights_only" });
    const payload = body(result);
    assert.equal(payload.privacyMode, "weights_only");
    assert.equal(payload.summary.investedValueUsd, undefined);
    assert.equal(payload.riskContributions[0].valueUsd, undefined);
    assert.equal(payload.summary.annualVolatilityPct, 18);
    assert.deepEqual(payload.coverage, riskCoverage);
    assert.equal(/"\w*Usd"\s*:/.test(result.content[1].text), false);
    if (includeLookThrough) assert.equal(payload.lookThroughFit.topDuplicateUnderlyings[0].existingPortfolioLookThroughWeightPct, 50);
    else assert.equal(holdingsReads().length, 0);
  }
});

test("an ETF missing holdings stays unknown and is never interpreted as a 100% stock candidate", async () => {
  reset();
  const payload = body(await call({ candidateTicker: "EMPTYETF", includeLookThrough: true }));
  assert.equal(payload.lookThroughFit, null);
  assert.equal(payload.lookThroughCoverage.candidateType, "etf");
  assert.equal(payload.lookThroughCoverage.candidateCoveredWeightPct, 0);
  assert.equal(payload.lookThroughCoverage.candidateHoldingsComplete, false);
  assert.ok(payload.lookThroughWarnings.some(warning => /partial.*lower bound/.test(warning)));
  assert.equal(riskReads().length, 1);
});

test("unconfirmed candidate identity yields no look-through conclusion", async () => {
  reset();
  const payload = body(await call({ candidateTicker: "UNKNOWN", includeLookThrough: true }));
  assert.equal(payload.lookThroughFit, null);
  assert.equal(payload.lookThroughCoverage.candidateType, "unknown");
  assert.ok(payload.lookThroughWarnings.some(warning => /No duplicate-exposure conclusion/.test(warning)));
});

test("missing or invalid look-through candidate rejects before any backend request", async () => {
  for (const candidateTicker of [undefined, " ", "Apple Inc", "../CAND"]) {
    reset();
    const result = await call({ candidateTicker, includeLookThrough: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /includeLookThrough requires candidateTicker/);
    assert.equal(requests.length, 0);
  }
});

test("OAuth user and read:portfolios scope are required before any risk or holdings reads", async () => {
  for (const identity of [undefined, { token: "no-user", scopes: ["read:portfolios"] },
    { token: "market-only", userId: 7, scopes: ["read:market"] }]) {
    reset();
    // Pass undefined through invoke explicitly; call's default identity is authenticated.
    const tool = tools.get("get_portfolio_analytics");
    const result = await runWithAuth(identity, () => tool.callback({ portfolioId: 7, candidateTicker: "CAND", includeLookThrough: true }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Authentication required|associated Bullrun user|read:portfolios/);
    assert.equal(requests.length, 0);
  }
});

test("look-through retrieval failure keeps successful price-risk analytics and separate unknown coverage", async () => {
  reset("detail-failed");
  const result = await call({ candidateTicker: "CAND", includeLookThrough: true });
  const payload = body(result);
  assert.equal(result.isError, undefined);
  assert.deepEqual(payload.coverage, riskCoverage);
  assert.equal(payload.lookThroughFit, null);
  assert.equal(payload.lookThroughCoverage.status, "unavailable");
  assert.equal(JSON.stringify(payload).includes("private upstream diagnostic"), false);
});

test("priced positions with unusable identities keep denominator coverage explicit and an all-unknown portfolio stays unknown", async () => {
  reset("missing-identities");
  const unknown = body(await call({ candidateTicker: "CAND", includeLookThrough: true }));
  assert.equal(unknown.lookThroughFit, null);
  assert.equal(unknown.lookThroughCoverage.pricedPortfolioPositions, 2);
  assert.equal(unknown.lookThroughCoverage.portfolioPositionsWithUnknownIdentity, 2);
  assert.equal(unknown.lookThroughCoverage.portfolioWeightWithUnknownIdentityPct, 100);
  assert.equal(unknown.lookThroughCoverage.portfolioComparableInstruments, 0);
  assert.ok(unknown.lookThroughWarnings.some(warning => /cannot be matched/.test(warning)));
  assert.ok(unknown.lookThroughWarnings.some(warning => /existing duplicate exposure is unknown/.test(warning)));
  reset("partial-identities");
  const partial = body(await call({ candidateTicker: "CAND", includeLookThrough: true }));
  assert.equal(partial.lookThroughCoverage.portfolioPositionsWithUnknownIdentity, 1);
  assert.equal(partial.lookThroughCoverage.portfolioWeightWithUnknownIdentityPct, 80);
  assert.equal(partial.lookThroughFit.topDuplicateUnderlyings[0].existingPortfolioLookThroughWeightPct, 20,
    "missing 80% identity stays in the denominator instead of renormalizing the 20% Apple holding");
});

test("legacy registration reuses the fit calculation with a single risk read", async () => {
  reset();
  const result = await invoke("analyze_portfolio_fit", { portfolioId: 7, candidateTicker: "CAND", candidateWeightPct: 10 });
  const payload = result.structuredContent;
  assert.equal(result.isError, undefined);
  assert.equal(payload.candidateTicker, "CAND");
  assert.equal(payload.priceRiskFit.ticker, "CAND");
  assert.equal(payload.lookThroughFit.proposedPortfolioWeightInDuplicateUnderlyingsPct, 9);
  assert.deepEqual(payload.coverage.risk, riskCoverage);
  assert.equal(riskReads().length, 1);
  reset();
  const modern = body(await call({ candidateTicker: "CAND", candidateWeightPct: 10, includeLookThrough: true }));
  assert.deepEqual(payload.lookThroughFit, modern.lookThroughFit);
  const { risk: _risk, ...legacyLookThroughCoverage } = payload.coverage;
  assert.deepEqual(legacyLookThroughCoverage, modern.lookThroughCoverage);
  assert.equal(riskReads().length, 1);
});

test("legacy includeLookThrough=false keeps portfolio/profile coverage metadata and fetches no holdings", async () => {
  reset();
  const result = await invoke("analyze_portfolio_fit", { portfolioId: 7, candidateTicker: "CAND", includeLookThrough: false });
  const payload = result.structuredContent;
  assert.equal(result.isError, undefined);
  assert.equal(payload.lookThroughFit, null);
  assert.equal(payload.priceRiskFit.ticker, "CAND");
  assert.deepEqual(payload.coverage.risk, riskCoverage);
  assert.equal(payload.coverage.portfolioPositions, 4);
  assert.equal(payload.coverage.pricedPortfolioPositions, 3);
  assert.equal(payload.coverage.portfolioEtfPositionsWithLookThrough, 0);
  assert.equal(payload.coverage.portfolioEtfPositionWeightWithLookThroughPct, 0);
  assert.equal(payload.coverage.candidateStoredHoldingRows, 0);
  assert.equal(payload.coverage.candidateReportedHoldingsCount, 10);
  assert.equal(payload.coverage.candidateCoveredWeightPct, 0);
  assert.equal(payload.coverage.candidateHoldingsComplete, false);
  assert.equal(riskReads().length, 1);
  assert.equal(requests.filter(request => request.url.pathname === "/api/portfolios/7").length, 1);
  assert.equal(requests.filter(request => request.url.pathname === "/api/etfs/CAND/profile").length, 1);
  assert.equal(requests.length, 3);
  assert.equal(holdingsReads().length, 0);
});
