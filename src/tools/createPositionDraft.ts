import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";

interface AiDraftPosition {
  ticker: string;
  company: string | null;
  sector: string | null;
  country: string | null;
  weightPct: number;
  allocationUsd: number;
  quantity: number;
  avgPrice: number | null;
  currency: string | null;
  rationale: string | null;
  forecastPercentile: number | null;
  valuationPercentile: number | null;
  dividendYield: number | null;
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

interface DraftView {
  id: number;
  name: string;
  source: string;
  createdAt: string;
  positionCount: number;
  draft: AiDraft;
  draftType: "PORTFOLIO" | "POSITIONS";
  targetPortfolioId: number | null;
  targetPortfolioName: string | null;
}

interface PositionDraftCreated {
  draftId: number | null;
  status: "pending" | "empty";
  draft: DraftView | null;
}

export function registerCreatePositionDraft(server: McpServer): void {
  server.registerTool(
    "create_position_draft",
    {
      title: "Create a position draft",
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Use when the user asks what to BUY or ADD to an EXISTING portfolio — e.g. \"what should I buy next\", \"suggest a stock for my portfolio\", \"what should I add\", \"recommend a position\", \"any ideas to round out my holdings\". Generates REVIEWABLE suggested additions for one existing Bullrun portfolio. Requires OAuth with the write:drafts scope and a Bullrun Pro account. This is DRAFT-ONLY: the suggested position(s) are saved to the user's account and appear in the Bullrun Portfolio tab under Pending AI drafts, where the user reviews and accepts them into the target portfolio or discards them. It never changes live holdings by itself. To draft a whole new portfolio from scratch use create_portfolio_draft; to test whether a specific named ticker fits, use get_portfolio_analytics with candidateTicker. If it is unclear, first confirm which portfolio (use list_portfolios when the user has more than one) and how many ideas (a single best idea or a few) in ONE quick step; otherwise just build.",
      inputSchema: {
        portfolioId: z
          .number()
          .int()
          .positive()
          .describe("The Bullrun portfolio id to propose additions for. Use list_portfolios first if unsure."),
        maxPositions: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many suggested additions to save, 1-5. Use 1 for a single-position idea; default 3."),
      },
    },
    async ({ portfolioId, maxPositions }) => {
      try {
        requireUserScope("write:drafts");

        const created = await bullrunPost<PositionDraftCreated>(
          `/api/portfolios/${encodeURIComponent(portfolioId)}/position-drafts`,
          { maxPositions: maxPositions ?? null },
        );

        if (created.status === "empty" || !created.draft || created.draftId == null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                saved: false,
                message: "No suitable position suggestions were found for this portfolio right now.",
                portfolioId,
              }, null, 2),
            }],
          };
        }

        const draft = created.draft.draft;
        const payload = {
          saved: true,
          draftId: created.draftId,
          draftType: created.draft.draftType,
          targetPortfolioId: created.draft.targetPortfolioId,
          targetPortfolioName: created.draft.targetPortfolioName,
          message:
            "Saved as a pending position draft in your Bullrun account. Open the Portfolio tab and review it under Pending AI drafts to accept it into the target portfolio or discard it. This created a draft only and did not change live holdings.",
          name: draft.name,
          model: draft.model,
          notes: draft.notes,
          positions: draft.positions.map((p) => ({
            ticker: p.ticker,
            company: p.company,
            sector: p.sector,
            country: p.country,
            quantity: p.quantity,
            avgPrice: p.avgPrice,
            currency: p.currency,
            estimatedWeightPctAfterAccept: p.weightPct,
            rationale: p.rationale,
            forecastPercentile: p.forecastPercentile,
            valuationPercentile: p.valuationPercentile,
            dividendYield: p.dividendYield,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `create_position_draft failed: ${msg}` }] };
      }
    },
  );
}
