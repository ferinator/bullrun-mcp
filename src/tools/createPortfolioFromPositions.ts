import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";

interface AiDraftPosition {
  ticker: string;
  company: string | null;
  sector: string | null;
  country: string | null;
  instrumentType?: string | null;
  weightPct: number;
  allocationUsd: number;
  quantity: number;
  avgPrice: number | null;
  currency: string | null;
  rationale: string | null;
}

interface AiDraft {
  name: string;
  startingCash: number;
  cashPct: number;
  cashBalance: number;
  positions: AiDraftPosition[];
  notes: string[];
  model: string;
  fallback: boolean;
}

interface BasketDraftResponse {
  draftId: number | null;
  status: "pending" | "empty";
  draft: AiDraft;
  unresolved: string[];
}

const positionSchema = z.object({
  ticker: z
    .string()
    .describe("Exact Bullrun ticker, used verbatim (never re-picked), e.g. VWCE.DE, SMH, ROG.SW."),
  weight: z
    .number()
    .positive()
    .optional()
    .describe(
      "Target weight as a PERCENT (e.g. 46 for 46%). If the weights across positions sum to <=100 the remainder is held as cash; any other sum is normalised to fully invested. Use weight OR amountUsd across the basket, not both.",
    ),
  amountUsd: z
    .number()
    .positive()
    .optional()
    .describe("Explicit USD amount to allocate to this holding. If ANY position uses amountUsd, sizing is by amount for all."),
});

export function registerCreatePortfolioFromPositions(server: McpServer): void {
  server.registerTool(
    "create_portfolio_from_positions",
    {
      title: "Save a portfolio from explicit holdings",
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Use when YOU (or the user) have ALREADY decided the exact holdings and want them saved as-is — e.g. after researching and settling on a specific basket with target weights. Persists a REVIEWABLE paper-portfolio draft built from the tickers you supply, sized by weight (percent) or by explicit USD amount. Unlike create_portfolio_draft this does NOT use the LLM and NEVER re-selects tickers: your basket lands exactly as given. Like the other draft tools it is available to signed-in free accounts within daily usage limits and portfolio capacity, and needs OAuth with the write:drafts scope. DRAFT-ONLY: the draft is saved to the user's Bullrun account and appears in the Portfolio tab under \"Pending AI drafts\", where the user reviews it and explicitly accepts it (creating a NEW portfolio) or discards it — it never changes any live position. Tickers must exist in Bullrun's priced stock/ETF universe; any that cannot be priced are returned in `unresolved` and skipped (use search_etfs / get_etf_snapshot / screen_stocks / get_stock_metrics to confirm exact tickers first). For a vague brief where the model should pick, use create_portfolio_draft instead.",
      inputSchema: {
        positions: z
          .array(positionSchema)
          .min(1)
          .max(30)
          .describe("The exact holdings to persist (1-30). Tickers are used verbatim, never re-selected."),
        name: z.string().max(72).optional().describe("Portfolio name. Default \"Custom Portfolio Draft\"."),
        startingCash: z
          .number()
          .min(100)
          .max(100_000_000)
          .optional()
          .describe("Total portfolio cash in USD. Default 10000 in weight mode; the sum of amounts in amount mode."),
        cashPct: z
          .number()
          .min(0)
          .max(95)
          .optional()
          .describe("Explicit cash percentage to hold back. Overrides the weight-remainder rule."),
      },
    },
    async ({ positions, name, startingCash, cashPct }) => {
      try {
        requireUserScope("write:drafts");

        const res = await bullrunPost<BasketDraftResponse>("/api/portfolios/draft-basket", {
          name: name ?? null,
          startingCash: startingCash ?? null,
          cashPct: cashPct ?? null,
          positions,
        });

        if (res.status === "empty" || res.draftId == null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                saved: false,
                message:
                  "None of the supplied tickers could be priced from Bullrun's universe, so no draft was saved. Check the exact tickers with search_etfs / get_etf_snapshot / get_stock_metrics and retry.",
                unresolved: res.unresolved ?? [],
              }, null, 2),
            }],
          };
        }

        const draft = res.draft;
        const payload = {
          saved: true,
          draftId: res.draftId,
          message:
            'Saved as a pending draft in your Bullrun account. Use the returned review link to open this exact draft and accept it (creates a new portfolio) or discard it. This created a draft only and did not change any live positions.',
          name: draft.name,
          startingCashUsd: draft.startingCash,
          cashPct: draft.cashPct,
          unresolved: res.unresolved ?? [],
          notes: draft.notes,
          positions: draft.positions.map((p) => ({
            ticker: p.ticker,
            company: p.company,
            instrumentType: p.instrumentType ?? null,
            weightPct: p.weightPct,
            allocationUsd: p.allocationUsd,
            quantity: p.quantity,
            avgPrice: p.avgPrice,
            currency: p.currency,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `create_portfolio_from_positions failed: ${msg}` }] };
      }
    },
  );
}
