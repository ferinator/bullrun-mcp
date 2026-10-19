import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";
import { aggregateHoldings, type AggregatedHolding, type Indexed, type MatchBasis } from "./holdingIdentity.js";

const inputSchema = {
  tickers: z.array(z.string().min(1)).min(2).max(10)
    .describe("Two to ten exact Bullrun ETF listing tickers."),
  topSharedLimit: z.number().int().min(1).max(100).default(20),
};

const outputSchema = {
  tickers: z.array(z.string()),
  methodology: z.record(z.string(), z.unknown()),
  coverage: z.array(z.record(z.string(), z.unknown())),
  pairs: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
};

interface SharedRow {
  symbol: string | null;
  name: string | null;
  matchedOn: MatchBasis;
  weightPctA: number;
  weightPctB: number;
  overlapWeightPct: number;
}

export function registerAnalyzeEtfOverlap(server: McpServer): void {
  server.registerTool(
    "analyze_etf_overlap",
    {
      title: "Analyze ETF overlap",
      annotations: { readOnlyHint: true },
      description:
        "Compare two to ten ETFs using their latest stored holdings. Returns pairwise shared holdings, weighted overlap (sum of the smaller weight for each shared holding), each fund's weight in shared names, and the largest duplicate exposures. Holdings are matched as securities, not symbols: same ISIN first, then the same symbol only where the names agree and the countries do not conflict, then the same company name within one country; each shared row says which (matchedOn). Cash, currency and derivative lines are never counted as shared. Coverage is explicit because provider holdings may be partial top-holdings samples. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const tickers = [...new Set(args.tickers.map((ticker) => ticker.trim().toUpperCase()))];
        if (tickers.length < 2) throw new Error("At least two distinct ETF tickers are required.");
        const bundles = await Promise.all(tickers.map(async (ticker) => {
          const enc = encodeURIComponent(ticker);
          const [holdings, profile] = await Promise.all([
            safe(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`)),
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
          ]);
          const rows = holdings ?? [];
          return { ticker, holdings: rows, profile, ...aggregateHoldings(rows) };
        }));
        const coverage = bundles.map(({ ticker, holdings, profile, matcher, cashWeightPct }) => {
          const coveredWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
          const reported = profile?.holdingsCount ?? null;
          return {
            ticker,
            asOfDate: holdings[0]?.asOfDate ?? null,
            source: holdings[0]?.source ?? null,
            storedRows: holdings.length,
            distinctSecurities: matcher.entries.length,
            reportedHoldingsCount: reported,
            coveredWeightPct: roundMetric(coveredWeightPct),
            cashAndDerivativesWeightPct: roundMetric(cashWeightPct),
            rowsWithIsinPct: holdings.length
              ? roundMetric(holdings.filter((row) => row.holdingIsin).length / holdings.length * 100, 1)
              : null,
            isComplete: reported == null ? null : holdings.length >= reported && coveredWeightPct >= 98,
          };
        });

        const pairs: Array<Record<string, unknown>> = [];
        for (let i = 0; i < bundles.length; i++) {
          for (let j = i + 1; j < bundles.length; j++) {
            const a = bundles[i];
            const b = bundles[j];
            const used = new Set<Indexed<AggregatedHolding>>();
            const shared: SharedRow[] = [];
            const bySize = [...b.matcher.entries].sort((x, y) => y.payload.weightPct - x.payload.weightPct);
            for (const bEntry of bySize) {
              const hit = a.matcher.find(bEntry.identity, used);
              if (!hit) continue;
              used.add(hit.entry);
              const weightA = hit.entry.payload.weightPct;
              const weightB = bEntry.payload.weightPct;
              shared.push({
                symbol: hit.entry.payload.symbol ?? bEntry.payload.symbol,
                name: hit.entry.payload.name ?? bEntry.payload.name,
                matchedOn: hit.basis,
                weightPctA: roundMetric(weightA) ?? 0,
                weightPctB: roundMetric(weightB) ?? 0,
                overlapWeightPct: Math.min(weightA, weightB),
              });
            }
            shared.sort((left, right) => right.overlapWeightPct - left.overlapWeightPct);
            const matchedOn: Record<string, number> = {};
            for (const row of shared) matchedOn[row.matchedOn] = (matchedOn[row.matchedOn] ?? 0) + 1;
            pairs.push({
              tickerA: a.ticker,
              tickerB: b.ticker,
              sharedHoldings: shared.length,
              matchedOn,
              weightedOverlapPct: roundMetric(shared.reduce((sum, row) => sum + row.overlapWeightPct, 0), 4),
              sharedWeightPctA: roundMetric(shared.reduce((sum, row) => sum + row.weightPctA, 0), 4),
              sharedWeightPctB: roundMetric(shared.reduce((sum, row) => sum + row.weightPctB, 0), 4),
              topShared: shared.slice(0, args.topSharedLimit)
                .map((row) => ({ ...row, overlapWeightPct: roundMetric(row.overlapWeightPct, 4) })),
            });
          }
        }

        const warnings: string[] = [];
        const partial = coverage.filter((row) => row.isComplete !== true).map((row) => row.ticker);
        if (partial.length) {
          warnings.push(`Partial holdings coverage for ${partial.join(", ")}; overlap is a lower bound and may omit shared exposures.`);
        }
        const empty = coverage.filter((row) => row.storedRows === 0).map((row) => row.ticker);
        if (empty.length) {
          warnings.push(`No stored holdings for ${empty.join(", ")}; overlap with ${empty.length === 1 ? "it" : "them"} cannot be measured and reads as zero.`);
        }
        if (pairs.some((pair) => Number((pair.matchedOn as Record<string, number>).name ?? 0) > 0)) {
          warnings.push("Some shared rows matched on company name alone (matchedOn=name), typically a depositary receipt against the ordinary share or two share classes of one company. They are the same issuer, not necessarily the same security.");
        }
        return toolResult({
          tickers,
          methodology: {
            holdingMatch: "isin, else same symbol with agreeing names and compatible countries, else same normalized name within a compatible country",
            weightedOverlapPct: "sum(min(weight_in_a, weight_in_b))",
            excluded: "cash, currency and derivative lines",
            snapshotSelection: "latest_stored_per_fund",
          },
          coverage,
          pairs,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `analyze_etf_overlap failed: ${msg}` }] };
      }
    },
  );
}
