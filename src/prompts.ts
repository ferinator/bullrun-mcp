import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP prompts = explicit, discoverable entry points. They surface in MCP clients
 * (e.g. Claude's "+"/attachment menu) as selectable actions, complementing the
 * conversational scoping playbook baked into the server `instructions` + tool
 * descriptions. Each prompt only primes the conversation with a user-role message;
 * the real work is done by the portfolio tools, which enforce auth / scopes / Pro.
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
