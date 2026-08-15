import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe, type Stock } from "./stockIdentity.js";
import {
  etfSummary,
  mapWithConcurrency,
  toolResult,
  type EtfProfile,
} from "./etfData.js";

type SortBy = "relevance" | "ticker" | "name" | "aum" | "expense_ratio" | "yield";
const productType = z.enum(["UCITS_FUND", "FUND", "ETC", "ETN", "ETP_GEARED", "ETP_OTHER"]);

const inputSchema = {
  search: z.string().optional()
    .describe("Free-text ETF search by ticker or fund name. Omit for a broad screen."),
  category: z.string().optional()
    .describe("Exact broad ETF category/asset-class filter, e.g. Equity, Fixed Income, Commodity, Crypto, or Real Estate."),
  focus: z.string().optional()
    .describe("Exact ETF focus/exposure filter, e.g. Japan, TOPIX, or Equity - Australia."),
  region: z.string().optional().describe("Exact portfolio or investment-region filter."),
  indexKey: z.string().optional()
    .describe("Normalized tracked-index key, e.g. SP500 or MSCI_WORLD."),
  distributionPolicy: z.enum(["ACCUMULATING", "DISTRIBUTING"]).optional(),
  productTypes: z.array(productType).min(1).max(6).optional()
    .describe("Optional accepted product structures. Geared ETPs are never silently treated as ordinary index funds."),
  domicile: z.string().optional().describe("Exact fund domicile filter."),
  exchange: z.string().optional().describe("Exact listing exchange filter."),
  currency: z.string().optional().describe("Exact trading-currency filter."),
  minAum: z.number().nonnegative().optional()
    .describe("Minimum assets under management in the profile's reported currency units."),
  maxExpenseRatioPct: z.number().nonnegative().optional()
    .describe("Maximum annual expense ratio in percentage points, e.g. 0.25 means 0.25%."),
  minYieldTtmPct: z.number().nonnegative().optional()
    .describe("Minimum trailing yield in percentage points, e.g. 2 means 2%."),
  sortBy: z.enum(["relevance", "ticker", "name", "aum", "expense_ratio", "yield"])
    .default("relevance")
    .describe("Sort field. Relevance preserves Bullrun search ordering."),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  includeSecondary: z.boolean().default(false),
  includeInactive: z.boolean().default(false),
  deduplicateFunds: z.boolean().default(false)
    .describe("When true, return at most one listing for each fund ISIN while retaining listings with no fund ISIN."),
  scanLimit: z.number().int().min(25).max(500).default(100)
    .describe("Maximum coarse-search candidates to enrich before applying quantitative filters/sorts, 25-500."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum matching ETFs to return, 1-100."),
};

const outputSchema = {
  query: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  matchesInScannedCandidates: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  results: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
};

function nullableCompare(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  const result = typeof a === "string" && typeof b === "string"
    ? a.localeCompare(b)
    : Number(a) - Number(b);
  return direction === "asc" ? result : -result;
}

function sortValue(row: Record<string, unknown>, sortBy: SortBy): unknown {
  switch (sortBy) {
    case "ticker": return row.ticker;
    case "name": return row.name;
    case "aum": return row.aum;
    case "expense_ratio": return row.expenseRatioPct;
    case "yield": return row.yieldTtmPct;
    default: return null;
  }
}

export function registerSearchEtfs(server: McpServer): void {
  server.registerTool(
    "search_etfs",
    {
      title: "Search ETFs",
      annotations: { readOnlyHint: true },
      description:
        "Discover and screen ETFs by name/ticker, classification, tracked index, distribution policy, product structure, listing, AUM, expense ratio, and yield. Server-supported filters are forwarded directly; remaining quantitative filters are applied to profile-enriched candidates. The response reports scan and deduplication coverage. Use get_etf_snapshot for one fund and get_etf_holdings for constituents. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const needsBroadScan = args.minAum != null || args.maxExpenseRatioPct != null ||
          args.minYieldTtmPct != null || args.productTypes != null || args.deduplicateFunds ||
          ["aum", "expense_ratio", "yield"].includes(args.sortBy);
        const upstreamLimit = needsBroadScan ? args.scanLimit : args.limit;
        const candidates = await bullrunGet<Stock[]>("/api/etfs", {
          search: args.search?.trim(),
          exchange: args.exchange,
          currency: args.currency,
          sector: args.category,
          industry: args.focus,
          country: args.domicile,
          region: args.region,
          indexKey: args.indexKey?.trim(),
          distributionPolicy: args.distributionPolicy,
          maxExpenseRatio: args.maxExpenseRatioPct == null ? undefined : args.maxExpenseRatioPct / 100,
          includeSecondary: args.includeSecondary,
          includeInactive: args.includeInactive,
          limit: upstreamLimit,
        });

        const profiles = await mapWithConcurrency(candidates, 12, async (row) => {
          const enc = encodeURIComponent(row.ticker);
          return safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`));
        });
        const profileByTicker = new Map(candidates.map((row, index) => [row.ticker, profiles[index]]));

        let enriched = candidates.map((row) => etfSummary(row, profileByTicker.get(row.ticker) ?? null));
        enriched = enriched.filter((row) => {
          const aum = typeof row.aum === "number" ? row.aum : null;
          const expense = typeof row.expenseRatioPct === "number" ? row.expenseRatioPct : null;
          const yieldPct = typeof row.yieldTtmPct === "number" ? row.yieldTtmPct : null;
          return (args.minAum == null || (aum != null && aum >= args.minAum)) &&
            (args.maxExpenseRatioPct == null || (expense != null && expense <= args.maxExpenseRatioPct)) &&
            (args.minYieldTtmPct == null || (yieldPct != null && yieldPct >= args.minYieldTtmPct)) &&
            (args.productTypes == null || args.productTypes.includes(String(row.productType) as z.infer<typeof productType>));
        });

        const beforeDeduplication = enriched.length;
        if (args.deduplicateFunds) {
          const seenFunds = new Set<string>();
          enriched = enriched.filter((row) => {
            const fundIsin = typeof row.fundIsin === "string" && row.fundIsin.trim()
              ? row.fundIsin.trim().toUpperCase()
              : null;
            if (!fundIsin) return true;
            if (seenFunds.has(fundIsin)) return false;
            seenFunds.add(fundIsin);
            return true;
          });
        }
        const deduplicatedListings = beforeDeduplication - enriched.length;

        if (args.sortBy !== "relevance") {
          enriched.sort((a, b) => nullableCompare(
            sortValue(a, args.sortBy),
            sortValue(b, args.sortBy),
            args.sortDirection,
          ));
        }

        const candidateCapReached = needsBroadScan && candidates.length >= args.scanLimit;
        const missingProfiles = profiles.filter((profile) => profile == null).length;
        const warnings: string[] = [];
        if (candidateCapReached) {
          warnings.push(
            `Quantitative screening scanned the first ${args.scanLimit} coarse matches; broadened universe results may exist beyond that candidate cap.`,
          );
        }
        if (missingProfiles > 0) {
          warnings.push(`${missingProfiles} scanned ETF(s) had no profile data; quantitative fields are null and such rows cannot pass quantitative filters.`);
        }
        if ((args.minAum != null || args.sortBy === "aum") && !args.currency) {
          warnings.push("AUM currency is not stored in the current profile schema. Use a trading-currency filter and treat cross-domicile AUM comparisons cautiously.");
        }
        const geared = enriched.filter((row) => row.productType === "ETP_GEARED").map((row) => String(row.ticker));
        if (geared.length) {
          warnings.push(`Geared products present (${geared.join(", ")}); do not compare their fees or long-run returns as ordinary index trackers.`);
        }

        const results = enriched.slice(0, args.limit);
        return toolResult({
          query: {
            search: args.search ?? null,
            category: args.category ?? null,
            focus: args.focus ?? null,
            region: args.region ?? null,
            indexKey: args.indexKey ?? null,
            distributionPolicy: args.distributionPolicy ?? null,
            productTypes: args.productTypes ?? null,
            domicile: args.domicile ?? null,
            exchange: args.exchange ?? null,
            currency: args.currency ?? null,
            minAum: args.minAum ?? null,
            maxExpenseRatioPct: args.maxExpenseRatioPct ?? null,
            minYieldTtmPct: args.minYieldTtmPct ?? null,
            sortBy: args.sortBy,
            sortDirection: args.sortDirection,
            deduplicateFunds: args.deduplicateFunds,
          },
          coverage: {
            scannedCandidates: candidates.length,
            scanLimit: upstreamLimit,
            candidateCapReached,
            profilesAvailable: profiles.length - missingProfiles,
            profilesMissing: missingProfiles,
            deduplicatedListings,
          },
          matchesInScannedCandidates: enriched.length,
          returned: results.length,
          results,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `search_etfs failed: ${msg}` }] };
      }
    },
  );
}
