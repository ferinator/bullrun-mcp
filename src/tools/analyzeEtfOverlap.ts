import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";

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

function holdingKey(row: EtfHolding): string {
  const symbol = row.holdingSymbol?.trim().toUpperCase();
  if (symbol) return `SYMBOL:${symbol}`;
  return `NAME:${(row.holdingName ?? row.holdingKey).trim().toUpperCase().replace(/\s+/g, " ")}`;
}

export function registerAnalyzeEtfOverlap(server: McpServer): void {
  server.registerTool(
    "analyze_etf_overlap",
    {
      title: "Analyze ETF overlap",
      annotations: { readOnlyHint: true },
      description:
        "Compare two to ten ETFs using their latest stored holdings. Returns pairwise shared holdings, weighted overlap (sum of the smaller weight for each shared holding), each fund's weight in shared names, and the largest duplicate exposures. Coverage is explicit because provider holdings may be partial top-holdings samples. Read-only.",
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
          return { ticker, holdings: holdings ?? [], profile };
        }));
        const coverage = bundles.map(({ ticker, holdings, profile }) => {
          const coveredWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
          const reported = profile?.holdingsCount ?? null;
          return {
            ticker,
            asOfDate: holdings[0]?.asOfDate ?? null,
            storedRows: holdings.length,
            reportedHoldingsCount: reported,
            coveredWeightPct: roundMetric(coveredWeightPct),
            isComplete: reported == null ? null : holdings.length >= reported && coveredWeightPct >= 98,
          };
        });

        const pairs: Array<Record<string, unknown>> = [];
        for (let i = 0; i < bundles.length; i++) {
          for (let j = i + 1; j < bundles.length; j++) {
            const a = bundles[i];
            const b = bundles[j];
            const aMap = new Map(a.holdings.map((row) => [holdingKey(row), row]));
            const bMap = new Map(b.holdings.map((row) => [holdingKey(row), row]));
            const shared = [...aMap.entries()]
              .filter(([key]) => bMap.has(key))
              .map(([key, aRow]) => {
                const bRow = bMap.get(key) as EtfHolding;
                const weightA = aRow.weightPct ?? 0;
                const weightB = bRow.weightPct ?? 0;
                return {
                  key,
                  symbol: aRow.holdingSymbol ?? bRow.holdingSymbol,
                  name: aRow.holdingName ?? bRow.holdingName,
                  weightPctA: weightA,
                  weightPctB: weightB,
                  overlapWeightPct: Math.min(weightA, weightB),
                };
              })
              .sort((left, right) => right.overlapWeightPct - left.overlapWeightPct);
            pairs.push({
              tickerA: a.ticker,
              tickerB: b.ticker,
              sharedHoldings: shared.length,
              weightedOverlapPct: roundMetric(shared.reduce((sum, row) => sum + row.overlapWeightPct, 0)),
              sharedWeightPctA: roundMetric(shared.reduce((sum, row) => sum + row.weightPctA, 0)),
              sharedWeightPctB: roundMetric(shared.reduce((sum, row) => sum + row.weightPctB, 0)),
              topShared: shared.slice(0, args.topSharedLimit),
            });
          }
        }

        const partial = coverage.filter((row) => row.isComplete !== true).map((row) => row.ticker);
        return toolResult({
          tickers,
          methodology: {
            holdingMatch: "normalized_symbol_else_normalized_name",
            weightedOverlapPct: "sum(min(weight_in_a, weight_in_b))",
            snapshotSelection: "latest_stored_per_fund",
          },
          coverage,
          pairs,
          warnings: partial.length
            ? [`Partial holdings coverage for ${partial.join(", ")}; overlap is a lower bound and may omit shared exposures.`]
            : [],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `analyze_etf_overlap failed: ${msg}` }] };
      }
    },
  );
}
