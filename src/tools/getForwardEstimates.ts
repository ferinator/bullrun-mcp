import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { errorText, failureText, identityPayload, resolveStockTicker, settle, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface ForwardEstimate {
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
  periodType: "ANNUAL" | "QUARTERLY";
  asOfDate: string;
  source: string;
  sourceCurrency: string | null;
  revenueAvg: number | null;
  revenueLow: number | null;
  revenueHigh: number | null;
  revenueAnalystCount: number | null;
  epsAvg: number | null;
  epsLow: number | null;
  epsHigh: number | null;
  epsAnalystCount: number | null;
  ebitdaAvg: number | null;
  revenueRevision7dPct: number | null;
  revenueRevision30dPct: number | null;
  revenueRevision90dPct: number | null;
  epsRevision7dPct: number | null;
  epsRevision30dPct: number | null;
  epsRevision90dPct: number | null;
  guidanceRevenueLow: number | null;
  guidanceRevenueHigh: number | null;
  guidanceEpsLow: number | null;
  guidanceEpsHigh: number | null;
  updatedAt: string | null;
}

interface Price {
  tradeDate: string;
  closePrice: number | null;
}

function round2(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function periodLabel(row: ForwardEstimate): string {
  if (row.periodType === "ANNUAL" || row.fiscalQuarter === 0) return `FY${row.fiscalYear}`;
  return `FY${row.fiscalYear} Q${row.fiscalQuarter}`;
}

function key(row: ForwardEstimate): string {
  return `${row.periodType}:${row.fiscalYear}:${row.fiscalQuarter}:${row.source}`;
}

function latestPerPeriod(rows: ForwardEstimate[]): ForwardEstimate[] {
  const seen = new Set<string>();
  const out: ForwardEstimate[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

function derivedValuation(rows: ForwardEstimate[], latestClose: number | null, quoteCurrency: string | null): Record<string, unknown> {
  const candidates = latestPerPeriod(rows)
    .filter((row) => row.periodType === "ANNUAL");
  const latestSnapshot = candidates.map((row) => row.asOfDate).sort().at(-1);
  const annual = candidates.filter((row) => row.asOfDate === latestSnapshot)
    .sort((a, b) => a.fiscalYear - b.fiscalYear);

  const next = annual[0] ?? null;
  const following = next ? annual.find((row) => row.fiscalYear === next.fiscalYear + 1) ?? null : null;
  const comparableCurrency = !!quoteCurrency && !!next?.sourceCurrency
    && quoteCurrency.toUpperCase() === next.sourceCurrency.toUpperCase();
  const forwardPe = next && next.epsAvg != null && next.epsAvg > 0 && latestClose != null && comparableCurrency
    ? round2(latestClose / next.epsAvg) : null;
  const epsGrowthPct =
    next && following && next.epsAvg != null && next.epsAvg > 0 && following.epsAvg != null
      && next.sourceCurrency != null && next.sourceCurrency === following.sourceCurrency
      ? round2(((following.epsAvg - next.epsAvg) / Math.abs(next.epsAvg)) * 100)
      : null;

  return {
    latestClose,
    quoteCurrency,
    estimateCurrency: next?.sourceCurrency ?? null,
    valuationNote: comparableCurrency ? null : "Forward P/E is omitted unless quote and estimate currency units match; no currency conversion is assumed.",
    forwardPe,
    forwardPeBasis: next
      ? { period: periodLabel(next), epsAvg: next.epsAvg, asOfDate: next.asOfDate, source: next.source }
      : null,
    impliedForwardEpsGrowthPct: epsGrowthPct,
    forwardPeg: forwardPe != null && epsGrowthPct != null && epsGrowthPct > 0 ? round2(forwardPe / epsGrowthPct) : null,
  };
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Bullrun ticker, e.g. \"AAPL\", \"CRWD\", \"SPGI\". " + TICKER_CONVENTION),
  periodType: z.enum(["annual", "quarterly", "both"]).default("both")
    .describe("Return annual estimates, quarterly estimates, or both."),
  limit: z.number().int().min(1).max(200).default(80)
    .describe("Maximum estimate rows to return."),
};

export function registerGetForwardEstimates(server: McpServer): void {
  server.registerTool(
    "get_forward_estimates",
    {
      title: "Get forward estimates",
      annotations: { readOnlyHint: true },
      description:
        "Read cached Yahoo analyst consensus revenue/EPS estimates and available EPS revision percentages for one exact Bullrun ticker. A free background refresh checks supported symbols on demand, storing at most one snapshot per day; the first read may be empty. Fiscal periods and source currency are preserved. The configured feed does not provide EBITDA estimates, management guidance or revenue revisions. Forward P/E/PEG context uses the latest annual consensus snapshot only when quote and EPS currency units match. Read-only research operation.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        if (!args.ticker.trim()) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) return { content: [{ type: "text", text: tickerNotFoundText(args.ticker, resolution) }] };
        const ticker = resolution.ticker.toUpperCase();
        const identity = resolution.stock;

        const enc = encodeURIComponent(ticker);
        const periodType = args.periodType === "both" ? undefined : args.periodType.toUpperCase();
        const [rows, prices] = await Promise.all([
          bullrunGet<ForwardEstimate[]>(`/api/company-intelligence/${enc}/forward-estimates`, {
            periodType,
            limit: args.limit,
          }),
          settle(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: 1 })),
        ]);

        const estimates = rows ?? [];
        const latestClose = prices.data?.[0]?.closePrice ?? null;
        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(identity),
          coverage: {
            rows: estimates.length,
            refreshPolicy: "cached read; best-effort free background refresh, with daily stored snapshot cooldown; completion is not awaited",
            requestedPeriodType: args.periodType,
            hasConsensus: estimates.some((row) => row.revenueAvg != null || row.epsAvg != null),
            hasGuidance: estimates.some((row) =>
              row.guidanceRevenueLow != null ||
              row.guidanceRevenueHigh != null ||
              row.guidanceEpsLow != null ||
              row.guidanceEpsHigh != null),
            hasRevisions: estimates.some((row) =>
              row.revenueRevision7dPct != null ||
              row.revenueRevision30dPct != null ||
              row.revenueRevision90dPct != null ||
              row.epsRevision7dPct != null ||
              row.epsRevision30dPct != null ||
              row.epsRevision90dPct != null),
          },
          derived: derivedValuation(estimates, latestClose, identity?.currency ?? null),
          estimates: estimates.map((row) => ({ ...row, period: periodLabel(row) })),
          warnings: [
            ...(estimates.length === 0 ? ["No consensus rows are currently stored for this ticker/filter. A free refresh may be running in the background, or Yahoo may have no coverage; this response does not confirm completion."] : []),
            ...(prices.failure ? [`${failureText("The latest price", prices.failure)} Forward P/E and PEG are null for that reason only.`] : []),
            "Yahoo consensus is an aggregated analyst estimate, not issuer guidance or a verified forecast. Missing values are unavailable; EBITDA, management guidance and revenue revisions are not populated by this feed.",
          ],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorText(err, "Forward estimates",
          "Forward estimates could not be loaded. Check the exact Bullrun ticker and market-data access, then retry later; no refresh completion can be confirmed.") }] };
      }
    },
  );
}
