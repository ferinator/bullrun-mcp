/**
 * Local end-to-end test for the protected MCP server (Phase 3 + Phase 4) WITHOUT the
 * real Authorization Server or an interactive Google login. It:
 *   - stubs the AS JWKS (a throwaway RS256 key) and bullrun-api (echoes the forwarded user),
 *   - boots the actual compiled MCP server (dist/index.js) pointed at those stubs,
 *   - drives it with the real MCP client and asserts:
 *       * GET PRM -> resource + authorization_servers + scopes,
 *       * unauthenticated /mcp -> 401 + WWW-Authenticate (discovery trigger),
 *       * list_portfolios returns the caller's own data (user 42 vs 99 differ),
 *       * get_portfolio_context merges detail + insights, computes position weights,
 *         and privacyMode:"weights_only" strips absolute money,
 *       * get_portfolio_context returns the COMPLETE holdings list with each position
 *         flagged matched/unmatched plus a loud coverage banner + value gap %, kept
 *         even in weights_only (the data-quality gap is not private money),
 *       * get_portfolio_analytics returns risk/factor/candidate data and
 *         privacyMode:"weights_only" strips absolute USD amounts, and leads with a
 *         coverage banner naming how many holdings were excluded from the math,
 *       * old MCP_ALLOWED_USER_IDS deployment env is ignored so first-time
 *         Claude OAuth users are not blocked by a private beta gate,
 *       * create_portfolio_draft requires write:drafts, persists (returns a draftId),
 *         and forwards persist=true,
 *       * screen_stocks (public tool) works with a valid token,
 *       * no token -> the client is blocked at connect (401).
 *
 *   npm run build && node scripts/test-e2e.mjs
 */
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ISSUER = "https://bull-run.org";
const RESOURCE = "https://mcp.bull-run.org";
const KID = "test-key";
const JSON_HEADERS = { "content-type": "application/json" };

// ── stub AS JWKS ─────────────────────────────────────────────────────────────
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
const jwksServer = http.createServer((req, res) => {
  if (req.url === "/oauth2/jwks") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ keys: [jwk] }));
  } else res.writeHead(404).end();
});
await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
const jwksPort = jwksServer.address().port;

// ── stub bullrun-api: per-user data derived from the forwarded token ─────────
function userIdFromAuth(header) {
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return JSON.parse(Buffer.from(header.slice(7).split(".")[1], "base64url").toString()).userId ?? null;
  } catch {
    return null;
  }
}

let lastDraftPostBody = null;

function portfolioDetail() {
  return {
    summary: {
      id: 1, name: "Detail PF", baseCurrency: "USD", cashBalance: 1000, createdAt: "2026-01-01T00:00:00Z",
      positionCount: 3, unpricedCount: 1, marketValueUsd: 10000, totalValueUsd: 11000,
      dayChangeUsd: 50, dayChangePct: 0.5, costBasisUsd: 9000, totalReturnUsd: 1000, totalReturnPct: 11,
    },
    mlAccess: "full",
    positions: [
      {
        id: 1, symbol: "AAA", ticker: "AAA", name: "Alpha", sector: "Technology",
        quantity: 10, avgPrice: 600, currency: "USD", price: 700, priceCurrency: "USD", priceDate: "2026-06-20",
        dayChangePct: 0.5, marketValueUsd: 7000, dayChangeUsd: 35, costBasisUsd: 6000, returnPct: 16.7, priced: true,
        mlForecastPercentile: 0.9, mlForecastSignal: 0.1, mlValuationPercentile: 0.8, mlValuationSignal: 0.2,
      },
      {
        id: 2, symbol: "BBB", ticker: "BBB", name: "Beta", sector: "Healthcare",
        quantity: 5, avgPrice: 700, currency: "USD", price: 600, priceCurrency: "USD", priceDate: "2026-06-20",
        dayChangePct: -0.2, marketValueUsd: 3000, dayChangeUsd: -6, costBasisUsd: 3000, returnPct: 0, priced: true,
        mlForecastPercentile: 0.7, mlForecastSignal: 0.0, mlValuationPercentile: 0.95, mlValuationSignal: 0.3,
      },
      // Unmatched ETF: no linked ticker -> no price/sector/ML, marketValueUsd null,
      // but a cost basis the coverage estimate can size the gap from. ~62% of value.
      {
        id: 3, symbol: "VWRL", ticker: null, name: "Vanguard FTSE All-World ETF", sector: null,
        quantity: 100, avgPrice: 160, currency: "USD", price: null, priceCurrency: null, priceDate: null,
        dayChangePct: null, marketValueUsd: null, dayChangeUsd: null, costBasisUsd: 16000, returnPct: null, priced: false,
        mlForecastPercentile: null, mlForecastSignal: null, mlValuationPercentile: null, mlValuationSignal: null,
      },
    ],
    activity: [
      { id: 1, symbol: "AAA", txType: "BUY", quantity: 10, price: 600, createdAt: "2026-01-02T00:00:00Z" },
    ],
  };
}

function aiDraftResult() {
  return {
    status: "done",
    draftId: 7,
    draft: {
      name: "AI Draft", startingCash: 10000, cashPct: 5, cashBalance: 500,
      positions: [
        {
          ticker: "AAA", company: "Alpha", sector: "Technology", country: "United States",
          weightPct: 60, allocationUsd: 6000, quantity: 10, avgPrice: 600, currency: "USD",
          rationale: "Strong forecast", forecastPercentile: 0.9, valuationPercentile: 0.8, dividendYield: 1,
        },
        {
          ticker: "BBB", company: "Beta", sector: "Healthcare", country: "United States",
          weightPct: 35, allocationUsd: 3500, quantity: 5, avgPrice: 700, currency: "USD",
          rationale: "Cheap valuation", forecastPercentile: 0.7, valuationPercentile: 0.95, dividendYield: 2,
        },
      ],
      notes: ["Draft only: review before saving."], model: "test", fallback: false,
    },
  };
}

function portfolioRisk(candidateTicker = "CCC") {
  return {
    lookbackDays: 370,
    coverage: {
      totalHoldings: 3, pricedHoldings: 2, analyticsHoldings: 2,
      minPairwiseObservations: 240, excludedSymbols: [], warnings: [],
    },
    summary: {
      investedValueUsd: 10000, totalValueUsd: 11000, cashWeightPct: 9.09,
      volatilityAnnualizedPct: 16.4, diversificationRatio: 1.35,
      effectivePositionsByWeight: 1.72, effectivePositionsByRisk: 1.44,
      averagePairwiseCorrelation: 0.21, maxWeightPct: 70, maxRiskContributionPct: 82,
    },
    sectorExposures: [
      { name: "Technology", marketValueUsd: 7000, weightPct: 70, riskContributionPct: 82, positionCount: 1 },
      { name: "Healthcare", marketValueUsd: 3000, weightPct: 30, riskContributionPct: 18, positionCount: 1 },
    ],
    currencyExposures: [
      { name: "USD", marketValueUsd: 10000, weightPct: 100, riskContributionPct: 100, positionCount: 2 },
    ],
    countryExposures: [
      { name: "United States", marketValueUsd: 10000, weightPct: 100, riskContributionPct: 100, positionCount: 2 },
    ],
    correlationMatrix: { unit: "correlation", tickers: ["AAA", "BBB"], values: [[1, 0.21], [0.21, 1]], minPairwiseObservations: 240 },
    covarianceMatrixAnnualized: { unit: "annualized_pct_squared", tickers: ["AAA", "BBB"], values: [[256, 42], [42, 121]], minPairwiseObservations: 240 },
    factorExposure: {
      methodology: "test",
      portfolio: [
        { factor: "value", score: 84, coverageWeightPct: 100 },
        { factor: "growth", score: 76, coverageWeightPct: 100 },
      ],
      holdings: [
        { symbol: "AAA", ticker: "AAA", name: "Alpha", weightPct: 70, value: 80, growth: 90, momentum: 60, quality: 70, size: 0 },
      ],
    },
    riskContributions: [
      { symbol: "AAA", ticker: "AAA", marketValueUsd: 7000, weightPct: 70, volatilityAnnualizedPct: 16, riskContributionPct: 82, componentVolContributionPct: 13.4 },
    ],
    scenarios: [
      {
        scenario: "usd_plus_10pct", shock: "USD +10%", portfolioImpactPct: 0, impactUsd: 0,
        topContributors: [{ symbol: "AAA", ticker: "AAA", weightPct: 70, positionShockPct: 0, portfolioImpactPct: 0, impactUsd: 0 }],
        methodology: "test",
      },
    ],
    candidateFit: {
      ticker: candidateTicker, candidateWeightPct: 5, correlationToPortfolio: -0.12, betaToPortfolio: -0.2,
      averageCorrelationToHoldings: -0.05, standaloneVolatilityAnnualizedPct: 12,
      currentPortfolioVolatilityAnnualizedPct: 16.4, proFormaVolatilityAnnualizedPct: 15.8,
      volatilityDeltaPctPoints: -0.6,
      topCorrelations: [{ ticker: "BBB", symbol: "BBB", name: "Beta", correlation: -0.34, observations: 240 }],
      factorScores: [{ factor: "value", score: 72, coverageWeightPct: 100 }],
      notes: [],
    },
    notes: ["test"],
  };
}

const apiServer = http.createServer((req, res) => {
  const uid = userIdFromAuth(req.headers.authorization);
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/api/etfs/SPY/profile") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({
      ticker: "SPY", fundName: "SPDR S&P 500 ETF Trust", fundFamily: "State Street",
      category: "Equity", assetClass: "Large Blend", region: "United States", domicile: "United States",
      expenseRatio: 0.0009, totalAssets: 500_000_000_000, nav: 600, yieldTtm: 0.012,
      inceptionDate: "1993-01-22", benchmark: "S&P 500", holdingsCount: 500,
      source: "TEST", sourceUpdatedAt: "2026-08-10T23:30:00Z", updatedAt: "2026-08-10T23:31:00Z",
    }));
    return;
  }
  if (method === "GET" && url === "/api/etfs/SPY/holdings") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify([
      { ticker: "SPY", asOfDate: "2026-08-08", holdingKey: "AAPL", holdingSymbol: "AAPL", holdingName: "Apple", weightPct: 7, currency: "USD", source: "TEST" },
      { ticker: "SPY", asOfDate: "2026-08-08", holdingKey: "MSFT", holdingSymbol: "MSFT", holdingName: "Microsoft", weightPct: 5, currency: "USD", source: "TEST" },
    ]));
    return;
  }

  // POST /api/portfolios/ai-draft -> start the (persisted) draft job.
  if (method === "POST" && url === "/api/portfolios/ai-draft") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { lastDraftPostBody = JSON.parse(body || "{}"); } catch { lastDraftPostBody = null; }
      res.writeHead(202, JSON_HEADERS);
      res.end(JSON.stringify({ jobId: "job-1", status: "pending" }));
    });
    return;
  }
  // GET /api/portfolios/ai-draft/{jobId} -> poll (returns done immediately).
  if (method === "GET" && url.startsWith("/api/portfolios/ai-draft/")) {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(aiDraftResult()));
    return;
  }
  // GET /api/portfolios/{id}/insights
  if (method === "GET" && /^\/api\/portfolios\/\d+\/insights/.test(url)) {
    if (uid == null) { res.writeHead(403).end(); return; }
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify([
      { tone: "positive", text: "Outperforming the S&P 500." },
      { tone: "warning", text: "Concentrated in Technology." },
    ]));
    return;
  }
  // GET /api/portfolios/{id}/risk
  if (method === "GET" && /^\/api\/portfolios\/\d+\/risk/.test(url)) {
    if (uid == null) { res.writeHead(403).end(); return; }
    const requestUrl = new URL(url, "http://127.0.0.1");
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(portfolioRisk(requestUrl.searchParams.get("candidateTicker") ?? "CCC")));
    return;
  }
  // GET /api/portfolios/{id} -> detail
  if (method === "GET" && /^\/api\/portfolios\/\d+$/.test(url)) {
    if (uid == null) { res.writeHead(403).end(); return; }
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(portfolioDetail()));
    return;
  }
  // GET /api/portfolios -> list (mirrors PortfolioController: no user id -> 403)
  if (method === "GET" && url.startsWith("/api/portfolios")) {
    if (uid == null) { res.writeHead(403).end(); return; }
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify([
      {
        id: uid, name: `User ${uid} Portfolio`, baseCurrency: "USD", cashBalance: 1000,
        createdAt: "2026-01-01T00:00:00Z", positionCount: 1, unpricedCount: 0,
        marketValueUsd: 5000, totalValueUsd: 6000, dayChangeUsd: 10, dayChangePct: 0.2,
        costBasisUsd: 4000, totalReturnUsd: 1000, totalReturnPct: 25,
      },
    ]));
    return;
  }
  if (url.startsWith("/api/screener")) {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify([
      {
        ticker: "AAA", company: "Alpha", exchange: "NYSE", marketCap: 2e11, peRatio: 20,
        dividendYield: 1, sector: "Technology", industry: "Software", country: "United States",
        latestRevenue: 100, latestNetIncome: 20, latestEbitda: 30, latestFreeCashflow: 15,
        latestDilutedEps: 2, latestDividendsPerShare: 0.5, revenueSeries: [110, 100], netIncomeSeries: [22, 20],
      },
    ]));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
const apiPort = apiServer.address().port;

// ── boot the real compiled MCP server against the stubs ──────────────────────
const mcpPort = 8231;
process.env.PORT = String(mcpPort);
process.env.MCP_REQUIRE_AUTH = "true";
process.env.MCP_PUBLIC_URL = RESOURCE;
process.env.MCP_AUTH_SERVER = ISSUER;
process.env.MCP_ISSUER = ISSUER;
process.env.MCP_JWKS_URI = `http://127.0.0.1:${jwksPort}/oauth2/jwks`;
process.env.BULLRUN_API_BASE = `http://127.0.0.1:${apiPort}`;
process.env.MCP_ALLOWED_USER_IDS = "1,14"; // legacy env should not block valid OAuth users
await import("../dist/index.js");
await new Promise((r) => setTimeout(r, 400)); // allow listen()

const base = `http://127.0.0.1:${mcpPort}`;
const mint = (userId, scope = "read:market read:portfolios") =>
  new SignJWT({ role: "USER", scope, userId })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(`google-${userId}`)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience([ISSUER, RESOURCE])
    .setExpirationTime("5m")
    .sign(privateKey);

let failures = 0;
const ok = (cond, name, extra = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${extra}`);
  }
};

// 1) PRM (public, no auth)
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
ok(
  prm.resource === RESOURCE && prm.authorization_servers?.[0] === ISSUER && prm.scopes_supported?.includes("read:portfolios"),
  "GET PRM -> resource + authorization_servers + scopes",
  JSON.stringify(prm),
);

// 2) unauthenticated /mcp -> 401 + WWW-Authenticate
const unauth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
ok(unauth.status === 401 && wwwAuth.includes("resource_metadata="), "unauthenticated /mcp -> 401 + WWW-Authenticate", `status=${unauth.status} hdr=${wwwAuth}`);

async function callTool(token, name, args = {}) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/**
 * Call a tool with an elicitation-CAPABLE client that auto-accepts any elicitation/create
 * request with the given content. Returns the tool result plus whether the server actually
 * asked (so the test can prove the form path fired, not the fallback).
 */
async function callToolEliciting(token, name, args, content) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  let elicited = false;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicited = true;
    return { action: "accept", content };
  });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name, arguments: args });
    return { res, elicited };
  } finally {
    await client.close();
  }
}

/** List + fetch prompts over a fresh authenticated client. */
async function withPromptClient(token, fn) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// 3) per-user data for user 42
const r42 = await callTool(await mint(42), "list_portfolios");
const p42 = JSON.parse(r42.content?.[0]?.text ?? "{}");
ok(!r42.isError && p42.portfolios?.[0]?.id === 42 && p42.portfolios?.[0]?.name === "User 42 Portfolio", "list_portfolios(user 42) -> user-42 data", JSON.stringify(p42).slice(0, 160));

// 4) different user -> different data (proves per-user scoping via forwarded token)
const r99 = await callTool(await mint(99), "list_portfolios");
const p99 = JSON.parse(r99.content?.[0]?.text ?? "{}");
ok(!r99.isError && p99.portfolios?.[0]?.id === 99, "list_portfolios(user 99) -> user-99 data", JSON.stringify(p99).slice(0, 160));

// 5) get_portfolio_context (full) -> banner + merged detail + insights + computed weights.
// content[0] is the coverage banner; content[1] is the JSON payload.
const rc = await callTool(await mint(42), "get_portfolio_context", { portfolioId: 1 });
const rcBanner = rc.content?.[0]?.text ?? "";
const pc = JSON.parse(rc.content?.[1]?.text ?? "{}");
const pcEtf = pc.positions?.find((p) => p.symbol === "VWRL");
ok(
  !rc.isError &&
    pc.summary?.totalReturnPct === 11 &&
    pc.summary?.marketValueUsd === 10000 &&
    pc.positions?.[0]?.weightPct === 70 &&
    pc.positions?.[0]?.marketValueUsd === 7000 &&
    pc.insights?.length === 2,
  "get_portfolio_context(full) -> summary + weights + insights",
  JSON.stringify(pc).slice(0, 220),
);

// 5b) coverage contract: complete holdings list, each flagged matched/unmatched, value gap loud
ok(
  rcBanner.includes("COVERAGE GAP") && rcBanner.includes("VWRL") &&
    pc.coverage?.totalPositions === 3 &&
    pc.coverage?.matchedPositions === 2 &&
    pc.coverage?.unmatchedPositions === 1 &&
    pc.coverage?.unmatchedValuePct > 60 && pc.coverage?.unmatchedValuePct < 63 &&
    pc.coverage?.unmatchedHoldings?.[0]?.symbol === "VWRL" &&
    pc.positions?.[0]?.matched === true &&
    pcEtf?.matched === false && pcEtf?.weightPct == null,
  "get_portfolio_context -> coverage banner + matched flags + unmatched value%",
  `banner=${rcBanner.slice(0, 80)} coverage=${JSON.stringify(pc.coverage).slice(0, 200)}`,
);

// 6) get_portfolio_context (weights_only) -> absolute money stripped, weights + coverage kept
const rw = await callTool(await mint(42), "get_portfolio_context", { portfolioId: 1, privacyMode: "weights_only" });
const pw = JSON.parse(rw.content?.[1]?.text ?? "{}");
ok(
  !rw.isError &&
    pw.positions?.[0]?.weightPct === 70 &&
    pw.positions?.[0]?.marketValueUsd === undefined &&
    pw.positions?.[0]?.quantity === undefined &&
    pw.summary?.cashBalance === undefined &&
    pw.summary?.totalReturnPct === 11 &&
    // the coverage gap is a data-quality fact, not private money -> kept in weights_only
    pw.coverage?.unmatchedPositions === 1 &&
    pw.coverage?.unmatchedValuePct > 60 && pw.coverage?.unmatchedValuePct < 63,
  "get_portfolio_context(weights_only) -> absolute $ stripped, weights + coverage kept",
  JSON.stringify(pw).slice(0, 220),
);

// 7) get_portfolio_analytics (weights_only) -> relationships kept, absolute USD stripped.
// content[0] is the coverage banner; content[1] is the JSON payload.
const ra = await callTool(await mint(42), "get_portfolio_analytics", {
  portfolioId: 1,
  privacyMode: "weights_only",
  candidateTicker: "CCC",
});
const raBanner = ra.content?.[0]?.text ?? "";
const pa = JSON.parse(ra.content?.[1]?.text ?? "{}");
ok(
  !ra.isError &&
    pa.summary?.investedValueUsd === undefined &&
    pa.sectorExposures?.[0]?.marketValueUsd === undefined &&
    pa.correlationMatrix?.values?.[0]?.[1] === 0.21 &&
    pa.riskContributions?.[0]?.riskContributionPct === 82 &&
    pa.candidateFit?.ticker === "CCC" &&
    pa.candidateFit?.volatilityDeltaPctPoints === -0.6,
  "get_portfolio_analytics(weights_only) -> relationships kept, absolute USD stripped",
  JSON.stringify(pa).slice(0, 260),
);

// 7b) analytics coverage banner names the excluded holdings (2 of 3 analyzed)
ok(
  raBanner.includes("COVERAGE GAP") && raBanner.includes("2 of 3") &&
    raBanner.includes("unpriced or unmatched"),
  "get_portfolio_analytics -> coverage banner flags excluded holdings",
  raBanner.slice(0, 120),
);

const fitResult = await callTool(await mint(42), "analyze_portfolio_fit", {
  portfolioId: 1,
  candidateTicker: "SPY",
  candidateWeightPct: 5,
});
const fit = fitResult.structuredContent ?? JSON.parse(fitResult.content?.[0]?.text ?? "{}");
ok(
  !fitResult.isError &&
    fit.candidateTicker === "SPY" &&
    fit.priceRiskFit?.ticker === "SPY" &&
    fit.priceRiskFit?.volatilityDeltaPctPoints === -0.6 &&
    fit.lookThroughFit?.duplicateUnderlyingCount === 0 &&
    fit.coverage?.candidateHoldingsComplete === false &&
    fit.warnings?.some((warning) => warning.includes("lower bound")),
  "analyze_portfolio_fit -> price-risk fit + partial candidate look-through",
  JSON.stringify(fit).slice(0, 320),
);

// 8) create_portfolio_draft WITHOUT write:drafts -> scope error
const rNoScope = await callTool(await mint(42), "create_portfolio_draft", { prompt: "EU dividends" });
ok(
  rNoScope.isError === true && /write:drafts/.test(rNoScope.content?.[0]?.text ?? ""),
  "create_portfolio_draft(no write:drafts) -> scope error",
  rNoScope.content?.[0]?.text ?? "",
);

// 9) create_portfolio_draft WITH write:drafts -> saved draft + draftId, persist forwarded
const rDraft = await callTool(
  await mint(42, "read:market read:portfolios write:drafts"),
  "create_portfolio_draft",
  { prompt: "EU dividends", startingCash: 10000, maxPositions: 5 },
);
const pd = JSON.parse(rDraft.content?.[0]?.text ?? "{}");
ok(
  !rDraft.isError &&
    pd.saved === true &&
    pd.draftId === 7 &&
    pd.positions?.[0]?.ticker === "AAA" &&
    pd.positions?.[0]?.weightPct === 60 &&
    pd.positions?.[0]?.rationale === "Strong forecast" &&
    lastDraftPostBody?.persist === true,
  "create_portfolio_draft(write:drafts) -> persisted draft (draftId) + persist=true forwarded",
  JSON.stringify(pd).slice(0, 220),
);

// 10) public tool with a valid token
const rs = await callTool(await mint(42), "screen_stocks", { sector: "Technology", limit: 1 });
const ps = JSON.parse(rs.content?.[0]?.text ?? "{}");
ok(!rs.isError && ps.results?.[0]?.ticker === "AAA", "screen_stocks(valid token) -> data", JSON.stringify(ps).slice(0, 160));

// 11) no token -> client blocked at connect (401)
let blocked = false;
try {
  await callTool(null, "list_portfolios");
} catch {
  blocked = true;
}
ok(blocked, "no token -> client connect blocked (401)");

// 12) MCP prompts are exposed as selectable entry points + prime the brief from args
const { promptNames, buildText } = await withPromptClient(await mint(42), async (client) => {
  const list = await client.listPrompts();
  const get = await client.getPrompt({ name: "build_portfolio", arguments: { style: "growth" } });
  return {
    promptNames: (list.prompts ?? []).map((p) => p.name).sort().join(","),
    buildText: get.messages?.[0]?.content?.text ?? "",
  };
});
ok(
  promptNames === "analyze_portfolio,build_portfolio,suggest_positions",
  "prompts/list -> build/suggest/analyze entry points",
  promptNames,
);
ok(
  buildText.includes("Style: growth") && /create_portfolio_draft/.test(buildText),
  "prompts/get(build_portfolio) -> primes scoping message with provided args",
  buildText.slice(0, 90),
);

// 13) create_portfolio_draft with NO prompt + elicitation-capable client -> brief is
// elicited via the form and the composed brief is forwarded to bullrun-api.
const elicit = await callToolEliciting(
  await mint(42, "read:market read:portfolios write:drafts"),
  "create_portfolio_draft",
  {},
  { style: "Dividend income", region: "Europe", size: "~$25k" },
);
const pe = JSON.parse(elicit.res.content?.[0]?.text ?? "{}");
ok(
  elicit.elicited === true &&
    !elicit.res.isError &&
    pe.saved === true &&
    /dividend income portfolio of Europe equities, roughly ~\$25k/i.test(lastDraftPostBody?.prompt ?? ""),
  "create_portfolio_draft(no prompt, elicitation) -> form brief elicited + forwarded",
  `elicited=${elicit.elicited} forwarded=${lastDraftPostBody?.prompt}`,
);

// 14) create_portfolio_draft with NO prompt + client WITHOUT elicitation -> capability-gated
// fallback: non-error guidance telling the model to gather the brief conversationally.
const rFallback = await callTool(
  await mint(42, "read:market read:portfolios write:drafts"),
  "create_portfolio_draft",
  {},
);
ok(
  !rFallback.isError && /Ask the user for investing style/i.test(rFallback.content?.[0]?.text ?? ""),
  "create_portfolio_draft(no prompt, no elicitation) -> text fallback guidance",
  rFallback.content?.[0]?.text?.slice(0, 90) ?? "",
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// Close the stubs and exit on the next tick so libuv doesn't assert on a handle that is
// still closing (the compiled MCP server keeps the loop alive, so a forced exit is needed).
jwksServer.close();
apiServer.close();
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
