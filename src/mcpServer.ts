import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerScreenStocks } from "./tools/screenStocks.js";
import { registerQueryEtfs } from "./tools/queryEtfs.js";
import { registerSearchEtfs } from "./tools/searchEtfs.js";
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
import { registerPrompts } from "./prompts.js";

/**
 * Build a fresh MCP server instance with the market-data and portfolio tools registered.
 *
 * A new instance is created per session (the transport is stateless), so this must stay
 * cheap — it only wires tool definitions, no I/O. Per-request auth (and the caller's
 * forwarded token) is supplied out-of-band via the AsyncLocalStorage context, so the
 * tool wiring itself is identical for authenticated and anonymous sessions.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "bullrun-mcp", version: "0.2.0" },
    {
      instructions: "For ETFs, use search_etfs to screen funds; get_etf_snapshot for requested snapshot modules; get_etf_timeseries for price/history coverage; get_etf_holdings and get_etf_exposures for explicit partial/full look-through; get_etf_risk for price risk; compare_etfs and analyze_etf_overlap for fund comparisons; analyze_portfolio_fit for a signed-in portfolio; and simulate_etf_cost for deterministic cost scenarios. Read every coverage/warnings field: unavailable NAV, total-return, factor, thematic, benchmark, spread, or holdings data is never synthesized. query_etfs remains available for compatibility. " +
        "Bullrun market-data and portfolio tools. Use screen_stocks to find stocks across the global universe by fundamentals (sector/industry/country, market cap, P/E, dividend yield, revenue growth), query_etfs to search ETFs by ticker/fund name, category, focus, domicile, exchange and currency with profile, price and holdings detail for exact tickers, get_stock_metrics to pull a consolidated snapshot for one exact stock ticker, get_financial_history for multi-year annual/quarterly statements, CAGRs, margins, and growth consistency checks, and get_quality_moat_metrics for annual ROIC, ROIC-vs-supplied-WACC, accruals, cash conversion, capex intensity, dividends, share-count changes, and capital-allocation caveats. Use get_forward_estimates for consensus revenue/EPS/EBITDA, guidance, estimate revisions, and derived forward P/E/PEG context; get_operating_kpis for domain KPIs such as ARR, NRR, RPO, billings, customer counts, payment volume, cross-border volume, and processed transactions; get_revenue_breakdown for segment/geography/product revenue splits; and get_earnings_call_transcript for speaker-tagged management commentary and analyst Q&A. Whenever the user talks about THEIR OWN portfolio, holdings, positions, or investments (\"my portfolio\", \"how am I doing\", \"what should I improve/buy/add\", \"is my portfolio diversified\", \"how risky am I\"), reach for the per-user portfolio tools rather than answering from general knowledge. When the user has connected their Bullrun account, list_portfolios lists their own virtual portfolios (start here when no specific portfolio is named), get_portfolio_context returns a deep snapshot of one (holdings, weights, value, insights — use for \"analyze/review my portfolio\"), and get_portfolio_analytics returns portfolio-level relationship analytics: correlation/covariance matrices, contribution-to-risk, factor proxy exposure, sector/currency/country concentration, stress scenarios, and optional candidateTicker fit analysis (use for diversification/risk/concentration questions and \"should I add <ticker>\"). create_portfolio_draft builds a new paper portfolio saved as a draft for GUI review (\"build me a portfolio\"); create_position_draft proposes additions to an existing portfolio saved as a draft for GUI review (\"what should I buy next\"). Draft tools never change live holdings by themselves. Before calling either draft tool, scope the request in ONE short step: if the user has already been specific (style, region, size, or which portfolio), go straight to the tool; if the request is vague (e.g. just \"build me a portfolio\" or \"what should I buy\"), ask a single round of at most three multiple-choice questions first. For a NEW portfolio ask investing style (income/dividends, growth, defensive, broad-market, or a named theme), region focus (US, Europe, or global), and size (starting cash and/or number of holdings). For additions to an EXISTING portfolio ask which portfolio (call list_portfolios first when the user has more than one) and how many ideas (a single best idea or a few). Give a sensible default with every question so the user can reply \"just pick for me\", then call the tool immediately with those defaults. Keep it to that one step — do not interrogate across multiple turns or re-ask anything the user already stated. The per-user tools accept a privacyMode (\"full\" default, or \"weights_only\" to hide absolute money). All read tools are sourced from the Bullrun database.",
    },
  );

  registerScreenStocks(server);
  registerSearchEtfs(server);
  registerGetEtfSnapshot(server);
  registerGetEtfHoldings(server);
  registerGetEtfTimeseries(server);
  registerGetEtfExposures(server);
  registerGetEtfRisk(server);
  registerCompareEtfs(server);
  registerAnalyzeEtfOverlap(server);
  registerAnalyzePortfolioFit(server);
  registerSimulateEtfCost(server);
  registerQueryEtfs(server);
  registerGetStockMetrics(server);
  registerGetFinancialHistory(server);
  registerGetQualityMoatMetrics(server);
  registerGetForwardEstimates(server);
  registerGetOperatingKpis(server);
  registerGetRevenueBreakdown(server);
  registerGetEarningsCallTranscript(server);
  registerListPortfolios(server);
  registerGetPortfolioContext(server);
  registerGetPortfolioAnalytics(server);
  registerCreatePortfolioDraft(server);
  registerCreatePositionDraft(server);

  // Explicit, user-selectable entry points (Build / Suggest / Analyze) that appear
  // in the client's prompt menu and prime the scoping playbook above.
  registerPrompts(server);

  return server;
}
