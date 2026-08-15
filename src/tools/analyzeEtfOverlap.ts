import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { toolResult, type EtfHolding, type EtfPrice, type EtfProfile } from "./etfData.js";
import { calculateEtfSimilarity } from "./etfSimilarity.js";

const inputSchema = {
  tickers: z.array(z.string().min(1)).min(2).max(10)
    .describe("Two to ten exact Bullrun ETF listing tickers."),
  topSharedLimit: z.number().int().min(1).max(100).default(20),
  includePriceBehavior: z.boolean().default(true)
    .describe("Include multi-window close-price correlation and tracking-error behavior in the similarity score."),
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
        "Compare two to ten ETFs using actual holdings, economic mandate and optional multi-window close-price behavior. Returns confirmed weighted overlap, a coverage-adjusted similarity score, same-fund/index relationships, and a separate confidence score. Coverage is explicit because provider holdings may be partial top-holdings samples. Read-only.",
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
          const [holdings, profile, prices] = await Promise.all([
            safe(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`)),
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            args.includePriceBehavior
              ? safe(bullrunGet<EtfPrice[]>(`/api/prices/${enc}`, { limit: 2600 }))
              : Promise.resolve(null),
          ]);
          return { ticker, holdings: holdings ?? [], profile, prices: prices ?? [] };
        }));
        const coverage = bundles.map(({ ticker, holdings, profile, prices }) => {
          const coveredWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
          const reported = profile?.holdingsCount ?? null;
          return {
            ticker,
            asOfDate: holdings[0]?.asOfDate ?? null,
            storedRows: holdings.length,
            reportedHoldingsCount: reported,
            coveredWeightPct: roundMetric(coveredWeightPct),
            isComplete: reported == null ? null : holdings.length >= reported && coveredWeightPct >= 98,
            priceRows: prices.length,
            fundIsin: profile?.fundIsin ?? null,
            indexKey: profile?.indexKey ?? null,
            productType: profile?.productType ?? null,
          };
        });

        const pairs: Array<Record<string, unknown>> = [];
        for (let i = 0; i < bundles.length; i++) {
          for (let j = i + 1; j < bundles.length; j++) {
            const a = bundles[i];
            const b = bundles[j];
            const similarity = calculateEtfSimilarity(a, b);
            pairs.push({
              tickerA: a.ticker,
              tickerB: b.ticker,
              sameFund: Boolean(a.profile?.fundIsin && a.profile.fundIsin === b.profile?.fundIsin),
              sameIndex: Boolean(a.profile?.indexKey && a.profile.indexKey === b.profile?.indexKey),
              similarityScore: similarity.score,
              label: similarity.label,
              insight: similarity.insight,
              confidence: similarity.confidence,
              confidenceScore: similarity.confidenceScore,
              sharedHoldings: similarity.sharedHoldingsCount,
              weightedOverlapPct: roundMetric(similarity.weightedOverlapPct),
              estimatedHoldingsOverlapPct: roundMetric(similarity.estimatedHoldingsOverlapPct),
              disclosedHoldingsSimilarityPct: roundMetric(similarity.disclosedHoldingsSimilarityPct),
              economicExposureScore: roundMetric(similarity.economicExposureScore),
              returnCorrelation: roundMetric(similarity.returnCorrelation),
              trackingErrorPct: roundMetric(similarity.trackingErrorPct),
              correlationWindows: similarity.correlationWindows,
              components: similarity.components,
              topShared: similarity.sharedHoldings.slice(0, args.topSharedLimit),
            });
          }
        }

        const partial = coverage.filter((row) => row.isComplete !== true).map((row) => row.ticker);
        return toolResult({
          tickers,
          methodology: {
            holdingMatch: "normalized_symbol_else_normalized_name",
            weightedOverlapPct: "sum(min(weight_in_a, weight_in_b))",
            similarityScore: "70% holdings + 20% economic exposure + 10% multi-window close-price behavior, renormalized over available components",
            confidenceScore: "holdings coverage + economic field coverage + price-history coverage + holdings freshness",
            snapshotSelection: "latest_stored_per_fund",
          },
          coverage,
          pairs,
          warnings: [
            ...(partial.length
              ? [`Partial holdings coverage for ${partial.join(", ")}; confirmed overlap is a lower bound and may omit shared exposures.`]
              : []),
            ...(bundles.some((bundle) => bundle.profile?.productType === "ETP_GEARED")
              ? ["At least one geared ETP is present; leverage/inverse mandate differences are reflected in economic similarity, and long-run behavior is not directly comparable to an unleveraged fund."]
              : []),
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `analyze_etf_overlap failed: ${msg}` }] };
      }
    },
  );
}
