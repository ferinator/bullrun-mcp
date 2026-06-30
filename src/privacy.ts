/**
 * `privacyMode` controls how much of the caller's real financial data is sent to
 * the model by the per-user portfolio tools.
 *
 *   - "full" (default): expose everything, including absolute money.
 *   - "weights_only": drop absolute money — cash balance, market/total value,
 *     cost basis, share quantity, average price — and keep only relative figures
 *     (position weight %, total/day return %), so the user's net worth and
 *     position sizes never leave their account.
 *
 * Relative ranks (ML forecast/valuation percentiles) and identifiers (names,
 * sector, currency) are safe in both modes.
 */
export type PrivacyMode = "full" | "weights_only";

export function parsePrivacyMode(raw: string | undefined | null): PrivacyMode {
  return raw === "weights_only" ? "weights_only" : "full";
}

/** One row from GET /api/portfolios (PortfolioController.PortfolioSummary DTO). */
export interface PortfolioSummary {
  id: number;
  name: string | null;
  baseCurrency: string | null;
  cashBalance: number | null;
  createdAt: string | null;
  positionCount: number;
  unpricedCount: number;
  marketValueUsd: number;
  totalValueUsd: number;
  dayChangeUsd: number | null;
  dayChangePct: number | null;
  costBasisUsd: number | null;
  totalReturnUsd: number | null;
  totalReturnPct: number | null;
}

/** One enriched position (PortfolioService.PositionView). */
export interface PositionView {
  id: number;
  symbol: string | null;
  ticker: string | null;
  name: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  quantity: number | null;
  avgPrice: number | null;
  currency: string | null;
  price: number | null;
  priceCurrency: string | null;
  priceDate: string | null;
  dayChangePct: number | null;
  marketValueUsd: number | null;
  dayChangeUsd: number | null;
  costBasisUsd: number | null;
  returnPct: number | null;
  priced: boolean;
  mlForecastPercentile: number | null;
  mlForecastSignal: number | null;
  mlValuationPercentile: number | null;
  mlValuationSignal: number | null;
}

function round(value: number, places: number): number {
  const m = Math.pow(10, places);
  return Math.round(value * m) / m;
}

/**
 * "Matched" = the position's symbol was linked to a stock in Bullrun's universe
 * (it has a `ticker`), so it carries a name, sector, price, fundamentals and ML
 * scores. Unmatched holdings — typically ETFs, mutual funds or tickers we don't
 * track — have none of that and are therefore silently absent from weights,
 * sector mix, insights and the risk analytics. The coverage summary below makes
 * that gap explicit so the matched subset is never mistaken for the whole book.
 */
function isMatched(p: PositionView): boolean {
  return p.ticker != null && p.ticker.trim() !== "";
}

/**
 * Best-available absolute USD magnitude for one position, used only to size the
 * coverage gap. Prefer current market value; fall back to cost basis — which is
 * the only value figure unmatched/unpriced holdings have, since they get no live
 * price. Returns null when neither is known (the position can't be valued).
 */
function valueBasis(p: PositionView): number | null {
  if (p.marketValueUsd != null && Number.isFinite(p.marketValueUsd) && p.marketValueUsd !== 0) {
    return Math.abs(p.marketValueUsd);
  }
  if (p.costBasisUsd != null && Number.isFinite(p.costBasisUsd) && p.costBasisUsd !== 0) {
    return Math.abs(p.costBasisUsd);
  }
  return null;
}

/** Project one portfolio summary, redacting absolute money in weights_only mode. */
export function summaryView(p: PortfolioSummary, mode: PrivacyMode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    baseCurrency: p.baseCurrency,
    positionCount: p.positionCount,
    unpricedCount: p.unpricedCount,
    dayChangePct: p.dayChangePct,
    totalReturnPct: p.totalReturnPct,
    createdAt: p.createdAt,
  };
  if (mode === "weights_only") return base;
  return {
    ...base,
    cashBalance: p.cashBalance,
    marketValueUsd: p.marketValueUsd,
    totalValueUsd: p.totalValueUsd,
    dayChangeUsd: p.dayChangeUsd,
    costBasisUsd: p.costBasisUsd,
    totalReturnUsd: p.totalReturnUsd,
  };
}

/**
 * Project a portfolio's positions. `weightPct` (share of total market value) is
 * computed for every position and is safe in both modes; weights_only drops the
 * absolute-money columns and the raw share counts.
 */
export function positionsView(positions: PositionView[], mode: PrivacyMode): Record<string, unknown>[] {
  const totalMv = positions.reduce((sum, p) => sum + (p.marketValueUsd ?? 0), 0);
  return positions.map((p) => {
    const weightPct =
      totalMv > 0 && p.marketValueUsd != null ? round((p.marketValueUsd / totalMv) * 100, 2) : null;
    const base: Record<string, unknown> = {
      symbol: p.symbol,
      ticker: p.ticker,
      name: p.name,
      sector: p.sector,
      industry: p.industry,
      country: p.country,
      // matched = linked to Bullrun's universe (has fundamentals/sector/price/ML);
      // unmatched holdings carry none of the figures below and weightPct is null.
      matched: isMatched(p),
      priced: p.priced,
      weightPct,
      dayChangePct: p.dayChangePct,
      returnPct: p.returnPct,
      currency: p.currency,
      mlForecastPercentile: p.mlForecastPercentile,
      mlValuationPercentile: p.mlValuationPercentile,
    };
    if (mode === "weights_only") return base;
    return {
      ...base,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      price: p.price,
      priceCurrency: p.priceCurrency,
      priceDate: p.priceDate,
      marketValueUsd: p.marketValueUsd,
      dayChangeUsd: p.dayChangeUsd,
      costBasisUsd: p.costBasisUsd,
    };
  });
}

/** One unmatched holding in the coverage summary. Relative figures only — safe in both modes. */
export interface UnmatchedHolding {
  symbol: string | null;
  name: string | null;
  /** Estimated share of total portfolio value, %. null when it can't be valued. */
  valuePct: number | null;
}

/**
 * Data-coverage summary for a portfolio snapshot.
 *
 * The per-user portfolio endpoints return *every* holding, but only the matched
 * ones (linked to Bullrun's universe) carry weights, sector, insights, ML scores
 * and risk analytics. Unmatched holdings — ETFs, funds, untracked tickers — are
 * therefore silently absent from all of those figures. This summary states the
 * gap explicitly, with the unmatched names and their estimated share of value,
 * so an assistant can never mistake the matched subset for the whole portfolio.
 *
 * Every field is relative (counts, percentages, names) and is included in both
 * privacy modes: the coverage gap is a data-quality fact, not private money, and
 * hiding it in `weights_only` would reintroduce exactly the silent-subset bug.
 */
export interface Coverage {
  totalPositions: number;
  matchedPositions: number;
  unmatchedPositions: number;
  /** Estimated % of portfolio value matched to Bullrun data (market value where known, else cost basis). */
  matchedValuePct: number | null;
  /** Estimated % of portfolio value NOT matched — the analysis blind spot. */
  unmatchedValuePct: number | null;
  /** Unmatched holdings, largest estimated value share first. */
  unmatchedHoldings: UnmatchedHolding[];
  /** True when some unmatched holdings could not be valued, so the percentages understate the gap. */
  valueEstimateIncomplete: boolean;
  /** One-line human-readable summary; also surfaced as the tool's first output-text block. */
  summary: string;
}

/** Cap the unmatched names listed inline in the summary text so it stays readable. */
const MAX_LISTED_UNMATCHED = 12;

/**
 * Compute the coverage summary from the raw (un-redacted) positions. Pass the
 * backend `PortfolioDetail.positions`, not the redacted `positionsView` output,
 * so absolute money is available for the value-share estimate; only relative
 * figures are returned.
 */
export function computeCoverage(positions: PositionView[]): Coverage {
  const total = positions.length;
  const unmatched = positions.filter((p) => !isMatched(p));
  const matchedCount = total - unmatched.length;

  let totalBasis = 0;
  let matchedBasis = 0;
  let unmatchedBasis = 0;
  let unvaluedUnmatched = 0;
  for (const p of positions) {
    const basis = valueBasis(p);
    if (basis == null) {
      if (!isMatched(p)) unvaluedUnmatched++;
      continue;
    }
    totalBasis += basis;
    if (isMatched(p)) matchedBasis += basis;
    else unmatchedBasis += basis;
  }

  const unmatchedValuePct = totalBasis > 0 ? round((unmatchedBasis / totalBasis) * 100, 1) : null;
  const matchedValuePct = totalBasis > 0 ? round((matchedBasis / totalBasis) * 100, 1) : null;

  const unmatchedHoldings: UnmatchedHolding[] = unmatched
    .map((p) => ({ p, basis: valueBasis(p) }))
    .sort((a, b) => (b.basis ?? -1) - (a.basis ?? -1))
    .map(({ p, basis }) => ({
      symbol: p.symbol,
      name: p.name,
      valuePct: basis != null && totalBasis > 0 ? round((basis / totalBasis) * 100, 1) : null,
    }));

  const valueEstimateIncomplete = unvaluedUnmatched > 0;
  const summary = coverageSummary(
    total,
    matchedCount,
    unmatched.length,
    unmatchedValuePct,
    matchedValuePct,
    unmatchedHoldings,
    valueEstimateIncomplete,
  );

  return {
    totalPositions: total,
    matchedPositions: matchedCount,
    unmatchedPositions: unmatched.length,
    matchedValuePct,
    unmatchedValuePct,
    unmatchedHoldings,
    valueEstimateIncomplete,
    summary,
  };
}

/** Build the loud, human-readable one-liner. ASCII only (it travels through JSON + terminals). */
function coverageSummary(
  total: number,
  matched: number,
  unmatched: number,
  unmatchedValuePct: number | null,
  matchedValuePct: number | null,
  unmatchedHoldings: UnmatchedHolding[],
  valueEstimateIncomplete: boolean,
): string {
  if (total === 0) return "Coverage: this portfolio has no holdings.";
  if (unmatched === 0) {
    return `Coverage: all ${total} holding${total === 1 ? "" : "s"} are matched to Bullrun data; ` +
      "the figures below describe the full portfolio.";
  }

  const valueClause =
    unmatchedValuePct != null
      ? `They are about ${unmatchedValuePct}% of portfolio value`
      : "Their share of value could not be estimated (no market value or cost basis)";
  const matchedClause =
    matchedValuePct != null ? ` (matched holdings are ~${matchedValuePct}% of value)` : "";

  const listed = unmatchedHoldings.slice(0, MAX_LISTED_UNMATCHED).map((h) => {
    const id = h.symbol ?? h.name ?? "unknown";
    return h.valuePct != null ? `${id} (${h.valuePct}%)` : id;
  });
  const more = unmatchedHoldings.length - listed.length;
  const listText = listed.join(", ") + (more > 0 ? `, +${more} more` : "");

  const incompleteClause = valueEstimateIncomplete
    ? " Value shares are estimated from market value where known, else cost basis; some unmatched " +
      "holdings could not be valued, so the real gap may be larger."
    : "";

  return (
    `COVERAGE GAP -- READ FIRST: ${total} holdings, ${matched} matched to Bullrun data, ` +
    `${unmatched} unmatched (no fundamentals, sector, price or ML score -- typically ETFs, funds, ` +
    `or tickers outside Bullrun's universe). ${valueClause} and are EXCLUDED from the weights, ` +
    `sector mix, insights and ML figures below${matchedClause}. Unmatched: ${listText}. Treat every ` +
    "portfolio-level figure below as covering only the matched holdings; account for the unmatched " +
    `holdings before drawing any whole-portfolio conclusion.${incompleteClause}`
  );
}
