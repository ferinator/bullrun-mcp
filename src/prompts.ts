import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP prompts = explicit, discoverable entry points. They surface in MCP clients
 * (e.g. Claude's "+"/attachment menu) as selectable actions, complementing the
 * conversational scoping playbook baked into the server `instructions` + tool
 * descriptions. Each prompt only primes the conversation with a user-role message;
 * the real work is done by tools, which enforce authentication, scopes and usage limits.
 *
 * Arguments are intentionally plain optional strings (MCP prompt arguments are
 * always strings): when supplied they pre-fill the brief; when omitted the primed
 * message tells the model to run ONE short scoping round before calling the tool.
 */

/** Render an optional "- Label: value" line, or "" when the argument was not given. */
function line(label: string, value?: string): string {
  const v = value?.trim();
  return v ? `\n- ${label}: ${v}` : "";
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "find_ml_candidates",
    {
      title: "Compare ML research candidates",
      description: "Find a small stock research list using stored Bullrun ML scores, then compare fundamentals and measured risk. No server-side AI generation or automatic saving.",
      argsSchema: {
        country: z.string().trim().max(100).optional().describe("Optional exact country, e.g. Germany, Japan or United States; not a region such as Europe."),
        sector: z.string().trim().max(100).optional().describe("Optional exact sector, e.g. Technology or Healthcare."),
        basis: z.enum(["valuation", "forecast"]).optional().describe("valuation (default) compares pricing with fundamentals; forecast is a relative return-rank signal."),
      },
    },
    ({ country, sector, basis }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        "Find a small set of stock research candidates using Bullrun's stored ML scores." +
        line("Country", country) + line("Sector", sector) + line("Basis", basis ?? "valuation") +
        '\n\nCall screen_valuation_model once with model="' + (basis === "forecast" ? "forecast_annual_1y" : "valuation_annual_1y") +
        '", end="top", coverage="full" and limit=5, passing only the supplied country and sector filters. Respect the returned scan and coverage limits; an empty result is valid. ' +
        'For two or more matches, compare at most three returned exact tickers with compare_stocks, including fundamentals, quality, valuation and risk. For one match use get_stock_metrics and get_company_risk. ' +
        "Explain the main differences, source dates, currencies and missing data. If forecast scores were requested, retain their returned rank context instead of substituting valuation scores. " +
        "A valuation gap is descriptive pricing context, not an expected return or buy signal; a forecast score is a relative rank, not a price target. Reuse returned scores instead of recomputing them or requesting server-generated research. " +
        "Show a useful returned Bullrun continuation link. Do not save a shortlist or create a portfolio unless I explicitly request that action.",
      } }],
    }),
  );

  server.registerPrompt(
    "compare_ucits_costs",
    {
      title: "Compare UCITS costs and overlap",
      description: "Find UCITS funds for an index, compare ongoing fees and available holdings overlap, and show where assumptions or coverage limit the comparison.",
      argsSchema: {
        index: z.string().trim().min(1).max(120).describe("Tracked index name or returned indexKey, e.g. S&P 500, MSCI World or FTSE All-World."),
        payout: z.enum(["accumulating", "distributing"]).optional().describe("Optional preferred distribution policy; use the exact supported filter value after discovery."),
      },
    },
    ({ index, payout }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `Compare UCITS funds tracking ${index.trim()}.` + line("Distribution preference", payout) +
        "\n\nUse get_etf_filter_options or get_etf_index_group without an indexKey to resolve the exact supported index key; never guess a key. Then use get_etf_index_group with that key and scope=ucits, applying my payout preference only with a supported filter. " +
        "Compare up to three returned funds with disclosed fees, domicile, payout and trading venues. Use compare_etfs with costs and overlap modules for two or more exact listing tickers, choosing one listing per distinct fund ISIN; multiple venue listings of the same fund are not diversification. " +
        "Ongoing expense ratio is only one cost component. Do not invent spreads, broker fees, tax effects or tracking difference, and do not call a truncated or partial set the exhaustive cheapest choice. Show snapshot dates and incomplete-holdings warnings; overlap based on partial holdings is a lower bound. " +
        "Use simulate_etf_cost only if I supply an investment amount/horizon and any extra cost assumptions it needs. Show the returned index or fund comparison link. Do not save or create a portfolio unless I explicitly ask.",
      } }],
    }),
  );

  server.registerPrompt(
    "research_shortlist_briefing",
    {
      title: "Brief my saved research shortlist",
      description: "Review up to five saved research entries with stored price dates, a compact comparison and optional dated news. Requires a connected Bullrun account; no monitoring is scheduled.",
      argsSchema: {
        focus: z.string().trim().max(160).optional().describe("Optional angle, e.g. valuation, business quality, ETF costs or recent company news."),
      },
    },
    ({ focus }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        "Give me a concise briefing on my saved Bullrun Research Shortlist." + line("Focus", focus) +
        "\n\nStart with list_research_shortlist. If authentication or read:shortlist is missing, explain how to reconnect at https://mcp.bull-run.org/account/mcp; do not pretend an empty response means I have no saved items. " +
        "If the shortlist is empty, explain how I can explicitly save researched exact tickers using save_research_shortlist. Otherwise use up to five entries, say which entries were selected and how many were omitted, and retain the returned quoteType and stored price dates. " +
        "Use compare_stocks for two or more equities and compare_etfs for two or more ETFs; use the appropriate snapshot for a single entry. Do not send ETF symbols to stock-only tools or guess an unknown instrument type. " +
        "If recent company news is relevant, call get_company_news for at most three selected equities and show publication dates and cache freshness. Missing coverage is unknown, not proof there was no news or risk. " +
        "Keep this briefing compact and show a useful returned link to my shortlist or research. Do not add/remove entries, create a portfolio, schedule monitoring or send notifications.",
      } }],
    }),
  );

  server.registerPrompt(
    "build_portfolio",
    {
      title: "Build a portfolio",
      description:
        "Start building a brand-new paper portfolio in Bullrun, saved as a reviewable draft. Optionally pre-fill investing style, region focus, and size.",
      argsSchema: {
        style: z
          .string()
          .optional()
          .describe("Investing style, e.g. dividend income, growth, defensive, broad-market, quality/moat, or value."),
        region: z.string().optional().describe("Region focus, e.g. US, Europe, or Global."),
        size: z
          .string()
          .optional()
          .describe("Approximate size, e.g. $10k, $25k, $50k, or a number of holdings."),
        universe: z
          .string()
          .optional()
          .describe("Instrument universe: stocks, ETFs, or mix."),
      },
    },
    ({ style, region, size, universe }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "I want to build a new portfolio in Bullrun." +
              line("Style", style) +
              line("Region", region) +
              line("Size", size) +
              line("Universe", universe) +
              '\n\nHelp me create it. If any of style, region, or size is missing, ask me in ONE quick round of at most three multiple-choice questions — each with a sensible default I can accept by saying "just pick for me" — then call create_portfolio_draft to generate a reviewable draft. Do not interrogate me across multiple turns. This only creates a draft I review in the Portfolio tab; it never changes my live holdings.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "suggest_positions",
    {
      title: "Suggest positions to add",
      description:
        "Get reviewable suggestions for stocks to add to one of your existing Bullrun portfolios. Optionally name the portfolio and how many ideas.",
      argsSchema: {
        portfolio: z
          .string()
          .optional()
          .describe("Which portfolio to add to (name or id). If omitted, list_portfolios is used to pick."),
        count: z
          .string()
          .optional()
          .describe("How many ideas to propose, e.g. 1 for a single best idea or 3 for a few."),
        universe: z
          .string()
          .optional()
          .describe("Instrument universe: stocks, ETFs, or mix."),
      },
    },
    ({ portfolio, count, universe }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Suggest positions to add to one of my existing Bullrun portfolios." +
              line("Portfolio", portfolio) +
              line("How many ideas", count) +
              line("Universe", universe) +
              "\n\nIf you do not know which portfolio, call list_portfolios first and ask me to pick (and how many ideas — one best idea or a few) in ONE quick step, then call create_position_draft. This saves a reviewable draft only; it never changes my live holdings.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "analyze_portfolio",
    {
      title: "Analyze my portfolio",
      description:
        "Review one of your Bullrun portfolios — holdings, weights, diversification, concentration, and risk. Optionally name the portfolio and a focus area.",
      argsSchema: {
        portfolio: z
          .string()
          .optional()
          .describe("Which portfolio to analyze (name or id). If omitted, list_portfolios is used to pick."),
        focus: z
          .string()
          .optional()
          .describe("Optional focus, e.g. risk, diversification, concentration, performance, or factor exposure."),
      },
    },
    ({ portfolio, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Analyze one of my Bullrun portfolios." +
              line("Portfolio", portfolio) +
              line("Focus", focus) +
              "\n\nStart with list_portfolios if no portfolio is named, then use get_portfolio_context and get_portfolio_analytics to assess holdings, weights, diversification, concentration, and risk. Tell me what stands out and give concrete, specific suggestions.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "stock_deep_dive",
    {
      title: "Stock deep dive",
      description:
        "Research one stock end to end with Bullrun's data: fundamentals, the Bullrun valuation model, company risk dials and its supplier/customer/competitor network.",
      argsSchema: {
        ticker: z.string().describe("The stock's Bullrun ticker, e.g. AAPL, ASML, NESN."),
        focus: z
          .string()
          .optional()
          .describe("Optional angle, e.g. valuation, supply-chain risk, balance sheet, or competition."),
      },
    },
    ({ ticker, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Give me a deep dive on ${ticker.trim().toUpperCase()}.` +
              line("Focus", focus) +
              "\n\nUse get_stock_metrics and get_financial_history for the business and its numbers, get_valuation_model for Bullrun's valuation gap and forecast signal, get_company_risk for the risk dials, filing risk factors and supplier concentration, and get_company_relationships for who it depends on and competes with. Close with the two or three things that matter most, the main risks, and what would change the picture. Treat the valuation gap and risk bands as context, not a recommendation.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "market_briefing",
    {
      title: "Market briefing",
      description:
        "A concise briefing on global markets and the macro backdrop from Bullrun's Global Markets data: indices, rates, yields, FX, commodities, the calendar and notable risk moves.",
      argsSchema: {
        region: z
          .string()
          .optional()
          .describe("Optional region or country to emphasise, e.g. US, Europe, Japan, or Germany."),
      },
    },
    ({ region }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Brief me on global markets today." +
              line("Emphasis", region) +
              "\n\nCall get_global_markets_overview (add the news section), then get_country_macro for the emphasised country if one is named and get_risk_movers for notable company risk changes this week. Keep it short: what moved, where rates and yields stand, what is on the calendar, and one or two macro risks worth watching. Use get_macro_history when a longer trend would help.",
          },
        },
      ],
    }),
  );
}
