import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";

/**
 * The whole-universe screener rule engine is the heaviest upstream call (it evaluates rules
 * across the entire universe and can take tens of seconds on a broad/cold query), so it uses
 * a longer timeout than the default single-ticker read to avoid spurious client-side aborts
 * (which would surface as "operation aborted due to timeout" and still burn API quota).
 */
const SCREENER_TIMEOUT_MS = 45_000;

/** Shape of one row from POST /api/screener/filter (ScreenerResult DTO).
 *  Series are newest-first; index 0 is the most recent period. */
interface ScreenerResult {
  ticker: string;
  company?: string | null;
  exchange?: string | null;
  latestRevenue?: number | null;
  latestNetIncome?: number | null;
  latestGrossProfit?: number | null;
  latestOperatingIncome?: number | null;
  latestEbitda?: number | null;
  latestFreeCashflow?: number | null;
  latestDilutedEps?: number | null;
  latestOperatingCashflow?: number | null;
  latestCash?: number | null;
  latestTotalAssets?: number | null;
  latestTotalDebt?: number | null;
  latestStockholdersEquity?: number | null;
  latestDividendsPerShare?: number | null;
  revenueSeries?: (number | null)[] | null;
  netIncomeSeries?: (number | null)[] | null;
  grossProfitSeries?: (number | null)[] | null;
  operatingIncomeSeries?: (number | null)[] | null;
  ebitdaSeries?: (number | null)[] | null;
  freeCashflowSeries?: (number | null)[] | null;
  dilutedEpsSeries?: (number | null)[] | null;
  operatingCashflowSeries?: (number | null)[] | null;
  dividendsPerShareSeries?: (number | null)[] | null;
  marketCap?: number | null;
  peRatio?: number | null;
  dividendYield?: number | null;
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
}

interface ProjectedRow {
  ticker: string;
  company?: string | null;
  exchange?: string | null;
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
  marketCap?: number | null;
  peRatio?: number | null;
  dividendYield?: number | null;
  latestRevenue?: number | null;
  revenueGrowthPct?: number | null;
  latestNetIncome?: number | null;
  netIncomeGrowthPct?: number | null;
  latestGrossProfit?: number | null;
  grossProfitGrowthPct?: number | null;
  latestOperatingIncome?: number | null;
  operatingIncomeGrowthPct?: number | null;
  latestEbitda?: number | null;
  ebitdaGrowthPct?: number | null;
  latestFreeCashflow?: number | null;
  freeCashflowGrowthPct?: number | null;
  latestDilutedEps?: number | null;
  epsGrowthPct?: number | null;
  latestOperatingCashflow?: number | null;
  operatingCashflowGrowthPct?: number | null;
  latestCash?: number | null;
  latestTotalAssets?: number | null;
  latestTotalDebt?: number | null;
  latestStockholdersEquity?: number | null;
  latestDividendsPerShare?: number | null;
  dividendGrowthPct?: number | null;
}

const SCREENING_METRICS = [
  "revenueGrowthPct",
  "netIncomeGrowthPct",
  "grossProfitGrowthPct",
  "operatingIncomeGrowthPct",
  "ebitdaGrowthPct",
  "freeCashflowGrowthPct",
  "epsGrowthPct",
  "operatingCashflowGrowthPct",
  "dividendGrowthPct",
  "latestRevenue",
  "latestNetIncome",
  "latestGrossProfit",
  "latestOperatingIncome",
  "latestEbitda",
  "latestDilutedEps",
  "latestDividendsPerShare",
  "latestFreeCashflow",
  "latestOperatingCashflow",
  "latestCash",
  "latestTotalAssets",
  "latestTotalDebt",
  "latestStockholdersEquity",
  "marketCap",
  "peRatio",
  "dividendYield",
] as const;

const SORT_KEYS = [...SCREENING_METRICS, "revenueGrowth"] as const;
const FILTER_OPERATORS = [">=", "<=", ">", "<", "=", ".."] as const;
const VALUE_UNITS = ["", "K", "M", "B", "T"] as const;

type ScreenerMetricKey = (typeof SCREENING_METRICS)[number];
type FilterOperator = (typeof FILTER_OPERATORS)[number];
type FilterValueUnit = (typeof VALUE_UNITS)[number];

interface ScreenerRule {
  id: string;
  metric: ScreenerMetricKey;
  operator: FilterOperator;
  value: string;
  valueMax: string;
  unit: FilterValueUnit;
  groupId: number;
}

interface ScreenerFilterPayload {
  rules: ScreenerRule[];
  lookbackMode: "annual" | "quarterly";
  lookback: number;
  sector: string;
  industry: string;
  country: string;
  countries: string[];
  includeSecondary: boolean;
}

/** Period-over-period growth (newest vs previous) as a percent, or null when
 *  either value is missing or the base is zero. */
function pctGrowth(series: (number | null)[] | null | undefined): number | null {
  if (!series || series.length < 2) return null;
  const latest = series[0];
  const prev = series[1];
  if (latest == null || prev == null || prev === 0) return null;
  return Number((((latest - prev) / Math.abs(prev)) * 100).toFixed(2));
}

function stringValue(value: string | number | undefined): string {
  return value == null ? "" : String(value);
}

function normalizeSortBy(sortBy: (typeof SORT_KEYS)[number]): ScreenerMetricKey {
  return sortBy === "revenueGrowth" ? "revenueGrowthPct" : sortBy;
}

function appendGlobalRule(rules: ScreenerRule[], rule: Omit<ScreenerRule, "id" | "groupId">): void {
  const groupIds = [...new Set(rules.map((r) => r.groupId))];
  if (groupIds.length === 0) groupIds.push(1);
  for (const groupId of groupIds) {
    rules.push({ ...rule, id: `${rule.metric}-${groupId}`, groupId });
  }
}

const inputSchema = {
  sector: z.string().optional()
    .describe("Exact sector name to filter by, e.g. \"Technology\", \"Healthcare\". Omit for all sectors."),
  industry: z.string().optional()
    .describe("Exact industry name to filter by, e.g. \"Software - Infrastructure\". Omit for all industries."),
  country: z.string().optional()
    .describe("Exact country name to filter by, e.g. \"United States\", \"Germany\". Omit for all countries."),
  countries: z.array(z.string()).optional()
    .describe("Exact country names to include. Use this for multi-country screens; it overrides country when provided."),
  lookbackMode: z.enum(["annual", "quarterly"]).default("annual")
    .describe("Whether rule evaluation uses annual or quarterly reporting periods."),
  lookback: z.number().int().min(1).max(40).default(3)
    .describe("How many reporting periods to evaluate. Growth rules need at least 2 comparable periods."),
  mode: z.enum(["annual", "quarterly"]).optional()
    .describe("Deprecated alias for lookbackMode; kept for compatibility."),
  periods: z.number().int().min(1).max(40).optional()
    .describe("Deprecated alias for lookback; kept for compatibility."),
  rules: z.array(z.object({
    metric: z.enum(SCREENING_METRICS)
      .describe("Metric to filter on."),
    operator: z.enum(FILTER_OPERATORS).default(">=")
      .describe("Comparison operator. Use '..' for an inclusive between range."),
    value: z.union([z.string(), z.number()]).optional()
      .describe("Threshold value. For money metrics, combine with unit for K/M/B/T scaling."),
    valueMax: z.union([z.string(), z.number()]).optional()
      .describe("Upper bound for '..' range rules. Ignored for other operators."),
    unit: z.enum(VALUE_UNITS).default("")
      .describe("Optional money unit for money metrics: '', K, M, B or T."),
    groupId: z.number().int().min(1).default(1)
      .describe("Rules with the same groupId are ANDed; different groups are ORed."),
  })).default([])
    .describe("Fundamental rules. Same groupId means AND; different groupIds mean OR."),
  minMarketCap: z.number().min(0).optional()
    .describe("Compatibility shortcut: adds marketCap >= this absolute value to every rule group."),
  includeSecondary: z.boolean().default(false)
    .describe("Include secondary cross-listings of the same security. Default false (primary listings only)."),
  includeInactive: z.boolean().default(false)
    .describe("Include delisted/inactive tickers with no recent price bar. Default false."),
  sortBy: z.enum(SORT_KEYS).default("marketCap")
    .describe("Metric to sort by. revenueGrowth is accepted as an alias for revenueGrowthPct."),
  order: z.enum(["desc", "asc"]).default("desc")
    .describe("Sort direction. Nulls always sort last regardless of direction."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum number of stocks to return (1-100)."),
};

export function registerScreenStocks(server: McpServer): void {
  server.registerTool(
    "screen_stocks",
    {
      title: "Screen stocks",
      annotations: { readOnlyHint: true },
      description:
        "Screen the global Bullrun stock universe with the same rule engine as the app screener. Filter by sector, industry, country/countries, primary vs secondary listings, active vs inactive listings, lookback mode, AND/OR rule groups, comparison operators, money units, growth metrics and latest-value metrics. Returns a compact table of matching stocks. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const lookbackMode = args.lookbackMode ?? args.mode ?? "annual";
        const lookback = args.lookback ?? args.periods ?? 3;
        const sortBy = normalizeSortBy(args.sortBy ?? "marketCap");

        const rules: ScreenerRule[] = (args.rules ?? []).map((rule, idx) => ({
          id: `mcp-rule-${idx + 1}`,
          metric: rule.metric,
          operator: rule.operator ?? ">=",
          value: stringValue(rule.value),
          valueMax: stringValue(rule.valueMax),
          unit: rule.unit ?? "",
          groupId: rule.groupId ?? 1,
        }));

        if (args.minMarketCap != null) {
          appendGlobalRule(rules, {
            metric: "marketCap",
            operator: ">=",
            value: String(args.minMarketCap),
            valueMax: "",
            unit: "",
          });
        }

        const filter: ScreenerFilterPayload = {
          rules,
          lookbackMode,
          lookback,
          sector: args.sector ?? "",
          industry: args.industry ?? "",
          country: args.country ?? "",
          countries: args.countries ?? [],
          includeSecondary: args.includeSecondary ?? false,
        };

        const params = new URLSearchParams({
          includeInactive: String(args.includeInactive ?? false),
          limit: String(args.limit ?? 25),
          sortBy,
          order: args.order ?? "desc",
        });

        const rows = await bullrunPost<ScreenerResult[]>(`/api/screener/filter?${params}`, filter, SCREENER_TIMEOUT_MS);

        const results: ProjectedRow[] = rows.map((r) => ({
          ticker: r.ticker,
          company: r.company,
          exchange: r.exchange,
          sector: r.sector,
          industry: r.industry,
          country: r.country,
          marketCap: r.marketCap,
          peRatio: r.peRatio,
          dividendYield: r.dividendYield,
          latestRevenue: r.latestRevenue,
          revenueGrowthPct: pctGrowth(r.revenueSeries),
          latestNetIncome: r.latestNetIncome,
          netIncomeGrowthPct: pctGrowth(r.netIncomeSeries),
          latestGrossProfit: r.latestGrossProfit,
          grossProfitGrowthPct: pctGrowth(r.grossProfitSeries),
          latestOperatingIncome: r.latestOperatingIncome,
          operatingIncomeGrowthPct: pctGrowth(r.operatingIncomeSeries),
          latestEbitda: r.latestEbitda,
          ebitdaGrowthPct: pctGrowth(r.ebitdaSeries),
          latestFreeCashflow: r.latestFreeCashflow,
          freeCashflowGrowthPct: pctGrowth(r.freeCashflowSeries),
          latestDilutedEps: r.latestDilutedEps,
          epsGrowthPct: pctGrowth(r.dilutedEpsSeries),
          latestOperatingCashflow: r.latestOperatingCashflow,
          operatingCashflowGrowthPct: pctGrowth(r.operatingCashflowSeries),
          latestCash: r.latestCash,
          latestTotalAssets: r.latestTotalAssets,
          latestTotalDebt: r.latestTotalDebt,
          latestStockholdersEquity: r.latestStockholdersEquity,
          latestDividendsPerShare: r.latestDividendsPerShare,
          dividendGrowthPct: pctGrowth(r.dividendsPerShareSeries),
        }));

        const payload = {
          query: {
            sector: args.sector ?? null,
            industry: args.industry ?? null,
            country: args.country ?? null,
            countries: args.countries ?? null,
            lookbackMode,
            lookback,
            rules,
            minMarketCap: args.minMarketCap ?? null,
            sortBy: args.sortBy ?? "marketCap",
            order: args.order ?? "desc",
            limit: args.limit ?? 25,
          },
          totalMatches: results.length,
          returned: results.length,
          results,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `screen_stocks failed: ${msg}` }] };
      }
    },
  );
}
