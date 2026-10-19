import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { BAND_SCALE, compactBoardEntry, type RiskBoardEntry } from "./riskData.js";

const inputSchema = {
  days: z.number().int().min(1).max(30).default(7)
    .describe("Look-back window in days for band changes."),
  direction: z.enum(["all", "worsening", "improving"]).default("all")
    .describe("Keep only companies whose composite got worse, got better, or both."),
  limit: z.number().int().min(1).max(100).default(20),
  minMarketCapUsd: z.number().nonnegative().optional()
    .describe("Only companies with at least this market capitalisation in USD, e.g. 1e9 for $1B+. Without it the list is dominated by micro-caps, whose scores move most."),
  stableBasisOnly: z.boolean().default(true)
    .describe("true (default) = only real movements. false also includes band changes caused purely by a category starting or stopping scoring (coverage changes, flagged basisChanged)."),
};

/** The most movers /risk-movers returns in one call. */
const UPSTREAM_MAX = 100;

export function registerGetRiskMovers(server: McpServer): void {
  server.registerTool(
    "get_risk_movers",
    {
      title: "Get risk movers",
      annotations: { readOnlyHint: true },
      description:
        "Companies whose Bullrun composite risk score crossed into a different band (e.g. Elevated -> Stretched, or Acute -> Stretched) within the last N days, with prior and current score, the move in points, and the input driving the reading. Use for \"what got riskier this week\", \"any risk deteriorations I should know about\", or to monitor a watchlist (pass the tickers to get_company_risk afterwards). Band changes, not small score drift, so every row changed a word on the page. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        // Over-fetch when filtering so a one-sided or size-floored view still fills `limit`.
        const filtering = args.direction !== "all" || args.minMarketCapUsd != null;
        const fetchLimit = filtering ? UPSTREAM_MAX : args.limit;
        const rows = await bullrunGet<RiskBoardEntry[]>("/api/company-intelligence/risk-movers", {
          days: args.days,
          limit: fetchLimit,
          stableBasisOnly: args.stableBasisOnly,
        });
        const matching = (rows ?? []).filter((r) => {
          if (args.minMarketCapUsd != null && !(r.marketCapUsd != null && r.marketCapUsd >= args.minMarketCapUsd)) return false;
          if (args.direction === "all") return true;
          const delta = r.delta ?? ((r.score ?? 0) - (r.priorScore ?? 0));
          return args.direction === "worsening" ? delta > 0 : delta < 0;
        });
        const filtered = matching.slice(0, args.limit);
        const capped = filtering && (rows?.length ?? 0) >= UPSTREAM_MAX && matching.length < args.limit;

        return toolResult({
          days: args.days,
          direction: args.direction,
          stableBasisOnly: args.stableBasisOnly,
          minMarketCapUsd: args.minMarketCapUsd ?? null,
          returned: filtered.length,
          movers: filtered.map(compactBoardEntry),
          bandScale: BAND_SCALE,
          warnings: [
            ...(filtered.length
              ? ["A band change is a change in measured strain on filings and market data, not a price call."]
              : [`No company changed band in the last ${args.days} days with these filters.`]),
            ...(capped
              ? [`Filters were applied to the ${UPSTREAM_MAX} movers the API returns at most; more qualifying companies may exist beyond them.`]
              : []),
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_risk_movers failed: ${msg}` }] };
      }
    },
  );
}
