import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import { parsePrivacyMode } from "../privacy.js";

function redactMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMoney);
  if (value == null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith("Usd")) continue;
    out[key] = redactMoney(child);
  }
  return out;
}

/** The coverage slice of the /risk payload (PortfolioRiskAnalyticsService.Coverage). */
interface RiskCoverage {
  totalHoldings?: number;
  pricedHoldings?: number;
  analyticsHoldings?: number;
  excludedSymbols?: string[];
  warnings?: string[];
}

/**
 * Turn the (otherwise quiet) backend coverage counts into a loud one-liner. The
 * risk math silently drops every holding that is unpriced, unmatched, or lacks
 * enough price history, and renormalizes all the percentages over what survives —
 * so without this banner an assistant would read partial-portfolio risk as if it
 * were the whole book. ASCII only (it travels through JSON + terminals).
 */
function analyticsCoverageBanner(cov: RiskCoverage | undefined): string {
  const total = cov?.totalHoldings ?? 0;
  const analyzed = cov?.analyticsHoldings ?? 0;
  const priced = cov?.pricedHoldings ?? 0;
  const warnings = cov?.warnings ?? [];

  if (total <= 0) {
    return "Coverage: no holdings were available for this risk analysis.";
  }
  const notAnalyzed = total - analyzed;
  if (notAnalyzed <= 0) {
    return `Coverage: all ${total} holding${total === 1 ? "" : "s"} are included in this risk ` +
      `analysis.${warnings.length ? " " + warnings.join(" ") : ""}`;
  }

  const parts: string[] = [
    `COVERAGE GAP -- READ FIRST: this risk analysis covers ${analyzed} of ${total} holdings; ` +
      `${notAnalyzed} are EXCLUDED from every risk, exposure, factor and scenario figure below, ` +
      "and the percentages are renormalized over only the analyzed holdings.",
  ];

  const unpricedOrUnmatched = total - priced;
  if (unpricedOrUnmatched > 0) {
    parts.push(
      `${unpricedOrUnmatched} holding(s) are unpriced or unmatched to Bullrun data (no price ` +
        "history -- typically ETFs, funds, or tickers outside the universe).",
    );
  }
  const historyExcluded = priced - analyzed;
  if (historyExcluded > 0) {
    const names = (cov?.excludedSymbols ?? []).join(", ");
    parts.push(
      `${historyExcluded} matched holding(s) lack enough USD price history for the math` +
        (names ? `: ${names}` : "") + ".",
    );
  }
  parts.push(
    "Use get_portfolio_context for the full matched/unmatched holdings breakdown and value coverage. " +
      "Do not present this analysis as covering the whole portfolio.",
  );
  for (const w of warnings) parts.push(w);
  return parts.join(" ");
}

export function registerGetPortfolioAnalytics(server: McpServer): void {
  server.registerTool(
    "get_portfolio_analytics",
    {
      title: "Get portfolio analytics",
      annotations: { readOnlyHint: true },
      description:
        "Use when the user asks about THEIR portfolio's risk, diversification, or concentration, or whether to add a stock — e.g. \"is my portfolio diversified\", \"how risky is my portfolio\", \"am I too concentrated\", \"what's my exposure to X\", \"should I add NVDA\", \"would AAPL improve my diversification\". Fetches portfolio-level relationship analytics for one signed-in user's portfolio: correlation and annualized covariance matrices across holdings, contribution-to-risk, concentration by weight and risk, currency/sector/country exposures, value/growth/momentum/quality/size proxy factor scores, scenario/stress tests (rates +100bp, oil -20%, USD +10%), and optional candidateTicker fit analysis showing correlation to the current portfolio plus pro-forma volatility (set candidateTicker when the user asks whether to add a specific stock). Pass a portfolioId from list_portfolios. The risk math only covers holdings with enough price history, dropping unpriced/unmatched ones (ETFs, funds, untracked tickers) and renormalizing all percentages over what remains; the response leads with a `coverage` banner (first text block) stating how many holdings were excluded, so never read these figures as the whole portfolio. For a plain holdings/value snapshot and the full matched/unmatched breakdown use get_portfolio_context instead. Requires OAuth (read:portfolios) and returns the caller's own data only. privacyMode defaults to \"full\"; \"weights_only\" hides absolute USD amounts while keeping weights, percentages, correlations and scores.",
      inputSchema: {
        portfolioId: z
          .number()
          .int()
          .positive()
          .describe("The portfolio id, as returned by list_portfolios."),
        days: z
          .number()
          .int()
          .min(30)
          .max(1825)
          .optional()
          .describe("Calendar-day lookback for daily USD return analytics. Default 370."),
        candidateTicker: z
          .string()
          .min(1)
          .optional()
          .describe("Optional exact Bullrun ticker to test as a candidate diversifier - the native local-exchange symbol, e.g. AAPL, BMW, ABBN, NESN (not Yahoo-style suffixes like BMW.DE)."),
        candidateWeightPct: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe("Optional hypothetical candidate allocation for pro-forma volatility. Default 5 (%)."),
        privacyMode: z
          .enum(["full", "weights_only"])
          .optional()
          .describe('"full" (default) includes absolute USD amounts; "weights_only" returns only relative figures.'),
      },
    },
    async ({ portfolioId, days, candidateTicker, candidateWeightPct, privacyMode }) => {
      try {
        requireUserScope("read:portfolios");
        const mode = parsePrivacyMode(privacyMode);
        const payload = await bullrunGet<unknown>(`/api/portfolios/${portfolioId}/risk`, {
          days: days ?? 370,
          candidateTicker: candidateTicker?.trim(),
          candidateWeightPct: candidateWeightPct ?? 5,
        });

        const view = mode === "weights_only" ? redactMoney(payload) : payload;
        const body =
          view != null && typeof view === "object" && !Array.isArray(view)
            ? { privacyMode: mode, ...(view as Record<string, unknown>) }
            : { privacyMode: mode, payload: view };

        // Surface the backend coverage counts as a loud first text block: the risk
        // math drops unpriced/unmatched/low-history holdings, so the figures below
        // cover only a subset. Read from the raw payload (coverage has no Usd keys,
        // so redaction leaves it intact either way).
        const cov =
          payload != null && typeof payload === "object"
            ? ((payload as Record<string, unknown>).coverage as RiskCoverage | undefined)
            : undefined;
        const banner = analyticsCoverageBanner(cov);

        return {
          content: [
            { type: "text", text: banner },
            { type: "text", text: JSON.stringify(body, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_portfolio_analytics failed: ${msg}` }] };
      }
    },
  );
}
