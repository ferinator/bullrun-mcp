import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import { parsePrivacyMode } from "../privacy.js";
import { calculatePortfolioLookThroughFit, EXACT_FIT_TICKER } from "./portfolioFitData.js";

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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Analyze the signed-in user's portfolio risk, diversification, concentration or a candidate stock/ETF. Returns correlation/covariance, risk contributions, country/sector/currency exposures, proxy factors and stress scenarios. Use portfolioId from list_portfolios; use get_portfolio_context instead for holdings/value and matched/unmatched coverage. Set candidateTicker for correlation and pro-forma volatility; add includeLookThrough=true for direct/ETF underlying overlap in lookThroughFit with separate coverage/warnings. Look-through uses priced positions, independently of the risk-history subset; partial ETF snapshots give a lower bound. Risk math excludes holdings without sufficient price history and renormalizes over those analyzed: report the leading coverage banner and never imply whole-portfolio coverage when holdings were excluded. Requires OAuth read:portfolios and reads only the caller's data. privacyMode=weights_only hides absolute USD amounts; full is the default.",
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
          .describe("Optional exact Bullrun stock or ETF listing ticker to test as a candidate diversifier, e.g. AAPL, BMW, ABBN, NESN or SPY. Use the stored listing ticker; do not infer exchange suffixes."),
        candidateWeightPct: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe("Optional hypothetical candidate allocation for pro-forma volatility. Default 5 (%)."),
        includeLookThrough: z
          .boolean()
          .default(false)
          .describe("Also compare an exact stock or ETF candidate against direct holdings and stored ETF constituents. Requires candidateTicker. Default false: no underlying holdings requests. Look-through has separate priced-position coverage from price-history risk analytics."),
        privacyMode: z
          .enum(["full", "weights_only"])
          .optional()
          .describe('"full" (default) includes absolute USD amounts; "weights_only" returns only relative figures.'),
      },
    },
    async ({ portfolioId, days, candidateTicker, candidateWeightPct, includeLookThrough, privacyMode }) => {
      try {
        requireUserScope("read:portfolios");
        if (includeLookThrough && (!candidateTicker?.trim() || !EXACT_FIT_TICKER.test(candidateTicker.trim()))) {
          return { isError: true, content: [{ type: "text", text: "includeLookThrough requires candidateTicker to be an exact Bullrun stock or ETF listing ticker." }] };
        }
        const mode = parsePrivacyMode(privacyMode);
        const payload = await bullrunGet<unknown>(`/api/portfolios/${portfolioId}/risk`, {
          days: days ?? 370,
          candidateTicker: candidateTicker?.trim(),
          candidateWeightPct: candidateWeightPct ?? 5,
        });

        const lookThrough = includeLookThrough ? await calculatePortfolioLookThroughFit({
          portfolioId,
          candidateTicker: candidateTicker!,
          candidateWeightPct: candidateWeightPct ?? 5,
        }).catch(() => ({ lookThroughFit: null, coverage: { status: "unavailable" },
          warnings: ["Portfolio holdings look-through could not be loaded. Existing duplicate exposure is unknown; price-history analytics retain their own coverage."] })) : null;
        const enriched = lookThrough ? {
          ...(payload != null && typeof payload === "object" && !Array.isArray(payload)
            ? payload as Record<string, unknown> : { payload }),
          lookThroughFit: lookThrough.lookThroughFit,
          lookThroughCoverage: lookThrough.coverage,
          lookThroughWarnings: lookThrough.warnings,
        } : payload;
        const view = mode === "weights_only" ? redactMoney(enriched) : enriched;
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
        const banner = analyticsCoverageBanner(cov) + (includeLookThrough
          ? " Optional holdings look-through has separate coverage in lookThroughCoverage; the risk exclusions above apply to price-history analytics."
          : "");

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
