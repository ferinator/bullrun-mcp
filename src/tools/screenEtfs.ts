import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { fractionToPct, toolResult } from "./etfData.js";
import { roundMetric } from "./etfAnalytics.js";

/**
 * The ETF screen evaluates rules across the whole fund universe (~25k listing rows) in one
 * upstream pass, so it gets the same extended timeout as the equity screener rather than the
 * default single-ticker read budget.
 */
const SCREENER_TIMEOUT_MS = 45_000;

/**
 * Numeric metrics the upstream rule engine can evaluate. Expense ratio and yield are exposed
 * in PERCENTAGE POINTS here because that is how the upstream screener scales them for rules
 * (`scaleFractionToPercent`) — unlike the `maxExpenseRatio` query param on /api/etfs, which
 * is a fraction. Callers never see a fraction from this tool.
 */
const SCREEN_METRICS = [
  "expenseRatioPct",
  "totalAssets",
  "yieldTtmPct",
  "holdingsCount",
  "fundAgeYears",
  "inceptionYear",
  "nav",
  "return1mPct",
  "return3mPct",
  "return6mPct",
  "return1yPct",
  "returnYtdPct",
  "volatility1yPct",
  "avgVolume90d",
  "avgTurnover90d",
  "top10ConcentrationPct",
] as const;

const OPERATORS = [">=", "<=", ">", "<", "=", ".."] as const;
const VALUE_UNITS = ["", "K", "M", "B", "T"] as const;

const SORT_KEYS = [
  "expenseRatioPct",
  "totalAssets",
  "yieldTtmPct",
  "return1mPct",
  "return3mPct",
  "return6mPct",
  "return1yPct",
  "returnYtdPct",
  "volatility1yPct",
  "avgVolume90d",
  "avgTurnover90d",
  "top10ConcentrationPct",
  "holdingsCount",
  "nav",
  "ticker",
  "name",
] as const;
type SortKey = (typeof SORT_KEYS)[number];

/** One row of POST /api/etfs/screener (InstrumentSearchResult). Fractions where noted. */
interface EtfScreenRow {
  ticker: string;
  company?: string | null;
  exchange?: string | null;
  currency?: string | null;
  country?: string | null;
  isin?: string | null;
  primaryTicker?: string | null;
  /** Fraction, not percent: 0.0009 means 0.09%. */
  expenseRatio?: number | null;
  distributionPolicy?: string | null;
  indexKey?: string | null;
  fundIsin?: string | null;
  totalAssets?: number | null;
  nav?: number | null;
  /** Fraction, not percent. */
  yieldTtm?: number | null;
  inceptionDate?: string | null;
  holdingsCount?: number | null;
  region?: string | null;
  domicile?: string | null;
  productType?: string | null;
  benchmark?: string | null;
  assetClass?: string | null;
  category?: string | null;
  fundFamily?: string | null;
  return1mPct?: number | null;
  return3mPct?: number | null;
  return6mPct?: number | null;
  return1yPct?: number | null;
  returnYtdPct?: number | null;
  volatility1yPct?: number | null;
  avgVolume90d?: number | null;
  avgTurnover90d?: number | null;
  top10ConcentrationPct?: number | null;
  assetClassGroup?: string | null;
  strategy?: string | null;
  marketDevelopment?: string | null;
  currencyHedged?: boolean | null;
}

interface EtfScreenResponse {
  rows: EtfScreenRow[];
  evaluatedCount: number;
  matchCount: number;
  truncated: boolean;
}

const inputSchema = {
  search: z.string().optional()
    .describe("Free-text match on ticker, fund name or ISIN. Omit to screen the whole universe."),
  assetClass: z.string().optional()
    .describe("Exact asset-class group: EQUITY, FIXED_INCOME, COMMODITY, REAL_ESTATE, MULTI_ASSET, CASH, CURRENCY, DIGITAL_ASSETS, ALTERNATIVES or OTHER."),
  category: z.string().optional()
    .describe("Exact category string. Call get_etf_filter_options for the valid values; a wrong guess silently returns zero rows."),
  domicile: z.string().optional()
    .describe("Exact fund domicile, e.g. \"Ireland\", \"Luxembourg\", \"United States\"."),
  region: z.string().optional().describe("Exact investment-region string."),
  exchange: z.string().optional().describe("Exact listing exchange, e.g. XETRA, LSE, \"NYSE ARCA\"."),
  currency: z.string().optional().describe("Exact trading currency, e.g. EUR, USD, GBX."),
  indexKey: z.string().optional()
    .describe("Exact tracked-index key, e.g. SP500, MSCI_WORLD, NASDAQ100. Use get_etf_index_group to compare every fund on one index instead."),
  distributionPolicy: z.enum(["ACCUMULATING", "DISTRIBUTING"]).optional()
    .describe("Accumulating (reinvests income) or distributing (pays it out) — the usual first cut for a European investor."),
  productType: z.string().optional().describe("Exact wrapper type, e.g. UCITS_FUND."),
  ucitsStatus: z.enum(["UCITS", "NON_UCITS"]).optional()
    .describe("UCITS restricts to wrappers a European retail investor can actually buy."),
  issuer: z.string().optional()
    .describe("Substring match on the fund family/issuer, e.g. \"iShares\", \"Amundi\", \"Vanguard\"."),
  strategy: z.string().optional().describe("Exact strategy classification string."),
  benchmarkSearch: z.string().optional().describe("Substring match on the stated benchmark name."),
  marketDevelopment: z.string().optional()
    .describe("Exact market-development classification, e.g. developed vs emerging."),
  currencyHedged: z.enum(["HEDGED", "NOT_LABELLED_HEDGED"]).optional()
    .describe("HEDGED selects funds labelled currency-hedged. NOT_LABELLED_HEDGED selects funds not so labelled — absence of a label is not proof a fund is unhedged."),
  holdingSearch: z.string().optional()
    .describe("Look-through filter: find funds by a CONSTITUENT ticker or company name, e.g. \"NVDA\" or \"NVIDIA\". Only funds with a stored holdings snapshot can match."),
  holdingMode: z.enum(["INCLUDES", "EXCLUDES"]).default("INCLUDES")
    .describe("INCLUDES keeps funds holding the constituent. EXCLUDES keeps only funds with a holdings snapshot that confirms absence — funds with no snapshot are dropped, never assumed clean."),
  holdingMinWeightPct: z.number().min(0).max(100).optional()
    .describe("Minimum constituent weight in percentage points for holdingSearch to count as a match."),
  rules: z.array(z.object({
    metric: z.enum(SCREEN_METRICS).describe("Numeric metric to filter on."),
    operator: z.enum(OPERATORS).default(">=")
      .describe("Comparison operator. Use '..' for an inclusive between range with valueMax."),
    value: z.union([z.string(), z.number()]).optional()
      .describe("Threshold. For money metrics combine with unit for K/M/B/T scaling."),
    valueMax: z.union([z.string(), z.number()]).optional()
      .describe("Upper bound for '..' range rules. Ignored for other operators."),
    unit: z.enum(VALUE_UNITS).default("")
      .describe("Optional money unit for money metrics: '', K, M, B or T."),
    groupId: z.number().int().min(1).default(1)
      .describe("Rules with the same groupId are ANDed; different groups are ORed."),
  })).default([])
    .describe("Numeric rules. A fund with no value for a ruled metric never matches that rule."),
  includeSecondary: z.boolean().default(false)
    .describe("Return every venue listing as its own row. Default false: one row per FUND (by fund ISIN), showing its most liquid listing with the others under otherListings. Use exchange/currency to choose the venue, e.g. exchange \"SW\" for the SIX line."),
  sortBy: z.enum(SORT_KEYS).default("totalAssets")
    .describe("Sort field applied to the returned rows."),
  order: z.enum(["desc", "asc"]).default("desc")
    .describe("Sort direction. Nulls always sort last regardless of direction."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum ETFs to return, 1-100."),
};

const outputSchema = {
  query: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  matchCount: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  results: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
};

function project(row: EtfScreenRow): Record<string, unknown> {
  return {
    ticker: row.ticker,
    name: row.company ?? null,
    issuer: row.fundFamily ?? null,
    exchange: row.exchange ?? null,
    tradingCurrency: row.currency ?? null,
    isin: row.isin ?? null,
    fundIsin: row.fundIsin ?? null,
    assetClass: row.assetClass ?? null,
    assetClassGroup: row.assetClassGroup ?? null,
    category: row.category ?? null,
    strategy: row.strategy ?? null,
    region: row.region ?? null,
    marketDevelopment: row.marketDevelopment ?? null,
    domicile: row.domicile ?? null,
    productType: row.productType ?? null,
    indexKey: row.indexKey ?? null,
    benchmark: row.benchmark ?? null,
    distributionPolicy: row.distributionPolicy ?? null,
    currencyHedged: row.currencyHedged ?? null,
    expenseRatioPct: fractionToPct(row.expenseRatio),
    yieldTtmPct: fractionToPct(row.yieldTtm),
    totalAssets: row.totalAssets ?? null,
    nav: row.nav ?? null,
    holdingsCount: row.holdingsCount ?? null,
    top10ConcentrationPct: roundMetric(row.top10ConcentrationPct ?? null, 4),
    inceptionDate: row.inceptionDate ?? null,
    return1mPct: roundMetric(row.return1mPct ?? null, 4),
    return3mPct: roundMetric(row.return3mPct ?? null, 4),
    return6mPct: roundMetric(row.return6mPct ?? null, 4),
    return1yPct: roundMetric(row.return1yPct ?? null, 4),
    returnYtdPct: roundMetric(row.returnYtdPct ?? null, 4),
    volatility1yPct: roundMetric(row.volatility1yPct ?? null, 4),
    avgVolume90d: row.avgVolume90d ?? null,
    avgTurnover90d: row.avgTurnover90d ?? null,
    isPrimaryListing: row.primaryTicker == null,
  };
}

/** One fund, however many venues it is listed on: fund ISIN, else listing ISIN, else ticker. */
function fundKey(row: Record<string, unknown>): string {
  return String(row.fundIsin ?? row.isin ?? row.ticker).toUpperCase();
}

/**
 * The same UCITS fund is listed on many venues under different tickers, and each
 * venue line is stored as a primary listing -- so includeSecondary=false never
 * collapsed them (VWCE.AS, VWCE.DE, VWCE.MI, VWRA.L... came back as six funds).
 * Collapse by fund here: the most traded line represents the fund.
 */
function collapseVenues(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byFund = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = fundKey(row);
    const group = byFund.get(key);
    if (group) group.push(row);
    else byFund.set(key, [row]);
  }
  const liquidity = (row: Record<string, unknown>) => Number(row.avgTurnover90d ?? -1);
  return [...byFund.values()].map((group) => {
    const ordered = [...group].sort((a, b) => liquidity(b) - liquidity(a)
      || Number(b.isPrimaryListing) - Number(a.isPrimaryListing)
      || String(a.ticker).localeCompare(String(b.ticker)));
    const [representative, ...others] = ordered;
    return {
      ...representative,
      listingCount: group.length,
      otherListings: others.map((row) => ({ ticker: row.ticker, exchange: row.exchange, tradingCurrency: row.tradingCurrency })),
    };
  });
}

function sortValue(row: Record<string, unknown>, key: SortKey): unknown {
  if (key === "name") return row.name;
  return row[key];
}

function nullableCompare(a: unknown, b: unknown, order: "asc" | "desc"): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  const result = typeof a === "string" && typeof b === "string"
    ? a.localeCompare(b)
    : Number(a) - Number(b);
  return order === "asc" ? result : -result;
}

export function registerScreenEtfs(server: McpServer): void {
  server.registerTool(
    "screen_etfs",
    {
      title: "Screen ETFs",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Screen the WHOLE ETF universe by numeric rules and fund attributes in one pass — expense ratio, AUM, yield, trailing returns, volatility, liquidity, top-10 concentration, fund age and holdings count — combined with issuer, index, domicile, UCITS status, distribution policy, currency hedging and constituent look-through (holdingSearch finds funds by what they hold). Prefer this over search_etfs for any \"cheapest / largest / best performing / most liquid\" question: search_etfs only filters a bounded candidate scan, while this evaluates the full universe and reports evaluatedCount and matchCount. Percentages are percentage points. This full-universe screen is an expensive read, and request limits depend on your connection and plan. Build one precise screen to conserve your allowance. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");

        const response = await bullrunPost<EtfScreenResponse>(
          "/api/etfs/screener",
          {
            search: args.search?.trim() || null,
            exchange: args.exchange ?? null,
            currency: args.currency ?? null,
            assetClass: args.assetClass ?? null,
            category: args.category ?? null,
            domicile: args.domicile ?? null,
            region: args.region ?? null,
            indexKey: args.indexKey ?? null,
            distributionPolicy: args.distributionPolicy ?? null,
            productType: args.productType ?? null,
            includeSecondary: args.includeSecondary,
            issuer: args.issuer ?? null,
            strategy: args.strategy ?? null,
            benchmarkSearch: args.benchmarkSearch ?? null,
            marketDevelopment: args.marketDevelopment ?? null,
            ucitsStatus: args.ucitsStatus ?? null,
            currencyHedged: args.currencyHedged ?? null,
            holdingSearch: args.holdingSearch?.trim() || null,
            holdingMode: args.holdingSearch ? args.holdingMode : null,
            holdingMinWeightPct: args.holdingMinWeightPct ?? null,
            rules: args.rules.map((rule) => ({
              metric: rule.metric,
              operator: rule.operator,
              value: rule.value == null ? null : String(rule.value),
              valueMax: rule.valueMax == null ? null : String(rule.valueMax),
              unit: rule.unit,
              groupId: rule.groupId,
            })),
          },
          SCREENER_TIMEOUT_MS,
        );

        const listings = (response.rows ?? []).map(project);
        const projected = args.includeSecondary ? listings : collapseVenues(listings);
        projected.sort((a, b) => nullableCompare(
          sortValue(a, args.sortBy),
          sortValue(b, args.sortBy),
          args.order,
        ));
        const results = projected.slice(0, args.limit);

        const warnings: string[] = [];
        if (response.truncated) {
          warnings.push(
            `Upstream returned a capped result page (${response.rows?.length ?? 0} of ${response.matchCount} matches); the sort was applied to that page, so it is not guaranteed to be the global top ${args.limit}. Narrow the filters for an exact ranking.`,
          );
        }
        if (args.rules.length > 0) {
          warnings.push("Funds with no stored value for a ruled metric are excluded, so a rule also filters on data coverage.");
        }
        if (args.holdingSearch) {
          warnings.push(
            args.holdingMode === "EXCLUDES"
              ? "EXCLUDES only keeps funds whose stored holdings snapshot confirms the constituent is absent; funds without a snapshot are dropped rather than assumed clean."
              : "Look-through matching only covers funds with a stored holdings snapshot; a fund missing that snapshot cannot match even if it holds the constituent.",
          );
        }
        if (args.rules.some((rule) => rule.metric === "totalAssets") || args.sortBy === "totalAssets") {
          warnings.push("AUM is reported in the fund's own currency; cross-domicile AUM comparisons are not FX-normalized.");
        }

        return toolResult({
          query: {
            search: args.search ?? null,
            assetClass: args.assetClass ?? null,
            category: args.category ?? null,
            domicile: args.domicile ?? null,
            region: args.region ?? null,
            exchange: args.exchange ?? null,
            currency: args.currency ?? null,
            indexKey: args.indexKey ?? null,
            distributionPolicy: args.distributionPolicy ?? null,
            productType: args.productType ?? null,
            ucitsStatus: args.ucitsStatus ?? null,
            issuer: args.issuer ?? null,
            strategy: args.strategy ?? null,
            benchmarkSearch: args.benchmarkSearch ?? null,
            marketDevelopment: args.marketDevelopment ?? null,
            currencyHedged: args.currencyHedged ?? null,
            holdingSearch: args.holdingSearch ?? null,
            holdingMode: args.holdingSearch ? args.holdingMode : null,
            holdingMinWeightPct: args.holdingMinWeightPct ?? null,
            rules: args.rules,
            includeSecondary: args.includeSecondary,
            sortBy: args.sortBy,
            order: args.order,
          },
          coverage: {
            evaluatedListings: response.evaluatedCount ?? 0,
            rowsReturnedByUpstream: response.rows?.length ?? 0,
            upstreamTruncated: Boolean(response.truncated),
            includeSecondary: args.includeSecondary,
            distinctFundsInReturnedRows: new Set(listings.map(fundKey)).size,
            note: "The screened universe covers ETF listings with a price bar in the last 30 days; dormant or delisted lines are out of scope. matchCount counts venue listings; with includeSecondary=false each result row is one fund.",
          },
          matchCount: response.matchCount ?? 0,
          returned: results.length,
          results,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `screen_etfs failed: ${msg}` }] };
      }
    },
  );
}
