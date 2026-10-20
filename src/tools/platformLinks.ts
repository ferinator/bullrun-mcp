import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PlatformLink {
  label: string;
  url: string;
  description: string;
}

type Payload = Record<string, unknown>;
const record = (value: unknown): Payload => value != null && typeof value === "object" && !Array.isArray(value) ? value as Payload : {};
const rows = (value: unknown): Payload[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const count = (value: unknown): number => typeof value === "number" ? value : 0;
const tickerOf = (payload: Payload, args: Payload): string => text(payload.ticker ?? args.ticker).toUpperCase();
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Only our canonical origin and four fixed attribution fields enter platform URLs.
 * No OAuth tokens, account identity, portfolio values or natural-language briefs are copied. */
export function platformLink(toolName: string, path: string, label: string, description: string, params?: URLSearchParams): PlatformLink {
  if (!/^[a-z_]+$/.test(toolName) || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid platform destination");
  const url = new URL(path, "https://bull-run.org");
  if (url.origin !== "https://bull-run.org") throw new Error("Invalid platform origin");
  params?.forEach((value, key) => url.searchParams.append(key, value));
  url.searchParams.set("utm_source", "mcp");
  url.searchParams.set("utm_medium", "assistant");
  url.searchParams.set("utm_campaign", toolName.startsWith("create_") ? "portfolio" : "research");
  url.searchParams.set("utm_content", toolName);
  return { label, url: url.toString(), description };
}

function countrySlug(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const STOCK_TOOLS = new Set([
  "get_stock_metrics", "get_financial_history", "get_quality_moat_metrics", "get_forward_estimates",
  "get_operating_kpis", "get_revenue_breakdown", "get_earnings_call_transcript", "get_company_risk", "get_company_relationships",
]);
const ETF_TOOLS = new Set(["get_etf_snapshot", "get_etf_holdings", "get_etf_timeseries", "get_etf_exposures", "get_etf_risk", "simulate_etf_cost"]);
const LINKED_TOOLS = new Set([
  "search_stocks", "screen_stock_presets", "find_stock_peers", "get_stock_price_history", "get_company_news",
  "get_corporate_calendar", "compare_company_exposures", "get_company_risk_history", "get_company_data_coverage",
  ...STOCK_TOOLS, ...ETF_TOOLS, "compare_stocks", "screen_stocks", "screen_risk_board", "get_risk_movers", "search_etfs", "screen_etfs", "query_etfs",
  "get_etf_fund", "get_etf_index_group", "get_etf_filter_options", "compare_etfs", "analyze_etf_overlap", "analyze_portfolio_fit",
  "get_global_markets_overview", "get_country_macro", "get_macro_indicators", "get_macro_history", "get_valuation_model", "screen_valuation_model",
  "save_research_shortlist", "list_research_shortlist", "list_portfolios", "get_portfolio_context", "get_portfolio_analytics", "create_portfolio_draft", "create_position_draft", "create_portfolio_from_positions",
]);
/** Stock pages offer a one-click Research Shortlist save; guests sign in first. */
const SAVE_STOCK = "Save it to your Research Shortlist from the page to come back to it.";
const RISK_SORT: Record<string, string> = { market_cap: "marketCap", score_desc: "score", score_asc: "score-asc", worsened: "move", improved: "improved", coverage: "coverage", name: "name" };
const MACRO_PATH: Record<string, string> = {
  gdp_growth: "gdp-growth", inflation: "inflation", government_debt: "government-debt", unemployment: "unemployment",
  youth_unemployment: "youth-unemployment", real_house_prices: "house-prices", house_price_to_income: "house-prices-vs-income",
  house_price_to_rent: "house-prices-vs-rent", credit_gap: "credit-gap", household_debt_service: "household-debt-service",
  household_credit: "household-credit", business_confidence: "business-confidence", consumer_confidence: "consumer-confidence", macro_stress: "stress",
};

/** Map each tool to implemented app routes, using normalized response state where available.
 * Related destinations explicitly disclose any state the app cannot reproduce. */
export function continuationFor(toolName: string, args: Payload, payload: Payload): PlatformLink | null {
  const link = (path: string, label: string, description: string, params?: URLSearchParams) => platformLink(toolName, path, label, description, params);
  if (payload.found === false || payload.saved === false) return null;

  if (toolName === "search_stocks") {
    const ticker = text(payload.resolvedTicker);
    return ticker ? link(`/stocks/${encodeURIComponent(ticker)}`, `Explore ${ticker}'s charts and financials`, `Opens the uniquely resolved listing. ${SAVE_STOCK} Ambiguous or suggested candidates are not automatically selected.`) : null;
  }
  if (toolName === "get_stock_price_history" || toolName === "get_company_news") {
    const ticker = tickerOf(payload, args);
    const hasData = rows(payload[toolName === "get_stock_price_history" ? "bars" : "articles"]).length > 0;
    return ticker && hasData ? link(`/stocks/${encodeURIComponent(ticker)}`, toolName === "get_company_news" ? `Read ${ticker}'s latest company news` : `Explore ${ticker}'s interactive price chart`,
      toolName === "get_company_news" ? "Review the company's current news and supporting data. The MCP publication cutoff and article limit are not applied to this page." : "Review the company's charts and supporting data. The MCP date window, aggregation and technical-indicator settings are not applied to this page.") : null;
  }
  if (toolName === "find_stock_peers") {
    const ticker = tickerOf(payload, args);
    return ticker && rows(payload.peers).length ? link(`/stocks/${encodeURIComponent(ticker)}`, `Explore ${ticker}'s charts and financials`, `Opens the subject company. ${SAVE_STOCK} The app does not reproduce this automatic peer selection or its comparison settings.`) : null;
  }

  if (toolName === "get_corporate_calendar") {
    const calendar = rows(payload.calendars).find(row => rows(row.events).length > 0);
    if (!calendar) return null;
    const tab = text(calendar.type) === "ex_dividend" ? "ex-dividend" : text(calendar.type) === "listings" ? "ipo" : "earnings";
    return link(`/calendar/${tab}`, `Browse the full ${tab === "ipo" ? "new-listings" : tab} calendar`, "Opens this calendar type with the app's default search and time window. MCP filters and result limits are not applied.");
  }
  if (toolName === "get_company_risk_history") {
    const ticker = tickerOf(payload, args);
    return ticker && rows(payload.history).length ? link(`/stocks/${encodeURIComponent(ticker)}/analysis#dials`, `Explore ${ticker}'s current risk dials`, "Opens the current risk analysis. The app does not reproduce this historical window or input-change comparison.") : null;
  }
  if (toolName === "get_company_data_coverage") {
    const ticker = tickerOf(payload, args);
    return ticker && rows(payload.datasets).length ? link(`/stocks/${encodeURIComponent(ticker)}`, `Explore ${ticker}'s charts and financials`, `Review supporting company data and charts. ${SAVE_STOCK} The app does not reproduce this dataset-availability manifest.`) : null;
  }
  if (toolName === "compare_company_exposures") {
    const company = rows(payload.companies).find(row => Object.keys(record(row.subject)).length > 0);
    const ticker = text(company?.ticker);
    return ticker ? link(`/stocks/${encodeURIComponent(ticker)}/analysis#network`, `Explore ${ticker}'s interactive company network`, "Opens the first covered company's network. The app does not reproduce the multi-company shared-counterparty comparison.") : null;
  }

  if (STOCK_TOOLS.has(toolName)) {
    const ticker = tickerOf(payload, args);
    const hasData = Object.keys(record(payload.identity)).length > 0 || Object.keys(record(payload.subject)).length > 0
      || ["latestPrice", "valuation", "latestFinancials"].some(key => payload[key] != null)
      || ["annual", "quarterly", "history", "estimates", "kpis", "breakdown", "chunks"].some(key => rows(payload[key]).length > 0)
      || (toolName === "get_company_risk" && Object.keys(record(payload.modules)).length > 0);
    if (!ticker || !hasData) return null;
    const analysis = toolName === "get_company_risk" || toolName === "get_company_relationships";
    return link(`/stocks/${encodeURIComponent(ticker)}${analysis ? "/analysis" : ""}${toolName === "get_company_relationships" ? "#network" : toolName === "get_company_risk" ? "#dials" : ""}`,
      toolName === "get_company_relationships" ? `Explore ${ticker}'s interactive company network` : analysis ? `Explore ${ticker}'s risk dials and evidence` : `Explore ${ticker}'s charts and financials`,
      toolName === "get_company_relationships" ? `Follow suppliers, customers and competitors with their evidence and measured dependence. ${SAVE_STOCK}`
        : analysis ? `See each risk dial with the filings and figures behind it. ${SAVE_STOCK}` : `Continue with Bullrun's charts and supporting data. ${SAVE_STOCK}`);
  }
  if (toolName === "screen_stocks" && payload.action !== "list_presets" || toolName === "screen_stock_presets" && payload.action === "run") {
    const query = record(payload.query);
    const filter = {
      version: 1, rules: query.rules ?? [], lookbackMode: query.lookbackMode ?? "annual", lookback: query.lookback ?? 3,
      sector: query.sector ?? "", industry: query.industry ?? "", country: query.country ?? "", countries: query.countries ?? [],
      includeSecondary: args.includeSecondary ?? false,
    };
    const sort = text(query.sortBy) || "marketCap";
    return link("/screener", "Open and save this stock screen", "Opens the same rules, reporting window, listing filters and sort in the interactive screener. Adjust it, then save it to a free account to rerun it later. The app displays its own result page size.",
      new URLSearchParams({ filter: JSON.stringify(filter), sortBy: sort === "revenueGrowth" ? "revenueGrowthPct" : sort, order: text(query.order) || "desc", includeInactive: String(args.includeInactive ?? false) }));
  }
  if (toolName === "screen_risk_board") {
    const filters = record(payload.filters);
    const params = new URLSearchParams();
    const mechanism = text(payload.mechanism);
    if (mechanism && mechanism !== "OVERALL") params.set("mechanism", mechanism);
    if (Array.isArray(filters.bands) && filters.bands.length) params.set("band", filters.bands.map(b => text(b).toLowerCase()).join(","));
    if (text(filters.sector)) params.set("sector", text(filters.sector));
    if (text(filters.country)) params.set("country", text(filters.country));
    if (count(filters.minDialsLit)) params.set("coverage", String(filters.minDialsLit));
    params.set("sort", RISK_SORT[text(payload.sortBy)] ?? "marketCap");
    return link("/analysis", "Open this risk screen on the Risk Board", "Opens the same mechanism, risk bands, sector, country, coverage floor and sort. The app starts on its first result page.", params);
  }
  if (toolName === "get_risk_movers") return link("/analysis", "See current risk band changes on the Risk Board", "Opens the current risk board. The historical mover window and stable-basis filter are not applied.", new URLSearchParams({ sort: payload.direction === "improving" ? "improved" : "move" }));

  if (ETF_TOOLS.has(toolName)) {
    const ticker = tickerOf(payload, args);
    const coverage = record(payload.coverage);
    const hasData = payload.found === true || count(payload.totalRowsAvailable) > 0 || count(coverage.priceRows) > 0
      || count(coverage.storedHoldingRows) > 0 || rows(record(payload.exposures).asset).length > 0
      || count(record(payload.metadata).sourceDailyBars) > 0 || record(payload.assumptions).storedExpenseRatioPct != null || text(record(payload.assumptions).currency) !== "";
    return ticker && hasData ? link(`/etfs/${encodeURIComponent(ticker)}`, `Explore ${ticker}'s holdings and price chart`, "Review this listing's profile, prices and holdings. Tool-specific analytical assumptions are not applied to the page.") : null;
  }
  if (toolName === "get_etf_fund") {
    const isin = text(record(payload.fund).fundIsin);
    return isin ? link(`/etfs/isin/${encodeURIComponent(isin)}`, "Compare this fund's trading venues", "Compare the available listings of the same fund and review its profile.") : null;
  }
  if (toolName === "get_etf_index_group" && text(payload.indexKey)) return link(`/etfs/index/${encodeURIComponent(text(payload.indexKey))}`, "Compare UCITS funds tracking this index", "Opens the app's UCITS index comparison. Tool-specific scope and distribution-policy filters are not carried over.");
  if (["compare_stocks", "compare_etfs", "analyze_etf_overlap", "get_valuation_model"].includes(toolName)) {
    const covered = toolName === "get_valuation_model"
      ? rows(payload.results).filter(row => row.scored === true)
      : toolName === "compare_stocks"
      ? rows(payload.coverage).filter(row => row.identityAvailable === true && (!row.quoteType || row.quoteType === "EQUITY"))
      : rows(payload.coverage).filter(row => row.identityAvailable === true || row.profileAvailable === true || count(row.priceRows) > 0 || count(row.holdingRows) > 0 || count(row.storedRows) > 0);
    const tickers = covered.map(row => text(row.ticker)).filter(Boolean);
    if (!tickers.length) return null;
    if (tickers.length === 1) return link(`/${toolName === "get_valuation_model" || toolName === "compare_stocks" ? "stocks" : "etfs"}/${encodeURIComponent(tickers[0])}`, toolName === "compare_etfs" || toolName === "analyze_etf_overlap" ? `Explore ${tickers[0]}'s holdings and price chart` : `Explore ${tickers[0]}'s charts and financials`, "Review the instrument's charts and supporting data.");
    return link(`/compare/${tickers.slice(0, 4).map(t => encodeURIComponent(t.toLowerCase())).join("-vs-")}`, tickers.length > 4 ? "Compare the first four side by side" : "Open this side-by-side comparison", `Compare profiles and charts side by side.${tickers.length > 4 ? " The app supports four instruments per comparison." : ""} Tool-specific analytical settings are not carried over.`);
  }
  if (toolName === "query_etfs" && record(payload.detail).identity != null) {
    const ticker = text(record(payload.detail).ticker);
    if (ticker) return link(`/etfs/${encodeURIComponent(ticker)}`, `Explore ${ticker}'s holdings and price chart`, "Review the fund's profile, prices and holdings.");
  }
  if (toolName === "screen_etfs") {
    const query = Object.keys(record(payload.query)).length ? record(payload.query) : args;
    const filters: Payload = {};
    for (const key of ["search", "assetClass", "category", "domicile", "region", "exchange", "currency", "indexKey", "distributionPolicy", "productType", "ucitsStatus", "issuer", "strategy", "benchmarkSearch", "marketDevelopment", "currencyHedged", "holdingSearch", "holdingMode", "holdingMinWeightPct"]) {
      if (query[key] != null) filters[key] = query[key];
    }
    filters.includeSecondary = query.includeSecondary === true;
    const rules = rows(query.rules).map(rule => ({ metric: rule.metric, operator: rule.operator ?? ">=", value: rule.value ?? "", valueMax: rule.valueMax ?? "", unit: rule.unit ?? "", groupId: rule.groupId ?? 1 }));
    const params = new URLSearchParams({ universe: "etfs", etfScreen: JSON.stringify({ version: 1, filters, rules, sortBy: text(query.sortBy) || "totalAssets", order: text(query.order) || "desc" }) });
    if (rules.length > 60 || params.toString().length > 16000) return link("/screener?universe=etfs", "Browse the ETF screener", "This screen is too large to carry in a link. The page opens without the MCP filters or sort; enter them again before running it.");
    return link("/screener", "Open this ETF screen and adjust its filters", `Loads the same fund filters, AND/OR rules, listing scope and sort for review before running. ${filters.includeSecondary ? "Each matching trading venue remains a separate listing." : "Results show one fund per ISIN, represented by its most liquid matching listing."} The app uses its own page size.`, params);
  }
  if (["search_etfs", "screen_etfs", "query_etfs", "get_etf_filter_options", "get_etf_index_group"].includes(toolName)) return link("/screener?universe=etfs", "Browse the ETF screener", "Browse funds and adjust filters in the app. This link opens the ETF screener without applying the MCP search filters or sort.");

  if (toolName.startsWith("create_") && positiveId(payload.draftId) && payload.saved === true) return link("/portfolio", "Review and track this paper portfolio", "Opens this exact pending draft. Accept it to track it as a paper portfolio with performance and risk, or discard it; opening the link does not change holdings.", new URLSearchParams({ draftId: String(payload.draftId) }));
  if (["get_portfolio_context", "get_portfolio_analytics", "analyze_portfolio_fit"].includes(toolName) && positiveId(args.portfolioId)) return link("/portfolio", "Track this portfolio's holdings and performance", "Opens the selected portfolio with its holdings, performance and risk.", new URLSearchParams({ portfolioId: String(args.portfolioId) }));
  if (["save_research_shortlist", "list_research_shortlist"].includes(toolName)) return link("/short-list", "Open your saved Research Shortlist", "Review your saved stock and ETF research queue. Saving does not enable monitoring or email.");
  if (toolName === "list_portfolios") return link("/portfolio", "Open your portfolios and pending drafts", "Review holdings and performance, and accept or discard pending drafts.");
  if (toolName === "get_global_markets_overview") return link("/markets", "Explore the global markets dashboard", "Explore market charts, country profiles and the economic calendar.");
  if (toolName === "get_country_macro" && text(payload.country) && count(record(payload.coverage).indicatorsHeld) > 0) return link(`/markets/country/${encodeURIComponent(countrySlug(text(payload.country)))}`, `Explore ${text(payload.country)}'s macro profile`, "Review this country's economic indicators and history.");
  if (toolName === "get_macro_history" && payload.found === true && text(payload.code)) return link("/markets", "Open this series in the chart explorer", "Opens this series in Bullrun's chart explorer. Date-window and resampling settings are selected in the app.", new URLSearchParams({ series: text(payload.code), title: text(payload.title) || text(payload.code) }));
  if (toolName === "get_macro_indicators") {
    const path = MACRO_PATH[text(payload.indicator)];
    return link(path ? `/markets/${path}` : "/markets", path ? "Compare countries on this indicator" : "Explore the global markets dashboard", path ? "Opens the indicator's country ranking. Country selections and ordering from the MCP result are not applied." : "Opens the markets dashboard; select quarterly GDP and countries in the app.");
  }
  if (toolName === "screen_valuation_model") return link("/ml", "Explore Bullrun's model rankings", "Opens the model explorer. Select the model, coverage, direction and filters in the app; this link does not apply the MCP screen.");
  return null;
}

function jsonPayload(result: CallToolResult): { payload: Payload; index: number } | null {
  let index = -1;
  let parsed: Payload | null = null;
  for (let i = 0; i < result.content.length; i++) {
    const block = result.content[i];
    if (block.type !== "text") continue;
    try {
      const value: unknown = JSON.parse(block.text);
      if (value != null && typeof value === "object" && !Array.isArray(value)) { parsed = record(value); index = i; break; }
    } catch { /* Coverage banners and other readable text remain in place. */ }
  }
  const structured = result.structuredContent;
  return structured ? { payload: structured, index } : parsed ? { payload: parsed, index } : null;
}

export function withPlatformLink(toolName: string, args: Payload, result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const source = jsonPayload(result);
  if (!source) return result;
  const continuation = continuationFor(toolName, args, source.payload);
  if (!continuation) {
    // Old handlers included generic entity links even when nothing was found.
    if (!("webPage" in source.payload)) return result;
    const { webPage: _oldPage, ...payload } = source.payload;
    const content = [...result.content];
    if (source.index >= 0) content[source.index] = { type: "text", text: JSON.stringify(payload, null, 2) };
    return { ...result, structuredContent: payload, content };
  }
  const payload = { ...source.payload, platformLink: continuation, webPage: continuation.url };
  const content = [...result.content];
  const json = { type: "text" as const, text: JSON.stringify(payload, null, 2) };
  if (source.index >= 0) content[source.index] = json;
  else content.push(json);
  // Markdown fallback works in text-only clients; resource_link is supported by SDK 1.29.
  const label = continuation.label.replace(/[\[\]\\]/g, "\\$&");
  content.push({ type: "text", text: `[${label}](${continuation.url}) — ${continuation.description}` });
  content.push({ type: "resource_link", uri: continuation.url, name: continuation.label, title: continuation.label, description: continuation.description, mimeType: "text/html" });
  return { ...result, structuredContent: payload, content };
}

/** Keep one response contract across all tool handlers, including their existing
 * readable coverage banners. Only explicitly mapped tools receive continuation links. */
export function addPlatformLinks(server: McpServer): void {
  type RegisterTool = (name: string, config: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => unknown;
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  const registerWithLinks: RegisterTool = (name, config, callback) => {
    if (!LINKED_TOOLS.has(name)) return register(name, config, callback);
    const outputSchema = config.outputSchema ? {
      ...record(config.outputSchema),
      platformLink: z.object({ label: z.string(), url: z.string().url(), description: z.string() }).optional(),
      webPage: z.string().url().optional(),
    } : undefined;
    return register(name, {
      ...config, ...(outputSchema ? { outputSchema } : {}),
      description: config.description,
    }, async (...callbackArgs) => {
      const result = await callback(...callbackArgs);
      if (result == null || typeof result !== "object" || !Array.isArray((result as CallToolResult).content)) return result;
      return withPlatformLink(name, record(callbackArgs[0]), result as CallToolResult);
    });
  };
  server.registerTool = registerWithLinks as unknown as typeof server.registerTool;
}
