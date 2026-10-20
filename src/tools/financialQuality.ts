interface EbitdaObservation {
  period: string;
  ebit?: number | null;
  ebitda?: number | null;
  depreciationAndAmortization?: number | null;
}

/** Preserve reported amounts while distinguishing absent D&A from an explicit zero. */
export function reportedEbitdaWarnings(rows: EbitdaObservation[]): string[] {
  const periods = rows.filter(row =>
    typeof row.ebit === "number" && Number.isFinite(row.ebit)
    && typeof row.ebitda === "number" && Number.isFinite(row.ebitda)
    && row.ebitda === row.ebit && row.depreciationAndAmortization == null,
  ).map(row => row.period);
  return periods.length ? [
    `Reported EBITDA equals EBIT but depreciation and amortization is not stored for ${[...new Set(periods)].join(", ")}. The reported amounts are retained; the EBITDA adjustment cannot be validated. Missing D&A is unknown, not zero. Operating income and EBIT can use different definitions, so their ordering alone does not establish an error.`,
  ] : [];
}
