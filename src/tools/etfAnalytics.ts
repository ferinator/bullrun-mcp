import type { EtfPrice } from "./etfData.js";

export interface DatedReturn {
  date: string;
  value: number;
}

export interface PriceRiskMetrics {
  observations: number;
  startDate: string | null;
  endDate: string | null;
  priceReturnPct: number | null;
  annualizedReturnPct: number | null;
  volatilityAnnualizedPct: number | null;
  downsideVolatilityAnnualizedPct: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  historicalVar95Pct: number | null;
}

export function roundMetric(value: number | null, digits = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

export function pricesAscending(
  rows: EtfPrice[] | null,
  startDate?: string,
  endDate?: string,
): EtfPrice[] {
  return [...(rows ?? [])]
    .filter((row) => (!startDate || row.tradeDate >= startDate) && (!endDate || row.tradeDate <= endDate))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/** Days a window's start may sit before its target date: the screener's 1y anchor grace. */
const ANCHOR_GRACE_DAYS = 45;

function isoDaysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The bars of a `days`-long window ending at the newest close, starting at the last
 * close on or before newest - `days` -- the anchor rule of the screener's return_1y_pct
 * and the fund page, so "one year" means the same window everywhere. When history
 * does not reach back that far (a younger listing, or a gap longer than the grace),
 * only the bars inside the window are returned, with complete=false. `rows` must be
 * ascending.
 */
export function anchoredWindow(rows: EtfPrice[], days: number): { rows: EtfPrice[]; complete: boolean } {
  const usable = rows.filter((row) => row.closePrice != null && row.closePrice > 0);
  const newest = usable.at(-1);
  if (!newest) return { rows: [], complete: false };
  const target = isoDaysBefore(newest.tradeDate, days);
  const floor = isoDaysBefore(target, ANCHOR_GRACE_DAYS);
  for (let i = usable.length - 1; i >= 0; i--) {
    if (usable[i].tradeDate > target) continue;
    return usable[i].tradeDate >= floor
      ? { rows: usable.slice(i), complete: true }
      : { rows: usable.slice(i + 1), complete: false };
  }
  return { rows: usable, complete: false };
}

export function closeReturns(rows: EtfPrice[]): DatedReturn[] {
  const out: DatedReturn[] = [];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1].closePrice;
    const current = rows[i].closePrice;
    if (previous == null || current == null || previous <= 0) continue;
    const value = current / previous - 1;
    if (Number.isFinite(value)) out.push({ date: rows[i].tradeDate, value });
  }
  return out;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  if (average == null) return null;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

export function calculatePriceRisk(rows: EtfPrice[], riskFreeRatePct = 0): PriceRiskMetrics {
  const usable = rows.filter((row) => row.closePrice != null && row.closePrice > 0);
  const returns = closeReturns(usable).map((row) => row.value);
  const first = usable[0] ?? null;
  const last = usable.at(-1) ?? null;
  const priceReturn = first?.closePrice && last?.closePrice
    ? last.closePrice / first.closePrice - 1
    : null;
  const elapsedDays = first && last
    ? Math.max(1, (Date.parse(last.tradeDate) - Date.parse(first.tradeDate)) / 86_400_000)
    : null;
  const annualizedReturn = priceReturn != null && elapsedDays != null && 1 + priceReturn > 0
    ? (1 + priceReturn) ** (365.25 / elapsedDays) - 1
    : null;
  const dailyStdDev = sampleStdDev(returns);
  const volatility = dailyStdDev == null ? null : dailyStdDev * Math.sqrt(252);
  const downsideDeviationDaily = returns.length
    ? Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length)
    : null;
  const downsideVolatility = downsideDeviationDaily == null ? null : downsideDeviationDaily * Math.sqrt(252);
  const riskFree = riskFreeRatePct / 100;

  let peak = -Infinity;
  let peakDate: string | null = null;
  let maxDrawdown = 0;
  let maxPeakDate: string | null = null;
  let maxTroughDate: string | null = null;
  for (const row of usable) {
    const close = row.closePrice as number;
    if (close > peak) {
      peak = close;
      peakDate = row.tradeDate;
    }
    const drawdown = peak > 0 ? close / peak - 1 : 0;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      maxPeakDate = peakDate;
      maxTroughDate = row.tradeDate;
    }
  }

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const varIndex = sortedReturns.length ? Math.floor((sortedReturns.length - 1) * 0.05) : -1;
  const var95 = varIndex >= 0 ? Math.max(0, -sortedReturns[varIndex]) : null;
  const sharpe = annualizedReturn != null && volatility && volatility > 0
    ? (annualizedReturn - riskFree) / volatility
    : null;
  const sortino = annualizedReturn != null && downsideVolatility && downsideVolatility > 0
    ? (annualizedReturn - riskFree) / downsideVolatility
    : null;
  const calmar = annualizedReturn != null && maxDrawdown < 0
    ? (annualizedReturn - riskFree) / Math.abs(maxDrawdown)
    : null;

  return {
    observations: returns.length,
    startDate: first?.tradeDate ?? null,
    endDate: last?.tradeDate ?? null,
    priceReturnPct: roundMetric(priceReturn == null ? null : priceReturn * 100),
    annualizedReturnPct: roundMetric(annualizedReturn == null ? null : annualizedReturn * 100),
    volatilityAnnualizedPct: roundMetric(volatility == null ? null : volatility * 100),
    downsideVolatilityAnnualizedPct: roundMetric(downsideVolatility == null ? null : downsideVolatility * 100),
    maxDrawdownPct: roundMetric(maxDrawdown * 100),
    maxDrawdownPeakDate: maxPeakDate,
    maxDrawdownTroughDate: maxTroughDate,
    sharpeRatio: roundMetric(sharpe),
    sortinoRatio: roundMetric(sortino),
    calmarRatio: roundMetric(calmar),
    historicalVar95Pct: roundMetric(var95 == null ? null : var95 * 100),
  };
}

export function benchmarkRisk(
  fundRows: EtfPrice[],
  benchmarkRows: EtfPrice[],
): Record<string, unknown> | null {
  const fundReturns = new Map(closeReturns(fundRows).map((row) => [row.date, row.value]));
  const benchmarkReturns = new Map(closeReturns(benchmarkRows).map((row) => [row.date, row.value]));
  const pairs = [...fundReturns.entries()]
    .filter(([date]) => benchmarkReturns.has(date))
    .map(([date, fund]) => ({ fund, benchmark: benchmarkReturns.get(date) as number }));
  if (pairs.length < 2) return null;

  const fundValues = pairs.map((pair) => pair.fund);
  const benchmarkValues = pairs.map((pair) => pair.benchmark);
  const fundMean = mean(fundValues) as number;
  const benchmarkMean = mean(benchmarkValues) as number;
  const covariance = pairs.reduce(
    (sum, pair) => sum + (pair.fund - fundMean) * (pair.benchmark - benchmarkMean),
    0,
  ) / (pairs.length - 1);
  const benchmarkVariance = benchmarkValues.reduce(
    (sum, value) => sum + (value - benchmarkMean) ** 2,
    0,
  ) / (pairs.length - 1);
  const fundStdDev = sampleStdDev(fundValues);
  const benchmarkStdDev = sampleStdDev(benchmarkValues);
  const active = pairs.map((pair) => pair.fund - pair.benchmark);
  const trackingErrorDaily = sampleStdDev(active);
  const trackingError = trackingErrorDaily == null ? null : trackingErrorDaily * Math.sqrt(252);
  const activeAnnualized = (fundMean - benchmarkMean) * 252;

  return {
    observations: pairs.length,
    correlation: roundMetric(fundStdDev && benchmarkStdDev
      ? covariance / (fundStdDev * benchmarkStdDev)
      : null),
    beta: roundMetric(benchmarkVariance > 0 ? covariance / benchmarkVariance : null),
    trackingErrorAnnualizedPct: roundMetric(trackingError == null ? null : trackingError * 100),
    activeReturnAnnualizedPct: roundMetric(activeAnnualized * 100),
    informationRatio: roundMetric(trackingError && trackingError > 0 ? activeAnnualized / trackingError : null),
  };
}

export function priceLimitForDays(days: number): number {
  return Math.min(1300, Math.max(30, Math.ceil(days * 0.75) + 15));
}
