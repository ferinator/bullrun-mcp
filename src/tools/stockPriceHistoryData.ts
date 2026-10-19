/** Deterministic close-based analysis. Missing sessions are never synthesized. */
export type PriceInterval = "daily" | "weekly" | "monthly";
export type PriceIndicator = "sma" | "ema" | "rsi" | "macd";

export interface DailyPrice {
  ticker: string;
  tradeDate: string;
  closePrice: number;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
}

export interface PriceBar {
  period: string;
  startDate: string;
  endDate: string;
  sourceDailyBars: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nullablePrice = (value: unknown): number | null => positive(value) ? value : null;
export const roundPriceMetric = (value: number): number => Number(value.toFixed(8));

export function normalizeDailyPrices(raw: unknown[], ticker: string): { prices: DailyPrice[]; omittedRows: number; duplicateDates: number } {
  const byDate = new Map<string, DailyPrice>();
  let omittedRows = 0;
  let duplicateDates = 0;
  for (const item of raw) {
    if (item == null || typeof item !== "object") { omittedRows++; continue; }
    const row = item as Record<string, unknown>;
    if (typeof row.ticker !== "string" || row.ticker.toUpperCase() !== ticker || !validCalendarDate(row.tradeDate) || !positive(row.closePrice)) {
      omittedRows++; continue;
    }
    // The API's daily primary key is (ticker, tradeDate). Disclose unexpected duplicates.
    if (byDate.has(row.tradeDate)) { duplicateDates++; continue; }
    byDate.set(row.tradeDate, {
      ticker, tradeDate: row.tradeDate, closePrice: row.closePrice,
      openPrice: nullablePrice(row.openPrice), highPrice: nullablePrice(row.highPrice), lowPrice: nullablePrice(row.lowPrice),
      volume: typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0 ? row.volume : null,
    });
  }
  return { prices: [...byDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)), omittedRows, duplicateDates };
}

function periodKey(date: string, interval: PriceInterval): string {
  if (interval === "daily") return date;
  if (interval === "monthly") return date.slice(0, 7);
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}

export function aggregateDailyPrices(prices: DailyPrice[], interval: PriceInterval): PriceBar[] {
  const groups = new Map<string, DailyPrice[]>();
  for (const row of prices) {
    const key = periodKey(row.tradeDate, interval);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([period, group]) => ({
    period, startDate: group[0].tradeDate, endDate: group.at(-1)!.tradeDate, sourceDailyBars: group.length,
    open: group[0].openPrice, close: group.at(-1)!.closePrice,
    high: group.every(row => row.highPrice != null) ? Math.max(...group.map(row => row.highPrice!)) : null,
    low: group.every(row => row.lowPrice != null) ? Math.min(...group.map(row => row.lowPrice!)) : null,
    volume: group.every(row => row.volume != null) ? group.reduce((sum, row) => sum + row.volume!, 0) : null,
  }));
}

export function smaSeries(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index + 1 >= period ? sum / period : null;
  });
}

/** EMA is seeded with the first period's SMA, alpha = 2/(period+1). */
export function emaSeries(values: number[], period: number): Array<number | null> {
  let previous: number | null = null;
  let seed = 0;
  return values.map((value, index) => {
    if (index < period) seed += value;
    if (index + 1 < period) return null;
    previous = previous == null ? seed / period : value * (2 / (period + 1)) + previous * (1 - 2 / (period + 1));
    return previous;
  });
}

/** Wilder smoothing; flat history is neutral (50), no losses is 100, no gains is 0. */
export function rsiSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    if (index <= period) { gain += Math.max(change, 0) / period; loss += Math.max(-change, 0) / period; }
    else { gain = (gain * (period - 1) + Math.max(change, 0)) / period; loss = (loss * (period - 1) + Math.max(-change, 0)) / period; }
    if (index >= period) out[index] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macdSeries(values: number[]): Array<{ macd: number | null; signal: number | null; histogram: number | null }> {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macd = values.map((_, index) => fast[index] == null || slow[index] == null ? null : fast[index]! - slow[index]!);
  const signal = emaSeries(macd.filter((value): value is number => value != null), 9);
  return macd.map((value, index) => {
    const signalValue = index < 25 ? null : signal[index - 25] ?? null;
    return { macd: value, signal: signalValue, histogram: value == null || signalValue == null ? null : value - signalValue };
  });
}

export function closePerformance(bars: PriceBar[]) {
  const first = bars[0];
  let peak = first?.close ?? 0;
  let maximumDrawdownPct = 0;
  const observations = bars.map((bar, index) => {
    peak = Math.max(peak, bar.close);
    const drawdownPct = (bar.close / peak - 1) * 100;
    maximumDrawdownPct = Math.min(maximumDrawdownPct, drawdownPct);
    return {
      periodReturnPct: index === 0 ? null : roundPriceMetric((bar.close / bars[index - 1].close - 1) * 100),
      cumulativePriceReturnPct: roundPriceMetric((bar.close / first.close - 1) * 100),
      drawdownPct: roundPriceMetric(drawdownPct),
    };
  });
  return {
    observations,
    summary: {
      startClose: first?.close ?? null, endClose: bars.at(-1)?.close ?? null,
      priceReturnPct: bars.length < 2 ? null : roundPriceMetric((bars.at(-1)!.close / first.close - 1) * 100),
      maximumDrawdownPct: bars.length < 2 ? null : roundPriceMetric(maximumDrawdownPct),
    },
  };
}
