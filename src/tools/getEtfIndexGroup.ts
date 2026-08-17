import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { fractionToPct, toolResult } from "./etfData.js";

/** GET /api/etfs/index/{indexKey} — one row per FUND, not per venue listing. */
interface IndexFund {
  fundIsin?: string | null;
  ticker: string;
  fundName?: string | null;
  fundFamily?: string | null;
  domicile?: string | null;
  currency?: string | null;
  /** Fraction, not percent: 0.0007 means 0.07%. Null when the vendor publishes no fee. */
  expenseRatio?: number | null;
  distributionPolicy?: string | null;
  totalAssets?: number | null;
  listingCount: number;
  venues: string[];
}

interface IndexGroup {
  indexKey: string;
  fundCount: number;
  fundsWithFee: number;
  fundsWithoutFee: number;
  cheapestFee?: number | null;
  dearestFee?: number | null;
  funds: IndexFund[];
}

interface IndexGroupSummary {
  indexKey: string;
  fundCount: number;
  cheapestFee?: number | null;
}

const inputSchema = {
  indexKey: z.string().optional()
    .describe("Normalized index key, e.g. SP500, MSCI_WORLD, NASDAQ100, MSCI_EM, EURO_STOXX_50, TOPIX, FTSE100. Omit to list every index family that has at least one fund."),
  scope: z.enum(["ucits", "all"]).default("ucits")
    .describe("ucits (default) restricts to domiciles a European retail investor can actually buy. all adds US-domiciled trackers, which look cheaper but are not purchasable by EU retail."),
  distributionPolicy: z.enum(["ACCUMULATING", "DISTRIBUTING"]).optional()
    .describe("Optionally keep only accumulating or only distributing share classes."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum funds (or index families) to return, 1-100."),
};

const outputSchema = {
  mode: z.enum(["index_group", "index_list"]),
  indexKey: z.string().nullable(),
  scope: z.string(),
  found: z.boolean(),
  coverage: z.record(z.string(), z.unknown()),
  funds: z.array(z.record(z.string(), z.unknown())),
  indexFamilies: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
};

export function registerGetEtfIndexGroup(server: McpServer): void {
  server.registerTool(
    "get_etf_index_group",
    {
      title: "Compare funds tracking one index",
      annotations: { readOnlyHint: true },
      description:
        "Answer \"what is the cheapest way to track <index>?\". Returns every fund tracking one index ordered cheapest fee first, deduplicated to one row per FUND rather than per venue listing (a five-venue UCITS fund is one choice, not five) with its listingCount and venues. Defaults to UCITS-buyable domiciles. Omit indexKey to list the available index families. Fees are percentage points and the response states how many funds publish no fee at all, so a \"cheapest\" claim is never made over silently omitted funds. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const warnings: string[] = [];

        if (!args.indexKey?.trim()) {
          const families = await bullrunGet<IndexGroupSummary[]>("/api/etfs/index");
          const sorted = [...(families ?? [])].sort((a, b) => b.fundCount - a.fundCount);
          return toolResult({
            mode: "index_list",
            indexKey: null,
            scope: args.scope,
            found: sorted.length > 0,
            coverage: {
              indexFamilies: sorted.length,
              note: "Family counts are fund-level (venue listings collapsed) and are NOT scope-filtered; call again with an indexKey to apply the UCITS scope.",
            },
            funds: [],
            indexFamilies: sorted.slice(0, args.limit).map((row) => ({
              indexKey: row.indexKey,
              fundCount: row.fundCount,
              cheapestFeePct: fractionToPct(row.cheapestFee),
            })),
            warnings,
          });
        }

        const indexKey = args.indexKey.trim().toUpperCase();
        const group = await bullrunGet<IndexGroup>(
          `/api/etfs/index/${encodeURIComponent(indexKey)}`,
          { scope: args.scope },
        ).catch((err) => {
          if (err instanceof Error && / 404 /.test(err.message)) return null;
          throw err;
        });

        if (!group) {
          return toolResult({
            mode: "index_group",
            indexKey,
            scope: args.scope,
            found: false,
            coverage: {},
            funds: [],
            indexFamilies: [],
            warnings: [`No index family is stored under "${indexKey}". Call this tool without indexKey to list the valid keys.`],
          });
        }

        let funds = group.funds ?? [];
        if (args.distributionPolicy) {
          funds = funds.filter((fund) => fund.distributionPolicy === args.distributionPolicy);
        }
        const results = funds.slice(0, args.limit).map((fund) => ({
          fundIsin: fund.fundIsin ?? null,
          representativeTicker: fund.ticker,
          fundName: fund.fundName ?? null,
          issuer: fund.fundFamily ?? null,
          domicile: fund.domicile ?? null,
          currency: fund.currency ?? null,
          expenseRatioPct: fractionToPct(fund.expenseRatio),
          distributionPolicy: fund.distributionPolicy ?? null,
          totalAssets: fund.totalAssets ?? null,
          listingCount: fund.listingCount,
          venues: fund.venues ?? [],
        }));

        if (group.fundsWithoutFee > 0) {
          warnings.push(
            `${group.fundsWithoutFee} of ${group.fundCount} funds tracking ${indexKey} publish no expense ratio; they are listed after the priced funds and cannot be ranked on cost.`,
          );
        }
        if (args.scope === "all") {
          warnings.push("scope=all includes US-domiciled trackers. They are usually cheaper on paper but a European retail investor generally cannot buy them.");
        }
        if (args.distributionPolicy) {
          warnings.push(`Filtered to ${args.distributionPolicy} share classes only; fee coverage counts describe the unfiltered group.`);
        }

        return toolResult({
          mode: "index_group",
          indexKey: group.indexKey,
          scope: args.scope,
          found: true,
          coverage: {
            fundCount: group.fundCount,
            fundsWithFee: group.fundsWithFee,
            fundsWithoutFee: group.fundsWithoutFee,
            cheapestFeePct: fractionToPct(group.cheapestFee),
            dearestFeePct: fractionToPct(group.dearestFee),
            fundsAfterPolicyFilter: funds.length,
            returned: results.length,
            dedup: "One row per fund; venue listings are collapsed into listingCount/venues.",
          },
          funds: results,
          indexFamilies: [],
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_index_group failed: ${msg}` }] };
      }
    },
  );
}
