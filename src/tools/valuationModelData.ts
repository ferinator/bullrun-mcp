/**
 * Bullrun's own ML models, as served by bullrun-api's `/api/ml-scores` endpoints.
 *
 * - valuation / valuation_ps: LightGBM predicts the multiple (P/E, or P/S for loss-makers)
 *   a stock's fundamentals typically command one year out; the published signal is
 *   `fair multiple / current multiple - 1`. Positive = trades below its model-typical
 *   multiple. Descriptive context, not a return forecast (walk-forward signal->return IC
 *   is ~0 for both).
 * - forecast: predicts the stock's cross-sectional percentile rank of forward 1-year
 *   return; the published signal is `predicted rank - 0.5`, a bounded relative edge, never
 *   an expected-return percentage.
 *
 * Quarterly keys use the quarterly financial panel; `_annual_1y` keys use annual filings,
 * which is the only panel most non-US companies have.
 */

export interface MlScore {
  ticker: string;
  company: string | null;
  sector: string | null;
  exchange: string | null;
  country: string | null;
  currency: string | null;
  predicted: number | null;
  percentile: number | null;
  rank: number | null;
  asOfDate: string | null;
  horizonQ: number | null;
  nPeriods?: number | null;
  currentMultiple: number | null;
  marketCap: number | null;
  financialDate: string | null;
  dataQuality: string | null;
  fiscalPeriod: string | null;
}

export const MODEL_KEYS = [
  "valuation",
  "valuation_annual_1y",
  "valuation_ps",
  "valuation_ps_annual_1y",
  "forecast",
  "forecast_annual_1y",
] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

export const MODEL_INFO: Record<ModelKey, { family: "valuation" | "forecast"; multiple: "P/E" | "P/S" | null; panel: "quarterly" | "annual"; label: string }> = {
  valuation: { family: "valuation", multiple: "P/E", panel: "quarterly", label: "Valuation (P/E, quarterly financials)" },
  valuation_annual_1y: { family: "valuation", multiple: "P/E", panel: "annual", label: "Valuation (P/E, annual financials)" },
  valuation_ps: { family: "valuation", multiple: "P/S", panel: "quarterly", label: "Valuation (price/sales, quarterly financials)" },
  valuation_ps_annual_1y: { family: "valuation", multiple: "P/S", panel: "annual", label: "Valuation (price/sales, annual financials)" },
  forecast: { family: "forecast", multiple: null, panel: "quarterly", label: "Forecast (relative 1-year signal, quarterly financials)" },
  forecast_annual_1y: { family: "forecast", multiple: null, panel: "annual", label: "Forecast (relative 1-year signal, annual financials)" },
};

export const VALUATION_CAVEAT =
  "Valuation gap = model-typical multiple / current multiple - 1, comparing the stock with companies of similar fundamentals " +
  "(margins, returns on equity, growth trajectory, size, momentum and the macro backdrop). Positive = trades below its typical multiple. It describes how the " +
  "stock is priced relative to peers; in walk-forward tests it has not predicted forward returns, so it is context, not a buy signal.";

export const FORECAST_CAVEAT =
  "Forecast = predicted cross-sectional rank of 1-year forward return minus 0.5 (range about -0.5..+0.5). A relative ranking " +
  "signal within the scored universe, not an expected return or price target.";

const pct = (v: number | null | undefined, digits = 1): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 100 * 10 ** digits) / 10 ** digits;

function valuationReading(gapPct: number | null, multiple: string): string | null {
  if (gapPct == null) return null;
  if (gapPct >= 20) return `trades well below the ${multiple} its fundamentals typically command`;
  if (gapPct >= 5) return `trades modestly below its model-typical ${multiple}`;
  if (gapPct > -5) return `trades close to its model-typical ${multiple}`;
  if (gapPct > -20) return `trades modestly above its model-typical ${multiple}`;
  return `trades well above the ${multiple} its fundamentals typically command`;
}

function forecastReading(percentile: number | null): string | null {
  if (percentile == null) return null;
  if (percentile >= 90) return "top decile of the scored universe";
  if (percentile >= 75) return "top quartile";
  if (percentile > 25) return "middle of the pack";
  if (percentile > 10) return "bottom quartile";
  return "bottom decile";
}

/** One model reading, interpreted. */
export function interpretScore(key: ModelKey, s: MlScore): Record<string, unknown> {
  const info = MODEL_INFO[key];
  const percentile = pct(s.percentile);
  const common = {
    model: key,
    label: info.label,
    percentile,
    rank: s.rank,
    asOfDate: s.asOfDate,
    horizon: s.horizonQ != null ? `${s.horizonQ} quarters` : null,
    financialsThrough: s.fiscalPeriod,
    periodsOfHistory: s.nPeriods ?? null,
    dataQuality: s.dataQuality,
  };
  if (info.family === "forecast") {
    return {
      ...common,
      relativeEdge: s.predicted != null ? Math.round(s.predicted * 1000) / 1000 : null,
      reading: forecastReading(percentile),
    };
  }
  const gapPct = pct(s.predicted);
  // currentMultiple is the stored trailing P/E, so a fair multiple can only be derived for
  // the P/E models, and only inside the band the scorer itself accepts.
  const pe = s.currentMultiple;
  const peUsable = info.multiple === "P/E" && pe != null && pe >= 3 && pe <= 150 && s.predicted != null;
  return {
    ...common,
    multiple: info.multiple,
    valuationGapPct: gapPct,
    reading: valuationReading(gapPct, info.multiple ?? "multiple"),
    ...(peUsable
      ? { currentPe: Math.round(pe * 100) / 100, modelTypicalPe: Math.round(pe * (1 + (s.predicted as number)) * 100) / 100 }
      : {}),
  };
}
