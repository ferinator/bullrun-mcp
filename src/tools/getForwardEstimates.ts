import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";

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

function derivedValuation(rows: ForwardEstimate[], latestClose: number | null): Record<string, unknown> {
  const annual = latestPerPeriod(rows)
    .filter((row) => row.periodType === "ANNUAL" && row.epsAvg != null && row.epsAvg > 0)
    .sort((a, b) => a.fiscalYear - b.fiscalYear);

  const next = annual[0] ?? null;
  const following = annual[1] ?? null;
  const forwardPe = next && latestClose != null ? round2(latestClose / next.epsAvg!) : null;
  const epsGrowthPct =
    next && following && next.epsAvg != null && following.epsAvg != null
      ? round2(((following.epsAvg - next.epsAvg) / Math.abs(next.epsAvg)) * 100)
      : null;

  return {
    latestClose,
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
    .describe("The ticker exactly as listed on Bullrun, e.g. \"AAPL\", \"CRWD\", \"SPGI\"."),
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
        "Fetch forward consensus revenue/EPS/EBITDA estimates, management guidance ranges, and estimate-revision percentages for one exact Bullrun ticker. Also derives simple forward P/E and PEG-style context from the latest close when EPS estimates are available. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        if (!ticker) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };

        const enc = encodeURIComponent(ticker);
        const periodType = args.periodType === "both" ? undefined : args.periodType.toUpperCase();
        const [identity, rows, prices] = await Promise.all([
          findExactStock(ticker),
          safe(bullrunGet<ForwardEstimate[]>(`/api/company-intelligence/${enc}/forward-estimates`, {
            periodType,
            limit: args.limit,
          })),
          safe(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: 1 })),
        ]);

        const estimates = rows ?? [];
        const latestClose = prices?.[0]?.closePrice ?? null;
        const payload = {
          ticker,
          identity: identityPayload(identity),
          coverage: {
            rows: estimates.length,
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
          derived: derivedValuation(estimates, latestClose),
          estimates: estimates.map((row) => ({ ...row, period: periodLabel(row) })),
          warnings: estimates.length === 0
            ? ["No forward estimate rows found for this ticker. The MCP contract exists, but the upstream feed/crawler has not populated it yet."]
            : [],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_forward_estimates failed: ${msg}` }] };
      }
    },
  );
}
