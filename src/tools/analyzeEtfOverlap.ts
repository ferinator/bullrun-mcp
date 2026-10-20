import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe, settle } from "./stockIdentity.js";
import { toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";
import { calculateEtfOverlap } from "./etfOverlap.js";

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
            settle(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`)),
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
          ]);
          return { ticker, holdings: holdings.data ?? [], profile, holdingsFailure: holdings.failure };
        }));
        const overlap = calculateEtfOverlap(bundles, args.topSharedLimit);
        // Legacy clients expect numeric zero for missing snapshots. Keep that shape,
        // but expose availability so it cannot be mistaken for measured absence.
        const pairs = overlap.pairs.map((pair) => pair.available ? pair : {
          ...pair,
          sharedHoldings: 0,
          weightedOverlapPct: 0,
          sharedWeightPctA: 0,
          sharedWeightPctB: 0,
        });
        return toolResult({
          tickers,
          ...overlap,
          pairs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `analyze_etf_overlap failed: ${msg}` }] };
      }
    },
  );
}
