import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import { parsePrivacyMode, summaryView, type PortfolioSummary } from "../privacy.js";

export function registerListPortfolios(server: McpServer): void {
  server.registerTool(
    "list_portfolios",
    {
      title: "List my portfolios",
      annotations: { readOnlyHint: true },
      description:
        "Use when the user refers to THEIR portfolio(s) or holdings — e.g. \"my portfolios\", \"what portfolios do I have\", \"how are my investments doing\", \"show my holdings\", \"my account\". Lists the signed-in Bullrun user's virtual portfolios with computed summaries: name, base currency, total value (USD), day change, cost basis and total return, plus position counts. Start here when a portfolio question doesn't name a specific portfolio, then pass a portfolioId to get_portfolio_context or get_portfolio_analytics. Requires connecting this server to a Bullrun account (OAuth, read:portfolios scope) — it returns that user's own data only. privacyMode defaults to \"full\" (includes absolute $ amounts); pass \"weights_only\" to hide absolute money and return only relative figures (returns %, counts). Read-only.",
      inputSchema: {
        privacyMode: z
          .enum(["full", "weights_only"])
          .optional()
          .describe('"full" (default) includes absolute $; "weights_only" hides cash/value/cost-basis and keeps only %.'),
      },
    },
    async ({ privacyMode }) => {
      try {
        requireUserScope("read:portfolios");
        const mode = parsePrivacyMode(privacyMode);
        const portfolios = await bullrunGet<PortfolioSummary[]>("/api/portfolios");
        const payload = {
          privacyMode: mode,
          count: portfolios.length,
          portfolios: portfolios.map((p) => summaryView(p, mode)),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `list_portfolios failed: ${msg}` }] };
      }
    },
  );
}
