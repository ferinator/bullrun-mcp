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
        "Discover what the connected Bullrun account can do BEFORE attempting an action, so you can plan instead of learning by hitting a 403. Reports whether you are authenticated and as WHICH identity (email + userId), whether the account has uncapped daily usage and why (subscription / trial / admin), the granted OAuth scopes, portfolio usage vs the free/max limits, and a per-tool entitlement map: create_portfolio_from_positions, create_portfolio_draft and create_position_draft (all available to signed-in free accounts, subject to usage limits), and whether another portfolio can be created now. Call this first when a draft/write tool might be gated, or to confirm which account a request will act on. Read-only.",
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
                "Not connected to a Bullrun account. Public market-data tools (screen_stocks, search_etfs, get_etf_snapshot, get_etf_holdings, get_stock_metrics, get_financial_history, get_company_risk, get_company_relationships, get_global_markets_overview, get_valuation_model, ...) work without auth; personal shortlist, portfolio and draft tools require connecting your Bullrun account via OAuth at https://mcp.bull-run.org/account/mcp.",
              scopes: auth?.scopes ?? [],
            }, null, 2),
          }],
        };
      }

      try {
        const caps = await bullrunGet<Capabilities>("/api/portfolios/capabilities");
        const shortlist = { read: auth.scopes.includes("read:shortlist"), save: auth.scopes.includes("write:shortlist") };
        const payload = { ...caps, shortlist, usageModel: "Features are available to signed-in free accounts subject to daily usage and portfolio limits. isPro denotes uncapped daily usage; it does not unlock extra features." };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_capabilities failed: ${msg}` }] };
      }
    },
  );
}
