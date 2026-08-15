import { bullrunGet } from "../bullrun.js";
import { safe, type Stock } from "./stockIdentity.js";

export interface EtfProfile {
  ticker: string;
  fundIsin?: string | null;
  fundName: string | null;
  fundFamily: string | null;
  category: string | null;
  assetClass: string | null;
  region: string | null;
  domicile: string | null;
  expenseRatio: number | null;
  totalAssets: number | null;
  nav: number | null;
  yieldTtm: number | null;
  inceptionDate: string | null;
  benchmark: string | null;
  indexKey?: string | null;
  website: string | null;
  description: string | null;
  holdingsCount: number | null;
  distributionPolicy?: string | null;
  productType?: string | null;
  source?: string | null;
  sourceUpdatedAt: string | null;
  updatedAt: string | null;
}

export interface EtfHolding {
  ticker: string;
  asOfDate: string;
  holdingKey: string;
  holdingSymbol: string | null;
  holdingName: string | null;
  weightPct: number | null;
  shares: number | null;
  marketValue: number | null;
  currency: string | null;
  source?: string | null;
  updatedAt: string | null;
}

export interface EtfPrice {
  ticker: string;
  tradeDate: string;
  closePrice: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
}

export async function findExactEtf(ticker: string): Promise<Stock | null> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;

  const matches = await safe(
    bullrunGet<Stock[]>("/api/etfs", {
      search: normalized,
      includeSecondary: true,
      includeInactive: true,
      limit: 100,
    }),
  );
  return matches?.find((row) => row.ticker?.toUpperCase() === normalized) ?? null;
}

/** ETF profile ratios are stored as decimal fractions (0.002 = 0.2%). */
export function fractionToPct(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(8));
}

export function etfSummary(row: Stock, profile: EtfProfile | null): Record<string, unknown> {
  return {
    ticker: row.ticker,
    name: profile?.fundName ?? row.company,
    issuer: profile?.fundFamily ?? null,
    exchange: row.exchange,
    tradingCurrency: row.currency,
    category: profile?.category ?? row.sector,
    focus: profile?.assetClass ?? row.industry,
    region: profile?.region ?? null,
    domicile: profile?.domicile ?? row.country,
    isin: row.isin,
    fundIsin: profile?.fundIsin ?? row.fundIsin ?? null,
    expenseRatioPct: fractionToPct(profile?.expenseRatio ?? row.expenseRatio),
    aum: profile?.totalAssets ?? null,
    yieldTtmPct: fractionToPct(profile?.yieldTtm),
    distributionPolicy: profile?.distributionPolicy ?? row.distributionPolicy ?? null,
    benchmark: profile?.benchmark ?? null,
    indexKey: profile?.indexKey ?? row.indexKey ?? null,
    productType: profile?.productType ?? null,
    sourceUpdatedAt: profile?.sourceUpdatedAt ?? null,
    primaryTicker: row.primaryTicker,
    isPrimaryListing: row.primaryTicker == null,
  };
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function toolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
