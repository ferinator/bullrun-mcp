import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerScreenStocks } from "./tools/screenStocks.js";
import { registerSearchStocks } from "./tools/searchStocks.js";
import { registerScreenStockPresets } from "./tools/screenStockPresets.js";
import { registerFindStockPeers } from "./tools/findStockPeers.js";
import { registerGetStockPriceHistory } from "./tools/getStockPriceHistory.js";
import { registerGetCompanyNews } from "./tools/getCompanyNews.js";
import { registerQueryEtfs } from "./tools/queryEtfs.js";
import { registerSearchEtfs } from "./tools/searchEtfs.js";
import { registerScreenEtfs } from "./tools/screenEtfs.js";
import { registerGetEtfIndexGroup } from "./tools/getEtfIndexGroup.js";
import { registerGetEtfFund } from "./tools/getEtfFund.js";
import { registerGetEtfFilterOptions } from "./tools/getEtfFilterOptions.js";
import { registerGetEtfSnapshot } from "./tools/getEtfSnapshot.js";
import { registerGetEtfHoldings } from "./tools/getEtfHoldings.js";
import { registerGetEtfTimeseries } from "./tools/getEtfTimeseries.js";
import { registerGetEtfExposures } from "./tools/getEtfExposures.js";
import { registerGetEtfRisk } from "./tools/getEtfRisk.js";
import { registerCompareEtfs } from "./tools/compareEtfs.js";
import { registerAnalyzeEtfOverlap } from "./tools/analyzeEtfOverlap.js";
import { registerAnalyzePortfolioFit } from "./tools/analyzePortfolioFit.js";
import { registerSimulateEtfCost } from "./tools/simulateEtfCost.js";
import { registerGetStockMetrics } from "./tools/getStockMetrics.js";
import { registerCompareStocks } from "./tools/compareStocks.js";
import { registerGetFinancialHistory } from "./tools/getFinancialHistory.js";
import { registerGetQualityMoatMetrics } from "./tools/getQualityMoatMetrics.js";
import { registerGetForwardEstimates } from "./tools/getForwardEstimates.js";
import { registerGetOperatingKpis } from "./tools/getOperatingKpis.js";
import { registerGetRevenueBreakdown } from "./tools/getRevenueBreakdown.js";
import { registerGetEarningsCallTranscript } from "./tools/getEarningsCallTranscript.js";
import { registerListPortfolios } from "./tools/listPortfolios.js";
import { registerGetPortfolioContext } from "./tools/getPortfolioContext.js";
import { registerGetPortfolioAnalytics } from "./tools/getPortfolioAnalytics.js";
import { registerCreatePortfolioDraft } from "./tools/createPortfolioDraft.js";
import { registerCreatePositionDraft } from "./tools/createPositionDraft.js";
import { registerCreatePortfolioFromPositions } from "./tools/createPortfolioFromPositions.js";
import { registerGetCapabilities } from "./tools/getCapabilities.js";
import { registerGetCompanyRisk } from "./tools/getCompanyRisk.js";
import { registerGetCompanyRelationships } from "./tools/getCompanyRelationships.js";
import { registerCompareCompanyExposures } from "./tools/compareCompanyExposures.js";
import { registerGetCorporateCalendar } from "./tools/getCorporateCalendar.js";
import { registerGetCompanyRiskHistory } from "./tools/getCompanyRiskHistory.js";
import { registerGetCompanyDataCoverage } from "./tools/getCompanyDataCoverage.js";
import { registerScreenRiskBoard } from "./tools/screenRiskBoard.js";
import { registerGetRiskMovers } from "./tools/getRiskMovers.js";
import { registerGetGlobalMarketsOverview } from "./tools/getGlobalMarketsOverview.js";
import { registerGetCountryMacro } from "./tools/getCountryMacro.js";
import { registerGetMacroIndicators } from "./tools/getMacroIndicators.js";
import { registerGetMacroHistory } from "./tools/getMacroHistory.js";
import { registerGetValuationModel } from "./tools/getValuationModel.js";
import { registerScreenValuationModel } from "./tools/screenValuationModel.js";
import { registerPrompts } from "./prompts.js";
import { addPlatformLinks } from "./tools/platformLinks.js";
import { instrumentMcpTools } from "./usage/invocations.js";
import { boundMarketplaceResults } from "./gateway/mcprush.js";
import { SERVER_VERSION } from "./version.js";
import { registerResearchShortlist } from "./tools/researchShortlist.js";

const RESEARCH_EXPANSION_GUIDANCE = "Use search_stocks to resolve a company name, ISIN, native ticker or listing ambiguity before exact-ticker tools. Use screen_stocks with action=list_presets to discover transparent named screens or pass preset to run one, find_stock_peers for automatic peer candidates, get_stock_price_history for stored daily prices and deterministic technicals, and get_company_news for dated cached company articles with refresh and freshness caveats. Optional estimates, operating KPIs and transcripts depend on actual source coverage; do not promise them before checking availability. Use get_company_data_coverage for stored dataset availability, latest periods and actual collection/computation timestamps before deeper research. Use get_corporate_calendar for earnings, ex-dividend dates and recent first-trade listings (not a confirmed IPO calendar), compare_company_exposures for shared cached counterparties across 2-5 companies, and get_company_risk_history for retained category scores and descriptive input/basis changes. Missing coverage is unknown; shared relationships do not quantify hypothetical losses, and changing formula/coverage is not a business deterioration by itself. ";

export interface McpServerOptions {
  /** No account, portfolio, draft or shortlist tools and no prompts: every tool works anonymously. */
  researchOnly?: boolean;
  /** An mcprush gateway session: research only, marketplace instructions and bounded results. */
  marketplace?: boolean;
  legacyTools?: boolean;
}

/** Neutral description of the continuation links platformLinks.ts adds to results. */
const PLATFORM_LINK_NOTE = "Results can include an optional platformLink (label, url and description) and a matching resource_link to the same view on bull-run.org; each description states which tool settings that page does not reproduce. ";
const MARKETPLACE_SCOPE_GUIDANCE = "Use compare_stocks for a compact comparison of 2-5 exact stock tickers, screen_stocks and screen_etfs for discovery, and the focused company, ETF, risk, valuation and macro tools for further research. Read coverage, reporting periods, currencies, source dates and warnings before comparing figures. Missing data is unknown. Risk scores and model valuation gaps are descriptive measurements, not buy/sell recommendations or price targets. ";
const COMPARE_GUIDANCE = "Use compare_stocks for a compact comparison of 2-5 exact stock tickers with explicit period, currency and coverage differences. ";
const RISK_GUIDANCE = "Company risk and relationships: get_company_risk returns a stock's 0-100 composite risk score, six mechanism dials (market expectation, operating pressure, cash conversion, leverage, competitive position, concentration), filing-derived risk factors, supplier concentration and recent events; get_company_relationships returns its named competitors, suppliers, customers and partners with verification status and quantified dependence; screen_risk_board ranks the universe by composite or one dial (filter by band/sector/country); get_risk_movers lists band changes in the last N days. Bands (Contained/Normal/Elevated/Stretched/Acute) describe measured strain, never a buy/sell view, and a dark dial is unmeasured, not safe. ";
const MACRO_GUIDANCE = "Global markets and macro: get_global_markets_overview is the one-call market briefing (indices, policy rates, 10Y yields, FX, commodities, macro tiles, economic calendar, news); get_country_macro gives one country's macro stress score and its inputs; get_macro_indicators ranks or compares countries on one indicator; get_macro_history returns a series' history by the historyCode the other tools return, an instrument name (\"Fed\", \"Brent\", \"Germany 10Y\") or indicator + country. ";
const MODEL_GUIDANCE = "Bullrun's own ML models: get_valuation_model gives 1-10 stocks' valuation gap (model-typical vs current P/E or price/sales; positive = trades below its typical multiple) and relative forecast signal; screen_valuation_model ranks the scored universe by either end of a model. Present the valuation gap as descriptive context, never as a price target or prediction. ";
const etfGuidance = (signedIn: boolean): string => "For ETFs: screen_etfs is the whole-universe screen and the right default for any ranking question (cheapest, largest, best performing, most liquid, or \"which funds hold X\" via its holdingSearch look-through); search_etfs looks up a known fund by name, ticker or ISIN; get_etf_filter_options lists the exact strings the categorical filters accept, so call it before guessing a category, region, index key or issuer; get_etf_index_group answers \"cheapest way to track <index>\" with one row per FUND rather than per venue listing; get_etf_fund resolves an ISIN (or any venue ticker) to the fund and all the venues it trades on — reach for it whenever the user quotes an ISIN or asks which line to buy; get_etf_snapshot for requested snapshot modules; get_etf_timeseries for price/history coverage; get_etf_holdings and get_etf_exposures for explicit partial/full look-through; get_etf_risk for price risk; compare_etfs for selected comparison modules, including overlap for pairwise shared holdings; " +
  (signedIn ? "get_portfolio_analytics with candidateTicker and includeLookThrough=true for ETF fit against a signed-in portfolio; " : "") +
  "and simulate_etf_cost for deterministic cost scenarios. Expense ratios and yields are always percentage points in tool inputs and outputs, never fractions. The same UCITS fund is listed on several venues under different tickers: treat those as ONE holding, never as diversification. Read every coverage/warnings field: unavailable NAV, total-return, factor, thematic, benchmark, spread, fee, or holdings data is never synthesized, and a fund missing a metric is excluded by any rule on it. ";
const STOCK_DATA_GUIDANCE = "Use screen_stocks to find stocks across the global universe by fundamentals (sector/industry/country, market cap, P/E, dividend yield, revenue growth), search_etfs to find a known ETF and get_etf_snapshot for its details, get_stock_metrics to pull a consolidated snapshot for one exact stock ticker, get_financial_history for multi-year annual/quarterly statements, CAGRs, margins, and growth consistency checks, and get_quality_moat_metrics for annual ROIC, ROIC-vs-supplied-WACC, accruals, cash conversion, capex intensity, dividends, share-count changes, and capital-allocation caveats. Use get_forward_estimates for available consensus revenue/EPS and EPS revisions with cached refresh, reporting-period and currency caveats; this feed does not populate EBITDA, guidance or revenue revisions; get_operating_kpis for domain KPIs such as ARR, NRR, RPO, billings, customer counts, payment volume, cross-border volume, and processed transactions; get_revenue_breakdown for segment/geography/product revenue splits; and get_earnings_call_transcript for stored speaker-tagged US call text, with a bounded asynchronous import of the latest two calls. Operating KPI observations remain limited; never imply broad KPI or non-US transcript coverage. ";
const PORTFOLIO_GUIDANCE = "Whenever the user talks about THEIR OWN portfolio, holdings, positions, or investments (\"my portfolio\", \"how am I doing\", \"what should I improve/buy/add\", \"is my portfolio diversified\", \"how risky am I\"), reach for the per-user portfolio tools rather than answering from general knowledge. When the user has connected their Bullrun account, list_portfolios lists their own virtual portfolios (start here when no specific portfolio is named), get_portfolio_context returns a deep snapshot of one (holdings, weights, value, insights — use for \"analyze/review my portfolio\"), and get_portfolio_analytics returns portfolio-level relationship analytics: correlation/covariance matrices, contribution-to-risk, factor proxy exposure, sector/currency/country concentration, stress scenarios, and optional candidateTicker fit analysis with opt-in ETF holdings look-through via includeLookThrough (use for diversification/risk/concentration questions and \"should I add <ticker>\"). create_portfolio_draft builds a new paper portfolio saved as a draft for GUI review (\"build me a portfolio\"); create_position_draft proposes additions to an existing portfolio saved as a draft for GUI review (\"what should I buy next\"). Draft tools never change live holdings by themselves. create_portfolio_from_positions saves a portfolio you have ALREADY designed from an explicit {ticker, weight|amountUsd} basket (used verbatim, never re-picked) and is available to signed-in free accounts within usage limits — prefer it over create_portfolio_draft whenever the exact holdings are already decided. get_capabilities reports the connected identity, MCP usage tier, granted scopes, and portfolio capacity — call it first when account permissions or capacity are unclear or to confirm which account you are acting on. Before calling either draft tool, scope the request in ONE short step: if the user has already been specific (style, region, size, or which portfolio), go straight to the tool; if the request is vague (e.g. just \"build me a portfolio\" or \"what should I buy\"), ask a single round of at most three multiple-choice questions first. For a NEW portfolio ask investing style (income/dividends, growth, defensive, broad-market, or a named theme), region focus (US, Europe, or global), and size (starting cash and/or number of holdings). For additions to an EXISTING portfolio ask which portfolio (call list_portfolios first when the user has more than one) and how many ideas (a single best idea or a few). Give a sensible default with every question so the user can reply \"just pick for me\", then call the tool immediately with those defaults. Keep it to that one step — do not interrogate across multiple turns or re-ask anything the user already stated. Personal shortlist: save_research_shortlist adds explicit user-selected tickers and list_research_shortlist reads the saved queue; require their read:shortlist/write:shortlist scopes and never save without user intent. No monitoring or email is enabled by saving. Connect at https://mcp.bull-run.org/account/mcp when personal tools require OAuth. Usage: official public, research and OAuth MCP connections share 700 successful tool calls per rolling 30 days, per free account or anonymous network. Failed tool calls do not spend that allowance. Separate backend read safety limits and per-tool pacing can pause use earlier. Pro and active trials are outside the free call cap and retain fair use of 1,000 backend reads per rolling 5 hours. Website quotas are unchanged. When a call says an allowance ran out, relay that message as given. All portfolio draft features are available to free signed-in accounts within those limits. The per-user portfolio tools accept a privacyMode (\"full\" default, or \"weights_only\" to hide absolute money). All read tools are sourced from the Bullrun database.";

function instructionsFor(options: McpServerOptions): string {
  if (options.marketplace) {
    return RESEARCH_EXPANSION_GUIDANCE + "Bullrun market research through mcprush. " + MARKETPLACE_SCOPE_GUIDANCE + PLATFORM_LINK_NOTE +
      "This connection offers research only: personal portfolios, drafts and account access require a separate Bullrun OAuth connection. Mcprush enforces subscription call allowances; a research tool may perform multiple backend reads.";
  }
  const research = RESEARCH_EXPANSION_GUIDANCE + PLATFORM_LINK_NOTE + COMPARE_GUIDANCE + RISK_GUIDANCE + MACRO_GUIDANCE +
    MODEL_GUIDANCE + etfGuidance(!options.researchOnly);
  if (options.researchOnly) {
    return "Bullrun public market research, readable without sign-in. " + research + STOCK_DATA_GUIDANCE +
      "This connection has research tools only, no portfolio or account tools. Official public, research and OAuth MCP connections share 700 successful tool calls per rolling 30 days, per free account or anonymous network. Failed tool calls do not spend that allowance. Separate backend read safety limits and per-tool pacing can pause use earlier; one call can make several backend reads. Pro and active trials are outside the free call cap and retain fair use of 1,000 backend reads per rolling 5 hours. All tools read Bullrun's stored data.";
  }
  return research + "Bullrun market-data and portfolio tools. " + STOCK_DATA_GUIDANCE + PORTFOLIO_GUIDANCE;
}

/** The Claude directory reads a tool's display name from annotations.title, not the top-level title. */
function titleAnnotations(server: McpServer): void {
  type RegisterTool = (name: string, config: Record<string, unknown>, callback: unknown) => unknown;
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  const registerWithTitle: RegisterTool = (name, config, callback) => {
    const annotations = (config.annotations ?? {}) as Record<string, unknown>;
    return register(name, typeof config.title === "string" && annotations.title === undefined
      ? { ...config, annotations: { ...annotations, title: config.title } } : config, callback);
  };
  server.registerTool = registerWithTitle as unknown as typeof server.registerTool;
}

/**
 * Build a fresh MCP server instance with the market-data and portfolio tools registered.
 *
 * A new instance is created per session (the transport is stateless), so this must stay
 * cheap — it only wires tool definitions, no I/O. Per-request auth (and the caller's
 * forwarded token) is supplied out-of-band via the AsyncLocalStorage context, so the
 * ordinary public/OAuth sessions use the same wiring. Research-only sessions (the public
 * /research/mcp path and marketplace sessions) deliberately register research tools only.
 */
export function createMcpServer(requested: McpServerOptions = {}): McpServer {
  const options = { ...requested, researchOnly: requested.researchOnly || requested.marketplace };
  const server = new McpServer(
    { name: "bullrun-mcp", version: SERVER_VERSION },
    {
      instructions: instructionsFor(options),
    },
  );

  titleAnnotations(server);
  instrumentMcpTools(server);
  if (options.marketplace) boundMarketplaceResults(server);
  addPlatformLinks(server);
  // Research-only catalogs stay strictly read-only: their news, estimates and transcript reads
  // do not queue the background refresh that full sessions trigger.
  const feeds = { refresh: !options.researchOnly };

  registerScreenStocks(server);
  registerSearchStocks(server);
  if (options.legacyTools) registerScreenStockPresets(server);
  registerFindStockPeers(server);
  registerGetStockPriceHistory(server);
  registerGetCompanyNews(server, feeds);
  registerSearchEtfs(server);
  registerScreenEtfs(server);
  registerGetEtfIndexGroup(server);
  registerGetEtfFund(server);
  registerGetEtfFilterOptions(server);
  registerGetEtfSnapshot(server);
  registerGetEtfHoldings(server);
  registerGetEtfTimeseries(server);
  registerGetEtfExposures(server);
  registerGetEtfRisk(server);
  registerCompareEtfs(server);
  if (options.legacyTools) registerAnalyzeEtfOverlap(server);
  if (options.legacyTools && !options.researchOnly) registerAnalyzePortfolioFit(server);
  registerSimulateEtfCost(server);
  if (options.legacyTools) registerQueryEtfs(server);
  registerGetStockMetrics(server);
  registerCompareStocks(server);
  registerGetFinancialHistory(server);
  registerGetQualityMoatMetrics(server);
  registerGetForwardEstimates(server, feeds);
  registerGetOperatingKpis(server);
  registerGetRevenueBreakdown(server);
  registerGetEarningsCallTranscript(server, feeds);
  if (!options.researchOnly) {
    registerResearchShortlist(server);
    registerListPortfolios(server);
    registerGetPortfolioContext(server);
    registerGetPortfolioAnalytics(server);
    registerCreatePortfolioDraft(server);
    registerCreatePositionDraft(server);
    registerCreatePortfolioFromPositions(server);
    registerGetCapabilities(server);
  }
  registerGetCompanyRisk(server);
  registerGetCompanyRelationships(server);
  registerCompareCompanyExposures(server);
  registerGetCorporateCalendar(server);
  registerGetCompanyRiskHistory(server);
  registerGetCompanyDataCoverage(server);
  registerScreenRiskBoard(server);
  registerGetRiskMovers(server);
  registerGetGlobalMarketsOverview(server);
  registerGetCountryMacro(server);
  registerGetMacroIndicators(server);
  registerGetMacroHistory(server);
  registerGetValuationModel(server);
  registerScreenValuationModel(server);

  // Explicit, user-selectable entry points (Build / Suggest / Analyze) that appear
  // in the client's prompt menu and prime the scoping playbook above.
  if (!options.researchOnly) registerPrompts(server);

  return server;
}
