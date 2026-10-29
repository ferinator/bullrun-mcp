import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { identityPayload, resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText, tidy } from "./stockIdentity.js";
import { reportedEbitdaWarnings } from "./financialQuality.js";

interface Financials {
  ticker: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceCurrency: string | null;
  reportingScale: number | null;
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  researchAndDevelopment: number | null;
  sellingGeneralAndAdmin: number | null;
  operatingExpense: number | null;
  operatingIncome: number | null;
  ebit: number | null;
  ebitda: number | null;
  interestExpense: number | null;
  pretaxIncome: number | null;
  taxProvision: number | null;
  netIncome: number | null;
  basicEps: number | null;
  dilutedEps: number | null;
  basicAverageShares: number | null;
  dilutedAverageShares: number | null;
  totalCost: number | null;
  dividendsPerShare: number | null;
  cashAndCashEquivalents: number | null;
  shortTermInvestments: number | null;
  totalCurrentAssets: number | null;
  totalAssets: number | null;
  totalCurrentLiabilities: number | null;
  totalLiabilities: number | null;
  shortTermDebt: number | null;
  longTermDebt: number | null;
  totalDebt: number | null;
  stockholdersEquity: number | null;
  retainedEarnings: number | null;
  operatingCashflow: number | null;
  capitalExpenditure: number | null;
  freeCashflow: number | null;
  depreciationAndAmortization: number | null;
  dividendYieldPct: number | null;
}

interface HistoryRow {
  period: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceCurrency: string | null;
  reportingScale: number | null;
  incomeStatement: {
    revenue: number | null;
    costOfRevenue: number | null;
    grossProfit: number | null;
    researchAndDevelopment: number | null;
    sellingGeneralAndAdmin: number | null;
    operatingExpense: number | null;
    operatingIncome: number | null;
    ebit: number | null;
    ebitda: number | null;
    interestExpense: number | null;
    pretaxIncome: number | null;
    taxProvision: number | null;
    netIncome: number | null;
  };
  balanceSheet: {
    cashAndCashEquivalents: number | null;
    shortTermInvestments: number | null;
    totalCurrentAssets: number | null;
    totalAssets: number | null;
    totalCurrentLiabilities: number | null;
    totalLiabilities: number | null;
    shortTermDebt: number | null;
    longTermDebt: number | null;
    totalDebt: number | null;
    stockholdersEquity: number | null;
    retainedEarnings: number | null;
  };
  cashFlow: {
    operatingCashflow: number | null;
    capitalExpenditure: number | null;
    freeCashflow: number | null;
    depreciationAndAmortization: number | null;
  };
  perShare: {
    basicEps: number | null;
    dilutedEps: number | null;
    basicAverageShares: number | null;
    dilutedAverageShares: number | null;
    dividendsPerShare: number | null;
    dividendYieldPct: number | null;
  };
  margins: {
    grossMarginPct: number | null;
    operatingMarginPct: number | null;
    netMarginPct: number | null;
    freeCashflowMarginPct: number | null;
  };
}

type PeriodType = "annual" | "quarterly" | "both";

function periodLabel(fy: number | null, fq: number | null): string {
  if (fy == null) return "unknown";
  if (fq == null || fq === 0) return `FY${fy}`;
  return `FY${fy} Q${fq}`;
}

function periodRank(row: Financials | HistoryRow): number {
  return (row.fiscalYear ?? 0) * 10 + (row.fiscalQuarter ?? 0);
}

function round2(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return round2((numerator / denominator) * 100);
}

function yoy(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

function cagr(points: HistoryRow[], metric: (row: HistoryRow) => number | null): number | null {
  const usable = points
    .filter((row) => row.fiscalYear != null && metric(row) != null && metric(row)! > 0)
    .sort((a, b) => (a.fiscalYear ?? 0) - (b.fiscalYear ?? 0));
  if (usable.length < 2) return null;

  const first = usable[0];
  const last = usable[usable.length - 1];
  const years = (last.fiscalYear ?? 0) - (first.fiscalYear ?? 0);
  const firstValue = metric(first);
  const lastValue = metric(last);
  if (years <= 0 || firstValue == null || lastValue == null) return null;
  return round2((Math.pow(lastValue / firstValue, 1 / years) - 1) * 100);
}

function hasFinancialData(row: Financials): boolean {
  return [
    row.revenue,
    row.grossProfit,
    row.operatingIncome,
    row.netIncome,
    row.operatingCashflow,
    row.freeCashflow,
    row.totalAssets,
    row.totalDebt,
    row.stockholdersEquity,
    row.dilutedEps,
  ].some((value) => value != null);
}

function filterYears(rows: Financials[], years: number): Financials[] {
  const latestYear = Math.max(...rows.map((row) => row.fiscalYear ?? Number.NEGATIVE_INFINITY));
  if (!Number.isFinite(latestYear)) return rows;
  const firstYear = latestYear - years + 1;
  return rows.filter((row) => row.fiscalYear == null || row.fiscalYear >= firstYear);
}

function toHistoryRow(row: Financials): HistoryRow {
  return {
    period: periodLabel(row.fiscalYear, row.fiscalQuarter),
    fiscalYear: row.fiscalYear,
    fiscalQuarter: row.fiscalQuarter,
    sourceCurrency: row.sourceCurrency,
    reportingScale: row.reportingScale,
    incomeStatement: {
      revenue: row.revenue,
      costOfRevenue: row.costOfRevenue,
      grossProfit: row.grossProfit,
      researchAndDevelopment: row.researchAndDevelopment,
      sellingGeneralAndAdmin: row.sellingGeneralAndAdmin,
      operatingExpense: row.operatingExpense,
      operatingIncome: row.operatingIncome,
      ebit: row.ebit,
      ebitda: row.ebitda,
      interestExpense: row.interestExpense,
      pretaxIncome: row.pretaxIncome,
      taxProvision: row.taxProvision,
      netIncome: row.netIncome,
    },
    balanceSheet: {
      cashAndCashEquivalents: row.cashAndCashEquivalents,
      shortTermInvestments: row.shortTermInvestments,
      totalCurrentAssets: row.totalCurrentAssets,
      totalAssets: row.totalAssets,
      totalCurrentLiabilities: row.totalCurrentLiabilities,
      totalLiabilities: row.totalLiabilities,
      shortTermDebt: row.shortTermDebt,
      longTermDebt: row.longTermDebt,
      totalDebt: row.totalDebt,
      stockholdersEquity: row.stockholdersEquity,
      retainedEarnings: row.retainedEarnings,
    },
    cashFlow: {
      operatingCashflow: row.operatingCashflow,
      capitalExpenditure: row.capitalExpenditure,
      freeCashflow: row.freeCashflow,
      depreciationAndAmortization: row.depreciationAndAmortization,
    },
    perShare: {
      basicEps: tidy(row.basicEps),
      dilutedEps: tidy(row.dilutedEps),
      basicAverageShares: row.basicAverageShares,
      dilutedAverageShares: row.dilutedAverageShares,
      dividendsPerShare: tidy(row.dividendsPerShare),
      dividendYieldPct: tidy(row.dividendYieldPct, 5),
    },
    margins: {
      grossMarginPct: pct(row.grossProfit, row.revenue),
      operatingMarginPct: pct(row.operatingIncome, row.revenue),
      netMarginPct: pct(row.netIncome, row.revenue),
      freeCashflowMarginPct: pct(row.freeCashflow, row.revenue),
    },
  };
}

function annualGrowth(annualRows: HistoryRow[]): Record<string, unknown>[] {
  const chronological = annualRows
    .slice()
    .sort((a, b) => (a.fiscalYear ?? 0) - (b.fiscalYear ?? 0));

  const out: Record<string, unknown>[] = [];
  for (let i = 1; i < chronological.length; i += 1) {
    const current = chronological[i];
    const previous = chronological[i - 1];
    const revenueGrowthPct = yoy(current.incomeStatement.revenue, previous.incomeStatement.revenue);
    const netIncomeGrowthPct = yoy(current.incomeStatement.netIncome, previous.incomeStatement.netIncome);
    out.push({
      fiscalYear: current.fiscalYear,
      revenueGrowthPct,
      netIncomeGrowthPct,
      revenueAtLeast10Pct: revenueGrowthPct == null ? null : revenueGrowthPct >= 10,
      netIncomeAtLeast10Pct: netIncomeGrowthPct == null ? null : netIncomeGrowthPct >= 10,
      bothAtLeast10Pct:
        revenueGrowthPct == null || netIncomeGrowthPct == null
          ? null
          : revenueGrowthPct >= 10 && netIncomeGrowthPct >= 10,
    });
  }
  return out.sort((a, b) => Number(b.fiscalYear ?? 0) - Number(a.fiscalYear ?? 0));
}

function countTrue(rows: Record<string, unknown>[], key: string): number {
  return rows.filter((row) => row[key] === true).length;
}

function growthSummary(annualRows: HistoryRow[]): Record<string, unknown> {
  const growth = annualGrowth(annualRows);
  const comparableYears = growth.filter((row) => row.revenueGrowthPct != null || row.netIncomeGrowthPct != null).length;
  return {
    annualGrowth: growth,
    comparableAnnualPeriods: comparableYears,
    revenueCagrPct: cagr(annualRows, (row) => row.incomeStatement.revenue),
    netIncomeCagrPct: cagr(annualRows, (row) => row.incomeStatement.netIncome),
    yearsRevenueAtLeast10Pct: countTrue(growth, "revenueAtLeast10Pct"),
    yearsNetIncomeAtLeast10Pct: countTrue(growth, "netIncomeAtLeast10Pct"),
    yearsBothAtLeast10Pct: countTrue(growth, "bothAtLeast10Pct"),
    allComparableYearsBothAtLeast10Pct:
      comparableYears > 0 && growth.every((row) => row.bothAtLeast10Pct === true || row.bothAtLeast10Pct == null),
  };
}

function latestFiscalYear(rows: Financials[]): number | null {
  const years = rows.map((row) => row.fiscalYear).filter((year): year is number => year != null);
  return years.length > 0 ? Math.max(...years) : null;
}

function sourceCurrencies(rows: HistoryRow[]): string[] {
  return [...new Set(rows.map((row) => row.sourceCurrency).filter((currency): currency is string => !!currency))].sort();
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("The Bullrun ticker. " + TICKER_CONVENTION),
  periodType: z.enum(["annual", "quarterly", "both"]).default("annual")
    .describe("Defaults to annual statements with a growth summary. Choose quarterly or both for detailed period research. Annual rows use fiscalQuarter=0."),
  years: z.number().int().min(1).max(15).default(5)
    .describe("Fiscal-year window counting backward from the latest available fiscal year. Default 5; request up to 15 for longer research."),
  includeEmptyRows: z.boolean().default(false)
    .describe("Include sparse rows that have no major income statement, balance sheet, cash-flow, or EPS values."),
};

export function registerGetFinancialHistory(server: McpServer): void {
  server.registerTool(
    "get_financial_history",
    {
      title: "Get financial history",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Read historical financial statements for one exact Bullrun ticker, with growth/CAGR consistency checks first, then income, balance sheet, cash flow, per-share metrics, margins and source currency. Defaults to a five-fiscal-year window of annual rows; request years=1-15 and periodType=quarterly or both for more detail. Use for growth consistency, margins, leverage and cash-flow quality; read the period/currency coverage before comparing.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) {
          return { content: [{ type: "text" as const, text: tickerNotFoundText(args.ticker, resolution) }] };
        }
        const ticker = resolution.ticker;
        if (!ticker) {
          return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        }

        const enc = encodeURIComponent(ticker);
        const [stock, rawRows] = await Promise.all([
          Promise.resolve(resolution.stock),
          bullrunGet<Financials[]>(`/api/financials/${enc}`),
        ]);

        const periodType = args.periodType as PeriodType;
        const usableRows = args.includeEmptyRows ? rawRows : rawRows.filter(hasFinancialData);
        const scopedRows = filterYears(usableRows, args.years);
        const annual = scopedRows
          .filter((row) => row.fiscalQuarter === 0)
          .map(toHistoryRow)
          .sort((a, b) => periodRank(b) - periodRank(a));
        const quarterly = scopedRows
          .filter((row) => row.fiscalQuarter != null && row.fiscalQuarter >= 1 && row.fiscalQuarter <= 4)
          .map(toHistoryRow)
          .sort((a, b) => periodRank(b) - periodRank(a));

        const selectedRows =
          periodType === "annual" ? annual : periodType === "quarterly" ? quarterly : [...annual, ...quarterly];
        const warnings: string[] = [];
        if (!stock) warnings.push("No exact stock identity row was found; statement rows are still keyed by the requested ticker.");
        if (annual.length === 0 && periodType !== "quarterly") warnings.push("No annual financial rows found in the requested window.");
        if (quarterly.length === 0 && periodType !== "annual") warnings.push("No quarterly financial rows found in the requested window.");
        warnings.push(...reportedEbitdaWarnings(selectedRows.map(row => ({
          period: row.period,
          ebit: row.incomeStatement.ebit,
          ebitda: row.incomeStatement.ebitda,
          depreciationAndAmortization: row.cashFlow.depreciationAndAmortization,
        }))));

        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(stock),
          coverage: {
            requestedYears: args.years,
            requestedPeriodType: periodType,
            latestFiscalYear: latestFiscalYear(rawRows),
            annualRows: annual.length,
            quarterlyRows: quarterly.length,
            returnedRows: selectedRows.length,
            sourceCurrencies: sourceCurrencies(selectedRows),
            annualRowsMayIncludeRollups: true,
          },
          summary: growthSummary(annual),
          methodology: {
            window: "Fiscal years are counted backward from the latest stored usable fiscal year; missing periods are not filled.",
            growth: "Growth compares adjacent stored annual rows, which may span missing years. CAGR uses positive stored annual values and elapsed fiscal years; neither normalizes currency changes.",
            statements: "Annual rows may include stored rollups. Read sourceCurrency and reportingScale on each row; reporting periods are not publication or collection dates.",
            detail: "Default: five fiscal years of annual rows. Set years and periodType explicitly for longer or quarterly research.",
          },
          annual: periodType === "quarterly" ? undefined : annual,
          quarterly: periodType === "annual" ? undefined : quarterly,
          warnings,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_financial_history failed: ${msg}` }] };
      }
    },
  );
}
