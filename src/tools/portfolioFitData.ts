import { bullrunGet } from "../bullrun.js";
import { findExactStock, safe } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { mapWithConcurrency, type EtfHolding, type EtfProfile } from "./etfData.js";
import { aggregateHoldings, HoldingMatcher, identify, type MatchBasis } from "./holdingIdentity.js";

interface PortfolioPosition {
  symbol: string | null;
  ticker: string | null;
  name: string | null;
  country?: string | null;
  marketValueUsd: number | null;
}

interface PortfolioDetail { positions?: PortfolioPosition[] }
interface Underlying { weightPct: number; sources: string[] }

export interface PortfolioRiskPayload {
  coverage?: Record<string, unknown>;
  candidateFit?: Record<string, unknown> | null;
  notes?: string[];
}

export const EXACT_FIT_TICKER = /^[A-Z0-9][A-Z0-9.^=_:-]{0,39}$/i;

/**
 * The optional holdings calculation is independent of price-history analytics.
 * Callers fetch /risk once and keep its own coverage and denominator separate.
 * No absolute position values leave this function.
 */
export async function calculatePortfolioLookThroughFit(args: {
  portfolioId: number;
  candidateTicker: string;
  candidateWeightPct: number;
  /** Legacy risk-only calls still return portfolio/profile coverage metadata. */
  includeLookThrough?: boolean;
}): Promise<{
  lookThroughFit: Record<string, unknown> | null;
  coverage: Record<string, unknown>;
  warnings: string[];
}> {
  const candidateTicker = args.candidateTicker.trim().toUpperCase();
  const includeLookThrough = args.includeLookThrough !== false;
  const warnings: string[] = [];
  const holdingReads = new Map<string, Promise<EtfHolding[] | null>>();
  const readHoldings = (ticker: string) => {
    let pending = holdingReads.get(ticker);
    if (!pending) {
      pending = safe(bullrunGet<EtfHolding[]>(`/api/etfs/${encodeURIComponent(ticker)}/holdings`))
        .then(rows => Array.isArray(rows) ? rows.filter(row => row.ticker?.toUpperCase() === ticker
          && Number.isFinite(row.weightPct) && (row.weightPct ?? 0) >= 0) : null);
      holdingReads.set(ticker, pending);
    }
    return pending;
  };
  const [detail, rawCandidateProfile, candidateStock, candidateHoldingsResult] = await Promise.all([
    bullrunGet<PortfolioDetail>(`/api/portfolios/${args.portfolioId}`),
    safe(bullrunGet<EtfProfile>(`/api/etfs/${encodeURIComponent(candidateTicker)}/profile`)),
    includeLookThrough ? findExactStock(candidateTicker) : Promise.resolve(null),
    includeLookThrough ? readHoldings(candidateTicker) : Promise.resolve(null),
  ]);
  const candidateProfile = rawCandidateProfile?.ticker?.toUpperCase() === candidateTicker ? rawCandidateProfile : null;
  const candidateHoldings = candidateHoldingsResult ?? [];
  const candidateIsEtf = Boolean(candidateProfile) || candidateStock?.quoteType?.toUpperCase() === "ETF"
    || candidateHoldings.length > 0;
  // A failed ETF holdings/profile request is never evidence that the candidate
  // is a stock. Only a confirmed exact equity listing can be one security here.
  const candidateIsStock = !candidateIsEtf && Boolean(candidateStock
    && /^(EQUITY|STOCK)$/i.test(candidateStock.quoteType ?? ""));
  const candidateType = candidateIsEtf ? "etf" : candidateIsStock ? "stock" : "unknown";
  const positions = Array.isArray(detail.positions) ? detail.positions : [];
  const positiveValue = (position: PortfolioPosition) => Number.isFinite(position.marketValueUsd)
    ? Math.max(0, position.marketValueUsd ?? 0) : 0;
  const pricedValue = positions.reduce((sum, position) => sum + positiveValue(position), 0);
  const pricedPositionCount = positions.filter(position => positiveValue(position) > 0).length;
  const portfolioUnderlyings = new HoldingMatcher<Underlying>();
  const addUnderlying = (identity: ReturnType<typeof identify>, weightPct: number, source: string) => {
    if (identity.cash || weightPct <= 0) return;
    const hit = portfolioUnderlyings.find(identity);
    if (hit) {
      hit.entry.payload.weightPct += weightPct;
      if (!hit.entry.payload.sources.includes(source)) hit.entry.payload.sources.push(source);
      portfolioUnderlyings.learn(hit.entry, identity);
    } else {
      portfolioUnderlyings.add(identity, { weightPct, sources: [source] });
    }
  };
  let positionsWithLookThrough = 0;
  let portfolioLookThroughSourceWeightPct = 0;
  let portfolioStoredUnderlyingWeightPct = 0;
  let positionsWithoutLookThrough = 0;
  let positionsWithUnknownIdentity = 0;
  let portfolioWeightWithUnknownIdentityPct = 0;
  const portfolioSnapshots: Array<Record<string, unknown>> = [];
  if (includeLookThrough && pricedValue > 0) {
    const snapshots = await mapWithConcurrency(positions, 4, async position => {
      const ticker = (position.ticker ?? position.symbol)?.trim().toUpperCase();
      const value = positiveValue(position);
      if (value <= 0) return null;
      if (!ticker || !EXACT_FIT_TICKER.test(ticker)) {
        return { position, ticker: null, positionWeightPct: value / pricedValue * 100, holdings: null };
      }
      return { position, ticker, positionWeightPct: value / pricedValue * 100, holdings: await readHoldings(ticker) };
    });
    // Aggregate in portfolio order so identity learning is deterministic even
    // when the underlying HTTP requests finish in a different order.
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const { position, ticker, positionWeightPct, holdings } = snapshot;
      if (!ticker) {
        positionsWithUnknownIdentity++;
        positionsWithoutLookThrough++;
        portfolioWeightWithUnknownIdentityPct += positionWeightPct;
        continue;
      }
      if (holdings?.length) {
        positionsWithLookThrough++;
        portfolioLookThroughSourceWeightPct += positionWeightPct;
        const aggregated = aggregateHoldings(holdings);
        const coveredWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
        portfolioSnapshots.push({ ticker, positionWeightPct: roundMetric(positionWeightPct),
          storedHoldingRows: holdings.length, coveredWeightPct: roundMetric(coveredWeightPct),
          asOfDates: [...new Set(holdings.map(row => row.asOfDate).filter(Boolean))].sort() });
        for (const entry of aggregated.matcher.entries) {
          const weight = positionWeightPct * entry.payload.weightPct / 100;
          portfolioStoredUnderlyingWeightPct += weight;
          addUnderlying(entry.identity, weight, ticker);
        }
      } else {
        positionsWithoutLookThrough++;
        addUnderlying(identify({ holdingSymbol: ticker, holdingName: position.name,
          holdingCountry: position.country }), positionWeightPct, ticker);
      }
    }
  }
  const candidateEntries = !includeLookThrough ? [] : candidateIsEtf ? aggregateHoldings(candidateHoldings).matcher.entries
    : candidateIsStock && candidateStock ? [{
      identity: identify({ holdingSymbol: candidateStock.ticker, holdingName: candidateStock.company,
        holdingIsin: candidateStock.isin, holdingCountry: candidateStock.country }),
      payload: { symbol: candidateStock.ticker, name: candidateStock.company, weightPct: 100, rows: 1 },
    }] : [];
  const duplicateRows = candidateEntries.map(entry => {
    const hit = portfolioUnderlyings.find(entry.identity);
    if (!hit) return null;
    const candidateHoldingWeightPct = entry.payload.weightPct;
    return {
      symbol: entry.payload.symbol,
      name: entry.payload.name,
      matchedOn: hit.basis as MatchBasis,
      candidateHoldingWeightPct: roundMetric(candidateHoldingWeightPct, 4) ?? 0,
      existingPortfolioLookThroughWeightPct: roundMetric(hit.entry.payload.weightPct, 4),
      candidateAllocationDuplicateWeightPct: roundMetric(candidateHoldingWeightPct * args.candidateWeightPct / 100, 4),
      existingSources: hit.entry.payload.sources,
    };
  }).filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => b.candidateAllocationDuplicateWeightPct! - a.candidateAllocationDuplicateWeightPct!);
  const candidateCoveredWeightPct = candidateIsStock ? 100
    : candidateHoldings.reduce((sum, holding) => sum + (holding.weightPct ?? 0), 0);
  const reportedCandidateHoldings = candidateProfile?.holdingsCount ?? null;
  const candidateHoldingsComplete = reportedCandidateHoldings == null ? null
    : candidateHoldings.length >= reportedCandidateHoldings && candidateCoveredWeightPct >= 98;
  if (includeLookThrough && candidateIsEtf && candidateHoldingsComplete !== true) {
    warnings.push("Candidate holdings are partial or completeness is unknown; duplicate exposure is a lower bound.");
  } else if (includeLookThrough && !candidateIsStock && !candidateIsEtf) {
    warnings.push("Candidate look-through identity is unavailable: no exact equity listing or ETF snapshot could be confirmed. No duplicate-exposure conclusion can be drawn.");
  }
  if (positionsWithLookThrough > 0) {
    warnings.push("Portfolio ETF look-through uses each fund's latest stored, potentially partial snapshot; snapshot dates can differ and duplicate exposure is a lower bound.");
  }
  if (positionsWithoutLookThrough > 0) {
    warnings.push("Positions without stored ETF holdings have incomplete constituent coverage; those with usable identities are compared as directly held instruments only. Any ETF/fund constituents among them remain unknown.");
  }
  if (positionsWithUnknownIdentity > 0) {
    warnings.push(`${positionsWithUnknownIdentity} positive priced portfolio position(s) have missing or invalid instrument identities; their ${roundMetric(portfolioWeightWithUnknownIdentityPct)}% share remains in the look-through denominator but cannot be matched. Duplicate exposure is a lower bound.`);
  }
  if (pricedPositionCount < positions.length) {
    warnings.push("Unpriced portfolio positions are excluded from look-through weights, which are renormalized over positive priced positions.");
  }
  if (includeLookThrough && (pricedValue <= 0 || portfolioUnderlyings.entries.length === 0)) {
    warnings.push("No comparable priced portfolio instruments are available for look-through; existing duplicate exposure is unknown.");
  }
  if (includeLookThrough) warnings.push("Look-through weights use positive priced position values, independently of the price-history risk subset; cash balances outside positions are excluded. Do not compare these weights as though their denominator were the risk coverage denominator.");
  return {
    lookThroughFit: candidateEntries.length && portfolioUnderlyings.entries.length && pricedValue > 0 ? {
      candidateTicker,
      candidateType,
      candidateWeightPct: args.candidateWeightPct,
      duplicateUnderlyingCount: duplicateRows.length,
      candidateHoldingsWeightAlreadyPresentPct: roundMetric(duplicateRows.reduce((sum, row) => sum + row.candidateHoldingWeightPct, 0)),
      proposedPortfolioWeightInDuplicateUnderlyingsPct: roundMetric(duplicateRows.reduce((sum, row) => sum + (row.candidateAllocationDuplicateWeightPct ?? 0), 0)),
      topDuplicateUnderlyings: duplicateRows.slice(0, 25),
    } : null,
    coverage: {
      weightDenominator: "positive_priced_position_values",
      independentOfPriceHistoryRiskCoverage: true,
      cashBalanceIncluded: false,
      portfolioPositions: positions.length,
      pricedPortfolioPositions: pricedPositionCount,
      portfolioEtfPositionsWithLookThrough: positionsWithLookThrough,
      portfolioEtfPositionWeightWithLookThroughPct: roundMetric(portfolioLookThroughSourceWeightPct),
      portfolioStoredUnderlyingWeightPct: roundMetric(portfolioStoredUnderlyingWeightPct),
      portfolioPositionsWithoutStoredLookThrough: positionsWithoutLookThrough,
      portfolioPositionsWithUnknownIdentity: positionsWithUnknownIdentity,
      portfolioWeightWithUnknownIdentityPct: roundMetric(portfolioWeightWithUnknownIdentityPct),
      portfolioComparableInstruments: portfolioUnderlyings.entries.length,
      portfolioSnapshots,
      candidateType,
      candidateStoredHoldingRows: candidateHoldings.length,
      candidateReportedHoldingsCount: reportedCandidateHoldings,
      candidateCoveredWeightPct: roundMetric(candidateCoveredWeightPct),
      candidateHoldingsComplete,
      candidateAsOfDates: [...new Set(candidateHoldings.map(row => row.asOfDate).filter(Boolean))].sort(),
    },
    warnings,
  };
}
