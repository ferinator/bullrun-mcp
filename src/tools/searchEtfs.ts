import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { settle, type Stock } from "./stockIdentity.js";
import {
  etfSummary,
  mapWithConcurrency,
  pctToFraction,
  toolResult,
  type EtfProfile,
} from "./etfData.js";

type SortBy = "relevance" | "ticker" | "name" | "aum" | "expense_ratio" | "yield";

const inputSchema = {
  search: z.string().optional()
    .describe("Free-text ETF search by ticker, fund name, or ISIN (e.g. IE00B4L5Y983). Omit for a broad screen."),
  category: z.string().optional()
    .describe("Exact broad ETF category/asset-class filter, e.g. Equity, Fixed Income, Commodity, Crypto, or Real Estate. Call get_etf_filter_options for valid values."),
  focus: z.string().optional()
    .describe("Exact ETF focus/exposure filter, e.g. Japan, TOPIX, or Equity - Australia."),
  region: z.string().optional().describe("Exact portfolio or investment-region filter."),
  domicile: z.string().optional().describe("Exact fund domicile filter."),
  exchange: z.string().optional().describe("Exact listing exchange filter."),
  currency: z.string().optional().describe("Exact trading-currency filter."),
  indexKey: z.string().optional()
    .describe("Exact tracked-index key, e.g. SP500 or MSCI_WORLD. Use get_etf_index_group to rank every fund on one index by cost."),
  distributionPolicy: z.enum(["ACCUMULATING", "DISTRIBUTING"]).optional()
    .describe("Accumulating (reinvests income) or distributing (pays it out)."),
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
        "Look up ETFs by name, ticker or ISIN, with classification, listing, index, distribution-policy, AUM, expense-ratio and yield filters. Best for finding a known fund. For ranking questions (\"cheapest\", \"largest\", \"best performing\", \"most liquid\") prefer screen_etfs, which evaluates the whole universe: here minAum and minYieldTtmPct are applied only to a bounded profile-enriched candidate scan, so do not describe the result as exhaustive when candidateCapReached is true. Use get_etf_snapshot for one listing, get_etf_fund to resolve an ISIN across venues, and get_etf_holdings for constituents. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        // maxExpenseRatioPct is pushed down to the API (as a fraction), so it narrows the
        // universe server-side and does not need the client-side candidate scan. minAum and
        // minYieldTtmPct have no server-side equivalent and still do.
        const needsBroadScan = args.minAum != null || args.minYieldTtmPct != null ||
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
          indexKey: args.indexKey,
          distributionPolicy: args.distributionPolicy,
          maxExpenseRatio: pctToFraction(args.maxExpenseRatioPct),
          includeSecondary: args.includeSecondary,
          includeInactive: args.includeInactive,
          limit: upstreamLimit,
        });

        const profileReads = await mapWithConcurrency(candidates, 12, async (row) => {
          const enc = encodeURIComponent(row.ticker);
          return settle(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`));
        });
        const profiles = profileReads.map((read) => read.data);
        const failedProfiles = profileReads.filter((read) => read.failure).length;
        const profileByTicker = new Map(candidates.map((row, index) => [row.ticker, profiles[index]]));

        let enriched = candidates.map((row) => etfSummary(row, profileByTicker.get(row.ticker) ?? null));
        enriched = enriched.filter((row) => {
          const aum = typeof row.aum === "number" ? row.aum : null;
          const expense = typeof row.expenseRatioPct === "number" ? row.expenseRatioPct : null;
          const yieldPct = typeof row.yieldTtmPct === "number" ? row.yieldTtmPct : null;
          return (args.minAum == null || (aum != null && aum >= args.minAum)) &&
            (args.maxExpenseRatioPct == null || (expense != null && expense <= args.maxExpenseRatioPct)) &&
            (args.minYieldTtmPct == null || (yieldPct != null && yieldPct >= args.minYieldTtmPct));
        });

        if (args.sortBy !== "relevance") {
          enriched.sort((a, b) => nullableCompare(
            sortValue(a, args.sortBy),
            sortValue(b, args.sortBy),
            args.sortDirection,
          ));
        }

        const candidateCapReached = needsBroadScan && candidates.length >= args.scanLimit;
        const missingProfiles = profiles.filter((profile) => profile == null).length - failedProfiles;
        const warnings: string[] = [];
        if (candidateCapReached) {
          warnings.push(
            `minAum/minYieldTtmPct screening and AUM/yield sorting scanned only the first ${args.scanLimit} coarse matches; matching ETFs may exist beyond that candidate cap. Use screen_etfs for a whole-universe result.`,
          );
        }
        if (missingProfiles > 0) {
          warnings.push(`${missingProfiles} scanned ETF(s) had no profile data; quantitative fields are null and such rows cannot pass quantitative filters.`);
        }
        if (failedProfiles > 0) {
          warnings.push(`${failedProfiles} scanned ETF profile(s) could not be loaded (request quota, rate limit or outage), so their quantitative fields are null and they cannot pass quantitative filters. That is not a coverage answer; retry later.`);
        }
        if ((args.minAum != null || args.sortBy === "aum") && !args.currency) {
          warnings.push("AUM currency is not stored in the current profile schema. Use a trading-currency filter and treat cross-domicile AUM comparisons cautiously.");
        }

        const results = enriched.slice(0, args.limit);
        return toolResult({
          query: {
            search: args.search ?? null,
            category: args.category ?? null,
            focus: args.focus ?? null,
            region: args.region ?? null,
            domicile: args.domicile ?? null,
            exchange: args.exchange ?? null,
            currency: args.currency ?? null,
            indexKey: args.indexKey ?? null,
            distributionPolicy: args.distributionPolicy ?? null,
            minAum: args.minAum ?? null,
            maxExpenseRatioPct: args.maxExpenseRatioPct ?? null,
            minYieldTtmPct: args.minYieldTtmPct ?? null,
            sortBy: args.sortBy,
            sortDirection: args.sortDirection,
          },
          coverage: {
            scannedCandidates: candidates.length,
            scanLimit: upstreamLimit,
            candidateCapReached,
            serverSideFilters: ["search", "exchange", "currency", "category", "focus", "domicile", "region", "indexKey", "distributionPolicy", "maxExpenseRatioPct"],
            clientSideFilters: ["minAum", "minYieldTtmPct"],
            profilesAvailable: profiles.length - missingProfiles,
            profilesMissing: missingProfiles,
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
