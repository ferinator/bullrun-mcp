/**
 * Shared vocabulary and response shapes for the company-risk tools. The dial and board
 * payloads come straight from bullrun-api's `/api/company-intelligence/*` endpoints; these
 * helpers only compact them for an LLM and keep the band wording next to every score, so a
 * client never renders "Acute" without the clause that bounds what Acute claims.
 */

export const RISK_MECHANISMS = [
  "MARKET",
  "OPERATING",
  "CASH_CONVERSION",
  "LEVERAGE",
  "COMPETITIVE",
  "CONCENTRATION",
] as const;

export const RISK_BANDS = ["CONTAINED", "NORMAL", "ELEVATED", "STRETCHED", "ACUTE"] as const;

/** What each band says, and what it never says (mirrors bullrun-api's RiskBand javadoc). */
export const BAND_SCALE: Record<(typeof RISK_BANDS)[number], { range: string; means: string; neverMeans: string }> = {
  CONTAINED: { range: "0-19", means: "slack in every measured input", neverMeans: "that this is a good buy" },
  NORMAL: { range: "20-39", means: "readings sit where most of the sector sits", neverMeans: "that nothing undisclosed is wrong" },
  ELEVATED: { range: "40-59", means: "at least one input has moved against the company", neverMeans: "that the move continues" },
  STRETCHED: { range: "60-79", means: "several inputs deteriorating together", neverMeans: "that distress is likely" },
  ACUTE: { range: "80-100", means: "the measured mechanism is at or past its historical limit", neverMeans: "that the market has not priced it" },
};

export const RISK_METHOD_NOTE =
  "Risk dials are 0-100 readings of six measured mechanisms (higher = more strain), computed nightly from filings, " +
  "disclosed relationships and market data. The composite weights the categories by business model. A band describes " +
  "the reading, never a buy/sell view; a dark dial (state NO_READING) means unmeasured, not safe.";

export interface RiskTerm {
  key: string;
  rawValue: number | null;
  mappedScore: number | null;
  weight: number | null;
  periodKey: string | null;
  sourceTable: string | null;
  excludedWhy: string | null;
  measurementClass?: string | null;
  estimateBasis?: string | null;
}

export interface RiskReading {
  riskClass: string;
  state: string;
  score: number | null;
  displayScore: number | null;
  band: string | null;
  bandLabel: string | null;
  direction: string | null;
  priorScore: number | null;
  observedScore?: number | null;
  observationCoverage?: number | null;
  shrinkageWeight?: number | null;
  shrunkToward?: number | null;
  inputsAvailable: number | null;
  inputsRequired: number | null;
  driverMetricKey: string | null;
  driverValue: number | null;
  weightProfile: string | null;
  peerGroupLabel?: string | null;
  percentileInPeers?: number | null;
  explanation: string | null;
  waitingOn: string | null;
  terms?: RiskTerm[] | null;
}

export interface RiskDial {
  key: string;
  label: string;
  state: string;
  score: number | null;
  band: string | null;
  bandLabel: string | null;
  direction: string | null;
  priorScore: number | null;
  worstCategory: string | null;
  reads: string[] | null;
  waitingOn: string | null;
  readings: RiskReading[] | null;
}

export interface RiskDialCluster {
  ticker: string;
  asOfDate: string | null;
  formulaVersion: string | null;
  composite: RiskReading | null;
  compositeAbsentWhy: string | null;
  dials: RiskDial[] | null;
}

export interface RiskBoardEntry {
  ticker: string;
  company: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  asOfDate: string | null;
  score: number | null;
  band: string | null;
  bandLabel: string | null;
  bandMeaning: string | null;
  direction: string | null;
  directionLabel: string | null;
  priorScore: number | null;
  priorBand: string | null;
  priorBandLabel: string | null;
  delta: number | null;
  moved: boolean | null;
  driverKey: string | null;
  driverLabel: string | null;
  driverValue: number | null;
  driverText: string | null;
  weightProfile: string | null;
  explanation: string | null;
  dialsLit: number | null;
  dialCount: number | null;
  basisChanged: boolean | null;
  priorDialsLit: number | null;
  marketCapUsd: number | null;
}

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function compactTerm(t: RiskTerm): Record<string, unknown> {
  return {
    input: t.key,
    rawValue: round(t.rawValue, 4),
    mappedScore: round(t.mappedScore, 1),
    weight: round(t.weight, 3),
    period: t.periodKey,
    source: t.sourceTable,
    ...(t.excludedWhy ? { excludedWhy: t.excludedWhy } : {}),
    ...(t.measurementClass ? { measurementClass: t.measurementClass } : {}),
  };
}

/** One category reading, compacted. `withTerms` keeps the per-input breakdown. */
export function compactReading(r: RiskReading, withTerms: boolean): Record<string, unknown> {
  const lit = r.state === "LIVE" || r.score != null;
  if (!lit) {
    return { category: r.riskClass, state: r.state, waitingOn: r.waitingOn };
  }
  const shrunk = r.observationCoverage != null && r.shrinkageWeight != null;
  return {
    category: r.riskClass,
    state: r.state,
    score: r.displayScore ?? round(r.score, 0),
    band: r.band,
    direction: r.direction,
    priorScore: round(r.priorScore, 1),
    driver: r.driverMetricKey ? { input: r.driverMetricKey, value: round(r.driverValue, 4) } : null,
    inputs: r.inputsRequired != null ? `${r.inputsAvailable ?? 0}/${r.inputsRequired}` : null,
    ...(r.peerGroupLabel ? { peerGroup: r.peerGroupLabel, percentileInPeers: round(r.percentileInPeers, 1) } : {}),
    ...(shrunk
      ? {
          shrinkage: {
            observedScore: round(r.observedScore, 1),
            populationObservedPct: round((r.observationCoverage ?? 0) * 100, 1),
            readingWeightPct: round((r.shrinkageWeight ?? 0) * 100, 1),
            priorScore: round(r.shrunkToward, 1),
          },
        }
      : {}),
    explanation: r.explanation,
    ...(withTerms && r.terms?.length ? { terms: r.terms.map(compactTerm) } : {}),
  };
}

export function compactDial(d: RiskDial, withTerms: boolean): Record<string, unknown> {
  if (d.score == null) {
    return { mechanism: d.key, label: d.label, state: d.state, reads: d.reads ?? [], waitingOn: d.waitingOn };
  }
  return {
    mechanism: d.key,
    label: d.label,
    state: d.state,
    score: Math.round(d.score),
    band: d.band,
    direction: d.direction,
    priorScore: round(d.priorScore, 1),
    worstCategory: d.worstCategory,
    reads: d.reads ?? [],
    categories: (d.readings ?? []).map((r) => compactReading(r, withTerms)),
  };
}

/** A board/mover row, compacted: the reading, its driver, and the move since last recompute. */
export function compactBoardEntry(e: RiskBoardEntry): Record<string, unknown> {
  return {
    ticker: e.ticker,
    company: e.company,
    exchange: e.exchange,
    sector: e.sector,
    industry: e.industry,
    country: e.country,
    score: e.score,
    band: e.band,
    bandMeaning: e.bandMeaning,
    direction: e.direction,
    priorScore: round(e.priorScore, 1),
    priorBand: e.priorBand,
    delta: e.delta,
    driver: e.driverText,
    weightProfile: e.weightProfile,
    dialsLit: e.dialCount != null ? `${e.dialsLit ?? 0}/${e.dialCount}` : e.dialsLit,
    ...(e.basisChanged ? { basisChanged: true, priorDialsLit: e.priorDialsLit } : {}),
    marketCapUsd: e.marketCapUsd != null ? Math.round(e.marketCapUsd) : null,
    asOfDate: e.asOfDate,
  };
}

/** Accepts "Stretched", "stretched", "STRETCHED" and returns the canonical band, or null. */
export function normalizeBand(value: string): string | null {
  const v = value.trim().toUpperCase();
  return (RISK_BANDS as readonly string[]).includes(v) ? v : null;
}
