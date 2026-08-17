import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";

/**
 * The full facet payload is ~47KB, dominated by fundFamilies (~890) and industries (~650).
 * Returning all of it on every call would burn context for no benefit, so the two long tails
 * are opt-in and every facet is truncated with an explicit count.
 */
const FACETS = [
  "assetClasses",
  "categories",
  "indexKeys",
  "productTypes",
  "regions",
  "domiciles",
  "currencies",
  "exchanges",
  "sectors",
  "fundFamilies",
  "industries",
] as const;
type Facet = (typeof FACETS)[number];

const DEFAULT_FACETS: Facet[] = [
  "assetClasses",
  "categories",
  "indexKeys",
  "productTypes",
  "regions",
  "domiciles",
  "currencies",
  "exchanges",
];

const inputSchema = {
  facets: z.array(z.enum(FACETS)).min(1).optional()
    .describe("Which facets to return. Defaults to everything except the long tails fundFamilies (~890 issuers) and industries (~650 focus strings) — request those explicitly, ideally with search."),
  search: z.string().optional()
    .describe("Case-insensitive substring filter applied to every requested facet, e.g. \"ishares\" against fundFamilies or \"world\" against categories."),
  limit: z.number().int().min(1).max(1000).default(100)
    .describe("Maximum values per facet, 1-1000. Each facet reports its untruncated total."),
};

const outputSchema = {
  facets: z.record(z.string(), z.unknown()),
  totals: z.record(z.string(), z.number()),
  truncatedFacets: z.array(z.string()),
  search: z.string().nullable(),
  notes: z.array(z.string()),
};

export function registerGetEtfFilterOptions(server: McpServer): void {
  server.registerTool(
    "get_etf_filter_options",
    {
      title: "List ETF filter values",
      annotations: { readOnlyHint: true },
      description:
        "List the exact values accepted by the categorical filters on search_etfs and screen_etfs — asset classes, categories, index keys, product/wrapper types, regions, domiciles, currencies, exchanges, and (on request) issuers and focus strings. Those filters match exactly, so a guessed string returns zero rows and looks like \"no such ETF exists\"; call this first whenever a filter value is not already known to be valid. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const requested = args.facets && args.facets.length > 0
          ? ([...new Set(args.facets)] as Facet[])
          : DEFAULT_FACETS;
        const meta = await bullrunGet<Record<string, string[]>>("/api/etfs/meta");
        const needle = args.search?.trim().toLowerCase() ?? "";

        const facets: Record<string, string[]> = {};
        const totals: Record<string, number> = {};
        const truncatedFacets: string[] = [];

        for (const facet of requested) {
          const all = Array.isArray(meta?.[facet]) ? meta[facet] : [];
          const filtered = needle
            ? all.filter((value) => value.toLowerCase().includes(needle))
            : all;
          totals[facet] = filtered.length;
          facets[facet] = filtered.slice(0, args.limit);
          if (filtered.length > args.limit) truncatedFacets.push(facet);
        }

        const notes = [
          "These values match exactly (case and spacing included) on every filter except issuer and benchmarkSearch, which are substring matches.",
          "search_etfs calls categories \"category\" and industries \"focus\"; screen_etfs calls them \"category\" and has no focus filter.",
        ];
        if (requested.includes("industries")) {
          notes.push("industries is a raw per-fund focus string for ETFs, not a real taxonomy — many values name a single product. Prefer categories or indexKeys for grouping.");
        }
        if (truncatedFacets.length > 0) {
          notes.push(`Truncated to ${args.limit} values: ${truncatedFacets.join(", ")}. Narrow with search or raise limit.`);
        }

        return toolResult({
          facets,
          totals,
          truncatedFacets,
          search: args.search?.trim() || null,
          notes,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_filter_options failed: ${msg}` }] };
      }
    },
  );
}
