import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { identityPayload, resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface Financials {
  ticker: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceCurrency: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  pretaxIncome: number | null;
  taxProvision: number | null;
  netIncome: number | null;
  dilutedEps: number | null;
  dilutedAverageShares: number | null;
  dividendsPerShare: number | null;
  cashAndCashEquivalents: number | null;
  totalAssets: number | null;
  totalDebt: number | null;
  stockholdersEquity: number | null;
  operatingCashflow: number | null;
  capitalExpenditure: number | null;
  freeCashflow: number | null;
}

interface TaxRate {
  value: number | null;
  source: "reported" | "fallback" | "unavailable";
}

interface QualityRow {
  period: string;
  fiscalYear: number | null;
  sourceCurrency: string | null;
  profitability: {
    nopat: number | null;
    investedCapital: number | null;
    effectiveTaxRatePct: number | null;
    taxRateSource: TaxRate["source"];
    roicPct: number | null;
    estimatedWaccPct: number | null;
    roicSpreadVsWaccPct: number | null;
    roePct: number | null;
    roaPct: number | null;
    grossMarginPct: number | null;
    operatingMarginPct: number | null;
    netMarginPct: number | null;
    freeCashflowMarginPct: number | null;
  };
  earningsQuality: {
    accrualsPctOfAssets: number | null;
    operatingCashflowToNetIncome: number | null;
    freeCashflowToNetIncome: number | null;
    freeCashflowToOperatingCashflow: number | null;
  };
  capitalAllocation: {
    capex: number | null;
    capexToRevenuePct: number | null;
    dividendsPerShare: number | null;
    dividendPayoutRatioPct: number | null;
    dividendPerShareGrowthPct: number | null;
    dilutedAverageShares: number | null;
    dilutedShareCountChangePct: number | null;
    buybackProxyShareReductionPct: number | null;
  };
}

type FlagSeverity = "info" | "warning" | "critical";

interface Flag {
  severity: FlagSeverity;
  metric: string;
  message: string;
}

function periodLabel(row: Financials): string {
  if (row.fiscalYear == null) return "unknown";
  return `FY${row.fiscalYear}`;
}

function periodRank(row: Financials): number {
  return (row.fiscalYear ?? 0) * 10 + (row.fiscalQuarter ?? 0);
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return round((numerator / denominator) * 100);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return round(numerator / denominator, 2);
}

function growthPct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100);
}

function average(values: Array<number | null>): number | null {
  const clean = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (clean.length === 0) return null;
  return round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
}

function cagrPct(descRows: QualityRow[], metric: (row: QualityRow) => number | null): number | null {
  const rows = descRows
    .filter((row) => row.fiscalYear != null && metric(row) != null && metric(row)! > 0)
    .slice()
    .sort((a, b) => (a.fiscalYear ?? 0) - (b.fiscalYear ?? 0));
  if (rows.length < 2) return null;

  const first = rows[0];
  const last = rows[rows.length - 1];
  const years = (last.fiscalYear ?? 0) - (first.fiscalYear ?? 0);
  const firstValue = metric(first);
  const lastValue = metric(last);
  if (years <= 0 || firstValue == null || lastValue == null) return null;
  return round((Math.pow(lastValue / firstValue, 1 / years) - 1) * 100);
}

function taxRate(row: Financials, fallbackPct: number | null): TaxRate {
  if (
    row.taxProvision != null &&
    row.pretaxIncome != null &&
    row.pretaxIncome > 0 &&
    row.taxProvision >= 0
  ) {
    const actual = row.taxProvision / row.pretaxIncome;
    if (Number.isFinite(actual) && actual >= 0 && actual <= 0.5) {
      return { value: actual, source: "reported" };
    }
  }

  if (fallbackPct != null && Number.isFinite(fallbackPct)) {
    return { value: fallbackPct / 100, source: "fallback" };
  }
  return { value: null, source: "unavailable" };
}

function investedCapital(row: Financials): number | null {
  if (row.totalDebt == null || row.stockholdersEquity == null) return null;
  const cash = row.cashAndCashEquivalents ?? 0;
  const invested = row.totalDebt + row.stockholdersEquity - cash;
  return Number.isFinite(invested) && invested > 0 ? invested : null;
}

function annualRows(rows: Financials[], years: number): Financials[] {
  const annual = rows
    .filter((row) => row.fiscalQuarter === 0)
    .sort((a, b) => periodRank(b) - periodRank(a));
  const latestYear = Math.max(...annual.map((row) => row.fiscalYear ?? Number.NEGATIVE_INFINITY));
  if (!Number.isFinite(latestYear)) return annual;
  const firstYear = latestYear - years + 1;
  return annual.filter((row) => row.fiscalYear == null || row.fiscalYear >= firstYear);
}

function hasUsefulAnnualData(row: Financials): boolean {
  return [
    row.revenue,
    row.operatingIncome,
    row.netIncome,
    row.operatingCashflow,
    row.freeCashflow,
    row.totalAssets,
    row.totalDebt,
    row.stockholdersEquity,
    row.dilutedAverageShares,
    row.dividendsPerShare,
  ].some((value) => value != null);
}

function toQualityRow(
  row: Financials,
  previousOlder: Financials | null,
  estimatedWaccPct: number | null,
  fallbackTaxRatePct: number | null,
): QualityRow {
  const tax = taxRate(row, fallbackTaxRatePct);
  const invested = investedCapital(row);
  const nopat = row.operatingIncome != null && tax.value != null ? row.operatingIncome * (1 - tax.value) : null;
  const roic = pct(nopat, invested);
  const shareChange = growthPct(row.dilutedAverageShares, previousOlder?.dilutedAverageShares ?? null);
  const dpsGrowth = growthPct(row.dividendsPerShare, previousOlder?.dividendsPerShare ?? null);

  return {
    period: periodLabel(row),
    fiscalYear: row.fiscalYear,
    sourceCurrency: row.sourceCurrency,
    profitability: {
      nopat: round(nopat),
      investedCapital: round(invested),
      effectiveTaxRatePct: tax.value == null ? null : round(tax.value * 100),
      taxRateSource: tax.source,
      roicPct: roic,
      estimatedWaccPct: estimatedWaccPct == null ? null : round(estimatedWaccPct),
      roicSpreadVsWaccPct: roic != null && estimatedWaccPct != null ? round(roic - estimatedWaccPct) : null,
      roePct: pct(row.netIncome, row.stockholdersEquity),
      roaPct: pct(row.netIncome, row.totalAssets),
      grossMarginPct: pct(row.grossProfit, row.revenue),
      operatingMarginPct: pct(row.operatingIncome, row.revenue),
      netMarginPct: pct(row.netIncome, row.revenue),
      freeCashflowMarginPct: pct(row.freeCashflow, row.revenue),
    },
    earningsQuality: {
      accrualsPctOfAssets:
        row.netIncome != null && row.operatingCashflow != null
          ? pct(row.netIncome - row.operatingCashflow, row.totalAssets)
          : null,
      operatingCashflowToNetIncome:
        row.netIncome != null && row.netIncome > 0 ? ratio(row.operatingCashflow, row.netIncome) : null,
      freeCashflowToNetIncome:
        row.netIncome != null && row.netIncome > 0 ? ratio(row.freeCashflow, row.netIncome) : null,
      freeCashflowToOperatingCashflow:
        row.operatingCashflow != null && row.operatingCashflow > 0 ? ratio(row.freeCashflow, row.operatingCashflow) : null,
    },
    capitalAllocation: {
      capex: round(row.capitalExpenditure),
      capexToRevenuePct: pct(row.capitalExpenditure == null ? null : Math.abs(row.capitalExpenditure), row.revenue),
      dividendsPerShare: row.dividendsPerShare,
      dividendPayoutRatioPct:
        row.dividendsPerShare != null && row.dilutedEps != null && row.dilutedEps > 0
          ? pct(row.dividendsPerShare, row.dilutedEps)
          : null,
      dividendPerShareGrowthPct: dpsGrowth,
      dilutedAverageShares: row.dilutedAverageShares,
      dilutedShareCountChangePct: shareChange,
      buybackProxyShareReductionPct: shareChange != null && shareChange < 0 ? round(Math.abs(shareChange)) : null,
    },
  };
}

function buildFlags(latest: QualityRow | null): Flag[] {
  if (!latest) return [];
  const flags: Flag[] = [];
  const roic = latest.profitability.roicPct;
  const spread = latest.profitability.roicSpreadVsWaccPct;
  const accruals = latest.earningsQuality.accrualsPctOfAssets;
  const cashConversion = latest.earningsQuality.operatingCashflowToNetIncome;
  const shareChange = latest.capitalAllocation.dilutedShareCountChangePct;

  if (roic != null && roic < 0) {
    flags.push({ severity: "critical", metric: "roicPct", message: "Latest ROIC is negative." });
  } else if (spread != null && spread < 0) {
    flags.push({ severity: "warning", metric: "roicSpreadVsWaccPct", message: "Latest ROIC is below the supplied WACC assumption." });
  } else if (spread != null && spread >= 5) {
    flags.push({ severity: "info", metric: "roicSpreadVsWaccPct", message: "Latest ROIC is at least 5 percentage points above the supplied WACC assumption." });
  }

  if (accruals != null && accruals > 10) {
    flags.push({ severity: "warning", metric: "accrualsPctOfAssets", message: "Accruals exceed 10% of assets, a common earnings-quality caution flag." });
  }
  if (cashConversion != null && cashConversion < 0.8) {
    flags.push({ severity: "warning", metric: "operatingCashflowToNetIncome", message: "Operating cash flow is below 80% of net income." });
  }
  if (shareChange != null && shareChange > 5) {
    flags.push({ severity: "warning", metric: "dilutedShareCountChangePct", message: "Diluted average shares rose more than 5% year over year." });
  }
  if (shareChange != null && shareChange < -2) {
    flags.push({ severity: "info", metric: "buybackProxyShareReductionPct", message: "Diluted average shares fell more than 2%, a buyback-like proxy signal." });
  }
  return flags;
}

function sourceCurrencies(rows: QualityRow[]): string[] {
  return [...new Set(rows.map((row) => row.sourceCurrency).filter((currency): currency is string => !!currency))].sort();
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("The Bullrun ticker. " + TICKER_CONVENTION),
  years: z.number().int().min(2).max(15).default(10)
    .describe("How many fiscal years of annual history to evaluate."),
  estimatedWaccPct: z.number().min(0).max(50).optional()
    .describe("Optional user-supplied WACC assumption, in percent. When omitted, ROIC-vs-WACC spread is returned as null."),
  taxRateFallbackPct: z.number().min(0).max(50).default(21)
    .describe("Fallback tax rate used for NOPAT only when reported tax/pretax data is missing or unusable."),
};

export function registerGetQualityMoatMetrics(server: McpServer): void {
  server.registerTool(
    "get_quality_moat_metrics",
    {
      title: "Get quality and moat metrics",
      annotations: { readOnlyHint: true },
      description:
        "Compute annual quality, moat, earnings-quality, and capital-allocation metrics for one exact Bullrun ticker from existing financial statements: ROIC, ROE/ROA, ROIC-vs-supplied-WACC, accruals, cash conversion, capex intensity, dividend payout/growth, diluted share-count changes, and a buyback proxy. Read-only.",
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

        const rows = annualRows(rawRows.filter(hasUsefulAnnualData), args.years);
        const history = rows.map((row, i) =>
          toQualityRow(
            row,
            rows[i + 1] ?? null,
            args.estimatedWaccPct ?? null,
            args.taxRateFallbackPct,
          ));
        const latest = history[0] ?? null;

        const warnings: string[] = [];
        if (!stock) warnings.push("No exact stock identity row was found; statement rows are still keyed by the requested ticker.");
        if (history.length === 0) warnings.push("No usable annual financial rows found in the requested window.");
        if (args.estimatedWaccPct == null) warnings.push("WACC is not estimated from the database. Pass estimatedWaccPct to compute ROIC spread against your own WACC assumption.");
        warnings.push("Buybacks are approximated from diluted average share-count changes; cash spent on repurchases is not stored in the current schema.");
        warnings.push("M&A cash-flow history, auditor changes, insider transactions, and congressional-trading transactions are not stored in the current MCP/API data contract.");
        warnings.push("Restatement version history is not exposed here. EDGAR ingestion deduplicates amended facts to latest filed values, but the current financials endpoint does not return accession-level fact versions.");

        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(stock),
          coverage: {
            requestedYears: args.years,
            annualRows: history.length,
            latestFiscalYear: latest?.fiscalYear ?? null,
            sourceCurrencies: sourceCurrencies(history),
            estimatedWaccPct: args.estimatedWaccPct ?? null,
            taxRateFallbackPct: args.taxRateFallbackPct,
          },
          summary: {
            latestRoicPct: latest?.profitability.roicPct ?? null,
            latestRoicSpreadVsWaccPct: latest?.profitability.roicSpreadVsWaccPct ?? null,
            averageRoicPct: average(history.map((row) => row.profitability.roicPct)),
            averageAccrualsPctOfAssets: average(history.map((row) => row.earningsQuality.accrualsPctOfAssets)),
            latestCashConversion: latest?.earningsQuality.operatingCashflowToNetIncome ?? null,
            latestCapexToRevenuePct: latest?.capitalAllocation.capexToRevenuePct ?? null,
            latestDilutedShareCountChangePct: latest?.capitalAllocation.dilutedShareCountChangePct ?? null,
            dividendPerShareCagrPct: cagrPct(history, (row) => row.capitalAllocation.dividendsPerShare),
            yearsRoicAboveWacc:
              args.estimatedWaccPct == null
                ? null
                : history.filter((row) => (row.profitability.roicSpreadVsWaccPct ?? Number.NEGATIVE_INFINITY) > 0).length,
          },
          flags: buildFlags(latest),
          history,
          warnings,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_quality_moat_metrics failed: ${msg}` }] };
      }
    },
  );
}
