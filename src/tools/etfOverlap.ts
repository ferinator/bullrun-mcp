import { roundMetric } from "./etfAnalytics.js";
import type { EtfHolding, EtfProfile } from "./etfData.js";
import { aggregateHoldings, type AggregatedHolding, type Indexed, type MatchBasis } from "./holdingIdentity.js";
import { failureText, type ReadFailure } from "./stockIdentity.js";

interface OverlapSnapshot {
  ticker: string;
  holdings: EtfHolding[];
  profile: EtfProfile | null;
  /** Set when the holdings read failed (quota or outage), which is not "nothing stored". */
  holdingsFailure?: ReadFailure | null;
}

interface SharedRow {
  symbol: string | null;
  name: string | null;
  matchedOn: MatchBasis;
  weightPctA: number;
  weightPctB: number;
  overlapWeightPct: number;
}

/** Calculate from complete stored snapshots, never a page or a top-holdings summary. */
export function calculateEtfOverlap(snapshots: OverlapSnapshot[], topSharedLimit: number) {
  const bundles = snapshots.map((snapshot) => ({ ...snapshot, ...aggregateHoldings(snapshot.holdings) }));
  const coverage = bundles.map(({ ticker, holdings, profile, matcher, cashWeightPct, holdingsFailure }) => {
    const coveredWeightPct = holdings.reduce((sum, row) => sum + (row.weightPct ?? 0), 0);
    const reported = profile?.holdingsCount ?? null;
    return {
      ticker,
      asOfDate: holdings[0]?.asOfDate ?? null,
      source: holdings[0]?.source ?? null,
      holdingsLoaded: !holdingsFailure,
      storedRows: holdings.length,
      distinctSecurities: matcher.entries.length,
      reportedHoldingsCount: reported,
      coveredWeightPct: roundMetric(coveredWeightPct),
      cashAndDerivativesWeightPct: roundMetric(cashWeightPct),
      rowsWithIsinPct: holdings.length
        ? roundMetric(holdings.filter((row) => row.holdingIsin).length / holdings.length * 100, 1)
        : null,
      isComplete: reported == null ? null : holdings.length >= reported && coveredWeightPct >= 98,
    };
  });

  const pairs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < bundles.length; i++) {
    for (let j = i + 1; j < bundles.length; j++) {
      const a = bundles[i];
      const b = bundles[j];
      const available = a.holdings.length > 0 && b.holdings.length > 0;
      const used = new Set<Indexed<AggregatedHolding>>();
      const shared: SharedRow[] = [];
      const bySize = [...b.matcher.entries].sort((x, y) => y.payload.weightPct - x.payload.weightPct);
      for (const bEntry of bySize) {
        const hit = a.matcher.find(bEntry.identity, used);
        if (!hit) continue;
        used.add(hit.entry);
        const weightA = hit.entry.payload.weightPct;
        const weightB = bEntry.payload.weightPct;
        shared.push({
          symbol: hit.entry.payload.symbol ?? bEntry.payload.symbol,
          name: hit.entry.payload.name ?? bEntry.payload.name,
          matchedOn: hit.basis,
          weightPctA: roundMetric(weightA) ?? 0,
          weightPctB: roundMetric(weightB) ?? 0,
          overlapWeightPct: Math.min(weightA, weightB),
        });
      }
      shared.sort((left, right) => right.overlapWeightPct - left.overlapWeightPct);
      const matchedOn: Record<string, number> = {};
      for (const row of shared) matchedOn[row.matchedOn] = (matchedOn[row.matchedOn] ?? 0) + 1;
      pairs.push({
        tickerA: a.ticker,
        tickerB: b.ticker,
        available,
        sharedHoldings: available ? shared.length : null,
        matchedOn,
        weightedOverlapPct: available
          ? roundMetric(shared.reduce((sum, row) => sum + row.overlapWeightPct, 0), 4)
          : null,
        sharedWeightPctA: available
          ? roundMetric(shared.reduce((sum, row) => sum + row.weightPctA, 0), 4)
          : null,
        sharedWeightPctB: available
          ? roundMetric(shared.reduce((sum, row) => sum + row.weightPctB, 0), 4)
          : null,
        topShared: shared.slice(0, topSharedLimit)
          .map((row) => ({ ...row, overlapWeightPct: roundMetric(row.overlapWeightPct, 4) })),
      });
    }
  }

  const warnings: string[] = [];
  const partial = coverage.filter((row) => row.isComplete !== true).map((row) => row.ticker);
  if (partial.length) {
    warnings.push(`Partial holdings coverage for ${partial.join(", ")}; overlap is a lower bound and may omit shared exposures.`);
  }
  for (const failure of ["quota", "unavailable"] as const) {
    const failed = bundles.filter((row) => row.holdingsFailure === failure).map((row) => row.ticker);
    if (failed.length) warnings.push(`${failureText(`Holdings for ${failed.join(", ")}`, failure)} Overlap with ${failed.length === 1 ? "it" : "them"} cannot be measured (available=false).`);
  }
  const empty = coverage.filter((row) => row.storedRows === 0 && row.holdingsLoaded).map((row) => row.ticker);
  if (empty.length) {
    warnings.push(`No stored holdings for ${empty.join(", ")}; overlap with ${empty.length === 1 ? "it" : "them"} cannot be measured (available=false), not measured as zero.`);
  }
  if (pairs.some((pair) => Number((pair.matchedOn as Record<string, number>).name ?? 0) > 0)) {
    warnings.push("Some shared rows matched on company name alone (matchedOn=name), typically a depositary receipt against the ordinary share or two share classes of one company. They are the same issuer, not necessarily the same security.");
  }
  return {
    methodology: {
      holdingMatch: "isin, else same symbol with agreeing names and compatible countries, else same normalized name within a compatible country",
      weightedOverlapPct: "sum(min(weight_in_a, weight_in_b))",
      excluded: "cash, currency and derivative lines",
      snapshotSelection: "latest_stored_per_fund",
    },
    coverage,
    pairs,
    warnings,
  };
}
