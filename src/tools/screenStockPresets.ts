import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { cleanText, finiteNumber } from "./stockDiscoveryData.js";

type Rule = { metric: string; operator: ">" | ">=" | "<="; value: string; valueMax: string; unit: ""; groupId: 1 };
const rule = (metric: string, operator: Rule["operator"], value: number): Rule => ({ metric, operator, value: String(value), valueMax: "", unit: "", groupId: 1 });
const PROFIT_AND_CASH = [rule("latestNetIncome", ">", 0), rule("latestFreeCashflow", ">", 0)];

/** Deliberately limited to the existing public screen_stocks rule catalogue. */
export const STOCK_SCREEN_PRESETS = {
  profitable_value: {
    label: "Profitable value", description: "Positive earnings and free cash flow, with a positive trailing P/E no higher than 20.",
    rules: [...PROFIT_AND_CASH, rule("peRatio", ">", 0), rule("peRatio", "<=", 20)], sortBy: "peRatio", order: "asc",
  },
  dividend_income: {
    label: "Dividend income", description: "Backend dividend yield of at least 3%, positive earnings and positive free cash flow. Yield basis is event-derived where available, otherwise an unverified provider fallback.",
    rules: [...PROFIT_AND_CASH, rule("dividendYield", ">=", 3)], sortBy: "dividendYield", order: "desc",
  },
  growth_and_cashflow: {
    label: "Growth and cash flow", description: "Available adjacent revenue and diluted-EPS growth observations of at least 10%, plus positive latest earnings and free cash flow.",
    rules: [...PROFIT_AND_CASH, rule("revenueGrowthPct", ">=", 10), rule("epsGrowthPct", ">=", 10)], sortBy: "revenueGrowthPct", order: "desc",
  },
  cash_generators: {
    label: "Cash generators", description: "Positive net income, operating cash flow and free cash flow, with nonnegative available adjacent revenue growth.",
    rules: [...PROFIT_AND_CASH, rule("latestOperatingCashflow", ">", 0), rule("revenueGrowthPct", ">=", 0)], sortBy: "revenueGrowthPct", order: "desc",
  },
  dividend_growth: {
    label: "Dividend growth", description: "Positive backend dividend yield and available adjacent dividend-per-share growth of at least 5%, plus positive earnings and free cash flow. The yield fallback basis is unverified.",
    rules: [...PROFIT_AND_CASH, rule("dividendYield", ">", 0), rule("dividendGrowthPct", ">=", 5)], sortBy: "dividendGrowthPct", order: "desc",
  },
} as const;

const PRESET_KEYS = ["profitable_value", "dividend_income", "growth_and_cashflow", "cash_generators", "dividend_growth"] as const;

const SCREENER_METHOD = {
  evaluation: "The existing backend screener evaluates these exact rules; same-group rules are ANDed. No local financial estimates or model/guru strategy replication is performed.",
  growth: "Growth = (newer - older) / abs(older) * 100. Each available adjacent observation in the lookback must pass. Missing/zero-base segments are skipped by the backend; at least one comparable segment is required. This does not establish consecutive calendar-year coverage or a CAGR.",
  annual: "Annual mode uses reported annual rows, with the backend's existing four-quarter aggregation fallback when no annual row exists. The endpoint does not identify which returned row used that fallback or expose fiscal dates/currencies.",
  coverage: "The backend scans at most 5,000 candidates after categorical/listing filters, before applying numeric rules and sorting. It does not return evaluated or full-match counts; results cannot be described as an exhaustive global screen.",
  units: "Yield and growth thresholds are percentage points. Positive monetary filters compare reported values with zero and do not compare amounts across currencies. No FX normalization is performed; output monetary currencies/dates are unknown in this endpoint.",
  dividendYield: "The backend uses stored dividend events and a recent close for an event-derived yield where available. With dividend history but no recent payment, the result is null; without event history it can fall back to the provider valuation yield. The endpoint does not identify the per-row basis, so a provider fallback must not be labeled trailing or forward yield.",
};

function growth(series: unknown): Array<number | null> {
  if (!Array.isArray(series)) return [];
  return series.slice(1).map((previous, index) => {
    const newer = finiteNumber(series[index]);
    const older = finiteNumber(previous);
    return newer == null || older == null || older === 0 ? null : Number(((newer - older) / Math.abs(older) * 100).toFixed(4));
  });
}

function project(row: Record<string, unknown>) {
  return {
    ticker: cleanText(row.ticker, 80), company: cleanText(row.company), exchange: cleanText(row.exchange, 60),
    sector: cleanText(row.sector, 100), industry: cleanText(row.industry, 140), country: cleanText(row.country, 80),
    peRatio: finiteNumber(row.peRatio), dividendYieldPct: finiteNumber(row.dividendYield),
    latestNetIncome: finiteNumber(row.latestNetIncome), latestFreeCashflow: finiteNumber(row.latestFreeCashflow),
    latestOperatingCashflow: finiteNumber(row.latestOperatingCashflow), latestRevenue: finiteNumber(row.latestRevenue),
    reportingCurrency: null, fiscalPeriod: null,
    growthObservationsNewestFirst: { revenuePct: growth(row.revenueSeries), epsPct: growth(row.dilutedEpsSeries), dividendPct: growth(row.dividendsPerShareSeries) },
  };
}

export function registerScreenStockPresets(server: McpServer): void {
  server.registerTool("screen_stock_presets", {
    title: "Explore and run transparent stock screens",
    annotations: { readOnlyHint: true },
    description: "List or execute named stock-screen starting points: profitable value, dividend income, growth and cash flow, cash generators, or dividend growth. Every preset discloses exact thresholds, units, annual lookback and sorting and runs the existing backend screener rule engine. These are mechanical screens, not recommendations or replications of a famous investor's strategy. Listing presets makes no backend request. Read-only; running a screen uses the API's metered screening budget.",
    inputSchema: {
      action: z.enum(["list", "run"]).default("list").describe("list shows exact rules without running a screen; run executes one named preset."),
      preset: z.enum(PRESET_KEYS).optional().describe("Required for run. For custom thresholds, copy the returned screen_stocks arguments and edit them."),
      sector: z.string().trim().min(1).max(100).optional(),
      industry: z.string().trim().min(1).max(140).optional(),
      countries: z.array(z.string().trim().min(1).max(80)).max(20).default([]).describe("Exact stored country names. Empty means all covered countries."),
      lookback: z.number().int().min(2).max(10).default(3).describe("Annual observations requested. Growth uses available adjacent segments, not CAGR; missing segments are skipped by the backend."),
      limit: z.number().int().min(1).max(50).default(20),
    },
  }, async args => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text" as const, text: 'screen_stock_presets requires the "read:market" scope.' }] }; }
    const presetRows = PRESET_KEYS.map(key => ({ key, ...STOCK_SCREEN_PRESETS[key], lookbackMode: "annual", defaultLookback: 3,
      includeSecondary: false, includeInactive: false }));
    if (args.action === "list") return toolResult({ action: "list", presets: presetRows, methodology: SCREENER_METHOD,
      warnings: ["Preset labels describe disclosed screening rules, not investment advice or a complete assessment of business quality."] });
    if (!args.preset) return { isError: true, content: [{ type: "text" as const, text: "Choose one named preset to run, or use action=list to inspect their exact rules." }] };
    try {
      const preset = STOCK_SCREEN_PRESETS[args.preset];
      const rules = preset.rules.map((entry, index) => ({ ...entry, id: `preset-${index + 1}` }));
      const filter = { rules, lookbackMode: "annual", lookback: args.lookback, sector: args.sector ?? "", industry: args.industry ?? "",
        country: "", countries: [...new Set(args.countries)], includeSecondary: false };
      const params = new URLSearchParams({ includeInactive: "false", limit: String(args.limit), sortBy: preset.sortBy, order: preset.order });
      const raw = await bullrunPost<unknown>(`/api/screener/filter?${params}`, filter, 20_000);
      if (!Array.isArray(raw)) throw new Error("Invalid screener response");
      const rows = raw.slice(0, args.limit).filter((row): row is Record<string, unknown> => row != null && typeof row === "object" && typeof row.ticker === "string").map(project);
      return toolResult({ action: "run", preset: { key: args.preset, label: preset.label, description: preset.description },
        retrievedAt: new Date().toISOString(), query: { ...filter, sortBy: preset.sortBy, order: preset.order, includeInactive: false, limit: args.limit },
        returnedCount: rows.length, results: rows,
        coverage: { evaluatedCount: null, totalMatches: null, backendCandidateCap: 5_000, resultLimit: args.limit,
          resultLimitReached: raw.length >= args.limit, completeUniverse: false },
        continuation: { tool: "screen_stocks", arguments: { ...filter, sortBy: preset.sortBy, order: preset.order, includeInactive: false, limit: args.limit } },
        methodology: SCREENER_METHOD,
        warnings: ["Results are a bounded screen; the backend does not expose total evaluated or matching counts.",
          "The endpoint omits fiscal periods, source timestamps and reporting currencies. Drill into exact tickers with get_financial_history or compare_stocks before comparing monetary figures or reporting periods.",
          ...(raw.length >= args.limit ? ["The output limit was reached; other matching stocks may be omitted."] : []),
          ...(rows.length ? [] : ["No matching rows were returned by this bounded screen. Missing data and coverage constraints can exclude companies."]),
          ...(rows.length < Math.min(raw.length, args.limit) ? ["Malformed rows without a ticker were omitted."] : []),
          "These results do not assess future returns, dividend safety, moat or suitability."],
      });
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "The preset screen could not complete. Narrow the country/sector filters or retry later. No account data was changed." }] };
    }
  });
}
