import { bullrunGet } from "../bullrun.js";
import { settle, type Settled, type Stock } from "./stockIdentity.js";

export interface EtfProfile {
  ticker: string;
  /** Fund-level ISIN, shared by every venue listing of the same fund. */
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
  /** Normalized tracked-index key, e.g. SP500 or MSCI_WORLD. Joins to the index-group endpoint. */
  indexKey?: string | null;
  /** Wrapper type, e.g. UCITS_FUND — the buyability signal for European retail investors. */
  productType?: string | null;
  website: string | null;
  description: string | null;
  holdingsCount: number | null;
  distributionPolicy?: string | null;
  source?: string | null;
  sourceUpdatedAt: string | null;
  updatedAt: string | null;
  /** Asset class the API reads off this listing's raw columns (FundClassification), or null. */
  assetClassLabel?: string | null;
  /** Category, only where it refines the asset class ("Large Blend"), or null. */
  categoryLabel?: string | null;
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
  /** The security's ISIN, where the provider gave one (ISIN-keyed issuer files, justETF). */
  holdingIsin?: string | null;
  /** Provider's country for the security, unnormalised: an ISO code or an English/German name. */
  holdingCountry?: string | null;
  /** Provider's sector label, unnormalised (GICS, Morningstar or a bond-sector class). */
  holdingSector?: string | null;
  /** Provider's asset class, e.g. Equity, Cash, Futures. */
  holdingAssetClass?: string | null;
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
  return (await readExactEtf(ticker)).data;
}

/** {@link findExactEtf}, keeping a failed lookup (quota, outage) apart from "no such listing". */
export async function readExactEtf(ticker: string): Promise<Settled<Stock>> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return { data: null, failure: null };

  const matches = await settle(
    bullrunGet<Stock[]>("/api/etfs", {
      search: normalized,
      includeSecondary: true,
      includeInactive: true,
      limit: 100,
    }),
  );
  return { data: matches.data?.find((row) => row.ticker?.toUpperCase() === normalized) ?? null, failure: matches.failure };
}

/** ETF profile ratios are stored as decimal fractions (0.002 = 0.2%). */
export function fractionToPct(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(8));
}

/**
 * Inverse of {@link fractionToPct}. The `maxExpenseRatio` query param on /api/etfs is a
 * FRACTION while every MCP tool input is in percentage points, so the conversion has to
 * happen exactly once, here, at the edge.
 */
export function pctToFraction(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number((value / 100).toFixed(10));
}

/**
 * A listing's classification the way get_etf_fund states the fund's: the API's
 * normalised asset class and refining category, with the provider's raw columns
 * beside them only where they say something else.
 *
 * The raw asset_class mixes vocabularies across venues of ONE fund -- iShares MSCI
 * Brazil is "Brazil" on IDBZ.L and the Xetra segment "EXCHANGE TRADED FUNDS - PASSIV"
 * on IQQB.DE -- so it is never presented as the asset class. With no profile, the
 * listing's sector is the crawler's normalised class already.
 */
export function etfClassification(
  profile: EtfProfile | null,
  row?: Pick<Stock, "sector"> | null,
): Record<string, unknown> {
  if (!profile) return { assetClass: row?.sector ?? null, category: null };
  // An API that predates the labels sends neither key; read the raw columns then.
  const assetClass = profile.assetClassLabel !== undefined ? profile.assetClassLabel : profile.assetClass;
  const category = profile.categoryLabel !== undefined ? profile.categoryLabel : profile.category;
  const provider = { assetClass: profile.assetClass ?? null, category: profile.category ?? null };
  return {
    assetClass: assetClass ?? null,
    category: category ?? null,
    ...(provider.assetClass !== (assetClass ?? null) || provider.category !== (category ?? null)
      ? { providerClassification: provider }
      : {}),
  };
}

export function etfSummary(row: Stock, profile: EtfProfile | null): Record<string, unknown> {
  return {
    ticker: row.ticker,
    name: profile?.fundName ?? row.company,
    issuer: profile?.fundFamily ?? null,
    exchange: row.exchange,
    tradingCurrency: row.currency,
    ...etfClassification(profile, row),
    region: profile?.region ?? null,
    domicile: profile?.domicile ?? row.country,
    isin: row.isin,
    fundIsin: profile?.fundIsin ?? null,
    expenseRatioPct: fractionToPct(profile?.expenseRatio),
    aum: profile?.totalAssets ?? null,
    yieldTtmPct: fractionToPct(profile?.yieldTtm),
    distributionPolicy: profile?.distributionPolicy ?? null,
    indexKey: profile?.indexKey ?? null,
    productType: profile?.productType ?? null,
    benchmark: profile?.benchmark ?? null,
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
