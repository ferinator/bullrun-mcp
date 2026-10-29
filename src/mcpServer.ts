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

const RESEARCH_GUIDANCE = [
  "Resolve company names, ISINs and ambiguous listings with search_stocks before exact-ticker research. Use screen_stocks (action=list_presets or preset) for discovery, find_stock_peers for peers, and compare_stocks for 2-5 stocks.",
  "Check get_company_data_coverage before optional research. All results use stored data: report source dates, periods, currencies, coverage and warnings. Daily prices are not live quotes or verified adjusted total returns. Missing data is unknown, never zero or synthesized. Estimates, curated KPIs and US transcripts have limited coverage; do not promise them before checking.",
  "Risk bands and model valuation/relative-forecast signals describe measurements, not investment recommendations, price targets or expected returns. A dark risk dial is unmeasured. Changes in formulas or coverage alone do not establish business deterioration. Cached relationships are incomplete; shared counterparties do not quantify hypothetical losses. Recent first-trade listings are not a confirmed IPO calendar.",
].join(" ") + " ";

export interface McpServerOptions {
  /** No account, portfolio, draft or shortlist tools and no prompts: every tool works anonymously. */
  researchOnly?: boolean;
  /** An mcprush gateway session: research only, marketplace instructions and bounded results. */
  marketplace?: boolean;
  legacyTools?: boolean;
}

/** Bound collection validation work before either SDK walks tool-input schemas. */
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

/** Registration seam shared by legacy sessions and the current-protocol adapter. */
export type McpServerFactory = (
  identity: { name: string; version: string },
  options: { instructions: string; maxToolInputElements: number },
) => McpServer;

/** Neutral description of the continuation links platformLinks.ts adds to results. */
const PLATFORM_LINK_NOTE = "Results may include an optional platformLink (label, url and description) and resource_link to the same view on bull-run.org; the description states which settings the page does not reproduce. ";
const ETF_GUIDANCE = [
  "For ETFs, use screen_etfs for whole-universe rankings or holdingSearch look-through, search_etfs for known funds, get_etf_filter_options for accepted categorical values, and get_etf_index_group for the cheapest funds tracking an index. Resolve ISINs and venue choices with get_etf_fund. Compare selected modules with compare_etfs; overlap is one of its modules.",
  "Treat venue listings of the same fund as one holding, not diversification. Expense ratios and yields use percentage points, never fractions. Read holdings coverage: partial overlap is a lower bound. Unavailable data must not be invented, and filters exclude funds missing the required metric.",
].join(" ") + " ";
const RESEARCH_ROUTING = [
  "Use get_stock_metrics for a snapshot, get_financial_history for annual/quarterly statements and growth (defaults to five fiscal years of annual rows), and focused quality, estimates, KPI, revenue, transcript or news tools for the requested evidence.",
  "Use get_company_risk for current risk, get_company_risk_history for retained changes, and company relationship/exposure tools for cached counterparties. For macro research start with get_global_markets_overview; get_macro_history accepts returned historyCode values. A positive ML valuation gap means a multiple below the model-typical multiple, not a price forecast.",
].join(" ") + " ";
const PORTFOLIO_GUIDANCE = [
  "For the user's own holdings, use account tools: list_portfolios when no portfolio is named, get_portfolio_context for holdings/value, and get_portfolio_analytics for risk, diversification or candidateTicker fit. Risk figures exclude holdings without sufficient history and renormalize over those analyzed; report the coverage gap. candidateTicker with includeLookThrough=true adds ETF look-through with separate coverage.",
  "Use get_capabilities when identity, scopes, usage or capacity is unclear. Account access requires OAuth at https://mcp.bull-run.org/account/mcp. privacyMode=weights_only hides absolute money; full is the default.",
  "create_portfolio_draft proposes a new paper portfolio; create_position_draft proposes additions. They save reviewable drafts and never change holdings until accepted in Bullrun. Prefer create_portfolio_from_positions for already-decided explicit holdings; preserve the basket verbatim. Draft features are available to free signed-in accounts within usage/capacity limits.",
  "If a draft request is specific, proceed. Otherwise ask once, at most three multiple-choice questions with defaults: new portfolio style, region and size; additions need portfolio and number of ideas. Honor 'just pick for me' and do not re-ask supplied details.",
  "save_research_shortlist saves only explicit user-selected tickers; list_research_shortlist reads them. Require write:shortlist/read:shortlist scopes respectively. Saving enables no monitoring or email.",
].join(" ") + " ";
const USAGE_GUIDANCE = "Official public, research and OAuth connections share 700 successful tool calls per rolling 30 days, per free account or anonymous network. Connected Pro and active trials get 1,000 successful tool calls per rolling 5 hours. Each successful call counts once regardless of backend reads; failures use no allowance. Earlier calls leaving the window refill it. Follow retry guidance for pacing/capacity limits and relay allowance messages as given. Website and marketplace allowances are separate.";

function instructionsFor(options: McpServerOptions): string {
  if (options.marketplace) {
    return "Bullrun market research through mcprush. " + RESEARCH_GUIDANCE + ETF_GUIDANCE + RESEARCH_ROUTING + PLATFORM_LINK_NOTE +
      "Research only: personal portfolios, drafts and account access require a separate Bullrun OAuth connection. Mcprush enforces subscription call allowances; tools may perform multiple backend reads.";
  }
  const research = RESEARCH_GUIDANCE + ETF_GUIDANCE + RESEARCH_ROUTING + PLATFORM_LINK_NOTE;
  if (options.researchOnly) {
    return "Bullrun public market research, readable without sign-in. " + research +
      "Research tools only; no portfolio or account tools. " + USAGE_GUIDANCE;
  }
  return "Bullrun market-data and portfolio tools. " + research + PORTFOLIO_GUIDANCE + USAGE_GUIDANCE;
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
export function createMcpServer(
  requested: McpServerOptions = {},
  buildServer: McpServerFactory = (identity, options) => new McpServer(identity, options),
): McpServer {
  const options = { ...requested, researchOnly: requested.researchOnly || requested.marketplace };
  const server = buildServer(
    { name: "bullrun-mcp", version: SERVER_VERSION },
    {
      instructions: instructionsFor(options),
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
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
