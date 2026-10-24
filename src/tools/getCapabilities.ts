import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { getAuth } from "../auth/context.js";
import { CONNECT_ACCOUNT_MESSAGE } from "../auth/scopes.js";

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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Discover what the connected Bullrun account can do BEFORE attempting an action, so you can plan instead of learning by hitting a 403. Reports whether you are authenticated and as WHICH identity (email + userId), the account's Pro/trial status and why (subscription / trial / admin), the granted OAuth scopes, portfolio usage vs the free/max limits, and a per-tool entitlement map: create_portfolio_from_positions, create_portfolio_draft and create_position_draft (all available to signed-in free accounts, subject to usage limits), and whether another portfolio can be created now. Call this first when a draft/write tool might be gated, or to confirm which account a request will act on. Read-only.",
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
              message: `Public research is available without an account. ${CONNECT_ACCOUNT_MESSAGE}`,
              scopes: auth?.scopes ?? [],
            }, null, 2),
          }],
        };
      }

      try {
        const caps = await bullrunGet<Capabilities>("/api/portfolios/capabilities");
        const shortlist = { read: auth.scopes.includes("read:shortlist"), save: auth.scopes.includes("write:shortlist") };
        const payload = { ...caps, shortlist, usageModel: "Features are available to signed-in free accounts subject to usage and portfolio limits. Official public, research and OAuth MCP connections share an allowance of 700 successful tool calls per rolling 30 days, per free account or anonymous network. Failed tool calls do not spend it. Separate backend read safety limits and per-tool pacing can pause use earlier. Pro and active trials are outside the free call cap and retain fair use of 1,000 backend reads per rolling 5 hours; they do not unlock extra features. Website quotas are unchanged." };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_capabilities failed: ${msg}` }] };
      }
    },
  );
}
