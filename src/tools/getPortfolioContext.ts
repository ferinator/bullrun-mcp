import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import {
  computeCoverage,
  parsePrivacyMode,
  positionsView,
  summaryView,
  type PortfolioSummary,
  type PositionView,
} from "../privacy.js";

/** GET /api/portfolios/{id} (PortfolioController.PortfolioDetail DTO). */
interface PortfolioDetail {
  summary: PortfolioSummary;
  /** "full" = ML fields populated; "locked" = nulled (the user isn't Pro). */
  mlAccess: string;
  positions: PositionView[];
  activity: ActivityItem[];
}

interface ActivityItem {
  id: number;
  symbol: string | null;
  txType: string | null;
  quantity: number | null;
  price: number | null;
  createdAt: string | null;
}

/** GET /api/portfolios/{id}/insights (PortfolioAnalyticsService.Insight). */
interface Insight {
  tone: string;
  text: string;
}

export function registerGetPortfolioContext(server: McpServer): void {
  server.registerTool(
    "get_portfolio_context",
    {
      title: "Get portfolio context",
      annotations: { readOnlyHint: true },
      description:
        "Use when the user asks to look at, review, or analyze THEIR portfolio / holdings / positions — e.g. \"analyze my portfolio\", \"how is my portfolio doing\", \"what's in my portfolio\", \"review my holdings\", \"how am I invested\", \"what should I improve\". Fetches a deep snapshot of ONE of the signed-in user's portfolios: the summary (value, day change, total return), every holding (with position weight %, sector and return) and Bullrun's computed insights (benchmark comparison, concentration, diversification, dividend income). Pass a portfolioId from list_portfolios (call that first if the user hasn't named a portfolio). The response ALWAYS returns the complete holdings list with each position flagged matched/unmatched, plus a `coverage` summary: holdings that Bullrun can't link to its universe (ETFs, funds, untracked tickers) carry no weight, sector, insight or ML score, so weights/insights/ML below describe ONLY the matched subset. Read the coverage banner (the first text block) and never present matched-only figures as the whole portfolio. For risk/diversification math, correlations, factor exposure, or whether to add a specific stock, use get_portfolio_analytics instead. Requires OAuth (read:portfolios) and returns the caller's own data only. privacyMode defaults to \"full\" (absolute $ included); \"weights_only\" returns only relative figures. Read-only.",
      inputSchema: {
        portfolioId: z
          .number()
          .int()
          .positive()
          .describe("The portfolio id, as returned by list_portfolios."),
        days: z
          .number()
          .int()
          .min(7)
          .max(3700)
          .optional()
          .describe("Insights look-back window in days (default 30)."),
        privacyMode: z
          .enum(["full", "weights_only"])
          .optional()
          .describe('"full" (default) includes absolute $; "weights_only" returns only relative figures.'),
      },
    },
    async ({ portfolioId, days, privacyMode }) => {
      try {
        requireUserScope("read:portfolios");
        const mode = parsePrivacyMode(privacyMode);
        const detail = await bullrunGet<PortfolioDetail>(`/api/portfolios/${portfolioId}`);

        // Insights are best-effort: a failure there shouldn't sink the snapshot.
        let insights: Insight[] = [];
        try {
          insights = await bullrunGet<Insight[]>(`/api/portfolios/${portfolioId}/insights`, {
            days: days ?? 30,
          });
        } catch {
          insights = [];
        }

        const weightsOnly = mode === "weights_only";
        // Coverage is computed from the raw positions (which still carry absolute
        // money) so the value-share estimate works; only relative figures surface.
        const coverage = computeCoverage(detail.positions ?? []);
        const payload = {
          privacyMode: mode,
          mlAccess: detail.mlAccess,
          coverage,
          summary: summaryView(detail.summary, mode),
          positions: positionsView(detail.positions ?? [], mode),
          insights: insights.map((i) => ({ tone: i.tone, text: i.text })),
          recentActivity: (detail.activity ?? []).map((a) => ({
            symbol: a.symbol,
            txType: a.txType,
            quantity: weightsOnly ? undefined : a.quantity,
            price: weightsOnly ? undefined : a.price,
            at: a.createdAt,
          })),
        };
        // The coverage banner is the FIRST text block so the matched/unmatched gap
        // is impossible to miss; the JSON payload (which repeats it in `coverage`)
        // follows.
        return {
          content: [
            { type: "text", text: coverage.summary },
            { type: "text", text: JSON.stringify(payload, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_portfolio_context failed: ${msg}` }] };
      }
    },
  );
}
