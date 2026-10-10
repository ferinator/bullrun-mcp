import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { getAuth } from "../auth/context.js";

interface Capabilities {
  authenticated: boolean;
  userId: number | null;
  email: string | null;
  displayName: string | null;
  isPro: boolean;
  proSource: string | null;
  trialEndsAt: string | null;
  scopes: string[];
  portfolioCount: number;
  freePortfolioLimit: number;
  maxPortfolios: number;
  entitlements: Record<string, boolean>;
}

export function registerGetCapabilities(server: McpServer): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get account capabilities",
      annotations: { readOnlyHint: true },
      description:
        "Discover what the connected Bullrun account can do BEFORE attempting an action, so you can plan instead of learning by hitting a 403. Reports whether you are authenticated and as WHICH identity (email + userId), whether the account has Bullrun Pro and why (subscription / trial / admin), the granted OAuth scopes, portfolio usage vs the free/max limits, and a per-tool entitlement map: create_portfolio_from_positions (free), create_portfolio_draft and create_position_draft (Pro-only), and whether another portfolio can be created now. Call this first when a draft/write tool might be gated, or to confirm which account a request will act on. Read-only.",
      inputSchema: {},
    },
    async () => {
      const auth = getAuth();
      if (!auth || auth.userId == null) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              authenticated: false,
              message:
                "Not connected to a Bullrun account. Public market-data tools (screen_stocks, search_etfs, get_etf_snapshot, get_etf_holdings, get_stock_metrics, get_financial_history, get_company_risk, get_company_relationships, get_global_markets_overview, get_valuation_model, ...) work without auth; portfolio and draft tools require connecting your Bullrun account via OAuth.",
              scopes: auth?.scopes ?? [],
            }, null, 2),
          }],
        };
      }

      try {
        const caps = await bullrunGet<Capabilities>("/api/portfolios/capabilities");
        return { content: [{ type: "text", text: JSON.stringify(caps, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_capabilities failed: ${msg}` }] };
      }
    },
  );
}
