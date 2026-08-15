import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, safe, type Stock } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { mapWithConcurrency, toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";

const exposureType = z.enum(["sector", "country", "currency", "asset", "factor", "thematic"]);

const inputSchema = {
  ticker: z.string().min(1).describe("Exact Bullrun ETF listing ticker."),
  types: z.array(exposureType).min(1).max(6).default(["sector", "country", "currency", "asset"]),
  limitPerType: z.number().int().min(1).max(100).default(25),
};

const outputSchema = {
  ticker: z.string(),
  requestedTypes: z.array(exposureType),
  availableTypes: z.array(exposureType),
  unavailableTypes: z.array(exposureType),
  exposures: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

function buckets(
  holdings: EtfHolding[],
  identities: Map<string, Stock | null>,
  selector: (holding: EtfHolding, identity: Stock | null) => string | null | undefined,
  limit: number,
): Array<Record<string, unknown>> {
  const grouped = new Map<string, { weightPct: number; holdingCount: number }>();
  for (const holding of holdings) {
    const identity = holding.holdingSymbol
      ? identities.get(holding.holdingSymbol.trim().toUpperCase()) ?? null
      : null;
    const name = selector(holding, identity)?.trim();
    if (!name) continue;
    const current = grouped.get(name) ?? { weightPct: 0, holdingCount: 0 };
    current.weightPct += holding.weightPct ?? 0;
    current.holdingCount++;
    grouped.set(name, current);
  }
  return [...grouped.entries()]
    .map(([name, value]) => ({ name, weightPct: roundMetric(value.weightPct), holdingCount: value.holdingCount }))
    .sort((a, b) => Number(b.weightPct) - Number(a.weightPct))
    .slice(0, limit);
}

export function registerGetEtfExposures(server: McpServer): void {
  server.registerTool(
    "get_etf_exposures",
    {
      title: "Get ETF exposures",
      annotations: { readOnlyHint: true },
      description:
        "Calculate sector, country, currency, and broad asset exposure from the latest stored ETF holdings and Bullrun instrument mappings. Factor and thematic look-through are reported unavailable until dedicated source data exists. Coverage states how much fund weight and how many holding symbols were resolved, so partial top-holdings data is never presented as full exposure. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const requestedTypes = [...new Set(args.types)];
        const enc = encodeURIComponent(ticker);
        const [holdingsResult, profile] = await Promise.all([
          safe(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`)),
          safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
        ]);
        const holdings = holdingsResult ?? [];
        const symbols = [...new Set(holdings
          .map((holding) => holding.holdingSymbol?.trim().toUpperCase())
          .filter((symbol): symbol is string => Boolean(symbol)))];
        const resolved = await mapWithConcurrency(symbols, 12, (symbol) => findExactStock(symbol));
        const identities = new Map(symbols.map((symbol, index) => [symbol, resolved[index]]));
        const exposures: Record<string, unknown> = {};
        const availableTypes: z.infer<typeof exposureType>[] = [];
        const unavailableTypes: z.infer<typeof exposureType>[] = [];

        for (const type of requestedTypes) {
          let values: Array<Record<string, unknown>> = [];
          if (type === "sector") values = buckets(holdings, identities, (_holding, identity) => identity?.sector, args.limitPerType);
          if (type === "country") values = buckets(holdings, identities, (_holding, identity) => identity?.country, args.limitPerType);
          if (type === "currency") values = buckets(holdings, identities, (holding, identity) => holding.currency ?? identity?.currency, args.limitPerType);
          if (type === "asset" && profile?.assetClass) {
            values = [{ name: profile.assetClass, weightPct: 100, methodology: "fund_profile_classification" }];
          }
          exposures[type] = values;
          (values.length ? availableTypes : unavailableTypes).push(type);
        }

        const lookThroughWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
        const resolvedWeightPct = holdings.reduce((sum, row) => {
          const symbol = row.holdingSymbol?.trim().toUpperCase();
          return sum + (symbol && identities.get(symbol) ? (row.weightPct ?? 0) : 0);
        }, 0);
        const reported = profile?.holdingsCount ?? null;
        const isComplete = reported == null ? null : holdings.length >= reported && lookThroughWeightPct >= 98;
        const warnings: string[] = [];
        if (isComplete !== true) warnings.push("Holdings are partial or completeness is unknown; exposure weights are lower-bound look-through coverage, not a full fund allocation.");
        if (unavailableTypes.includes("factor")) warnings.push("Factor exposure requires dedicated factor classifications or return-regression factors, which are not stored.");
        if (unavailableTypes.includes("thematic")) warnings.push("Thematic exposure requires a dedicated taxonomy/source, which is not stored.");

        return toolResult({
          ticker,
          requestedTypes,
          availableTypes,
          unavailableTypes,
          exposures,
          coverage: {
            asOfDate: holdings[0]?.asOfDate ?? null,
            storedHoldingRows: holdings.length,
            reportedHoldingsCount: reported,
            holdingsWithSymbols: symbols.length,
            resolvedSymbols: resolved.filter((identity) => identity != null).length,
            lookThroughWeightPct: roundMetric(lookThroughWeightPct),
            resolvedWeightPct: roundMetric(resolvedWeightPct),
            isComplete,
          },
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_exposures failed: ${msg}` }] };
      }
    },
  );
}
