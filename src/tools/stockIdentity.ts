import { bullrunGet } from "../bullrun.js";

export interface Stock {
  ticker: string;
  company: string | null;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  isin: string | null;
  lei?: string | null;
  cik?: string | null;
  primaryTicker: string | null;
  quoteType: string | null;
  expenseRatio?: number | null;
  distributionPolicy?: string | null;
  indexKey?: string | null;
  fundIsin?: string | null;
}

export async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

function sameTicker(stock: Stock | null | undefined, ticker: string): boolean {
  return stock?.ticker?.toUpperCase() === ticker;
}

/**
 * Resolve a stock by exact ticker. The direct endpoint avoids fuzzy search
 * failures for terse symbols such as V, MA, and LIN. The search fallback keeps
 * the MCP tool compatible during rolling deploys where bullrun-api may not yet
 * expose /api/stocks/{ticker}.
 */
export async function findExactStock(ticker: string): Promise<Stock | null> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;

  const enc = encodeURIComponent(normalized);
  const direct = await safe(bullrunGet<Stock>(`/api/stocks/${enc}`));
  if (sameTicker(direct, normalized)) return direct;

  const matches = await safe(
    bullrunGet<Stock[]>("/api/stocks", {
      search: normalized,
      quoteType: "ALL",
      includeSecondary: true,
      includeInactive: true,
      limit: 500,
    }),
  );

  return matches?.find((s) => sameTicker(s, normalized)) ?? null;
}

export function identityPayload(stock: Stock | null): Record<string, unknown> | null {
  if (!stock) return null;
  return {
    ticker: stock.ticker,
    company: stock.company,
    exchange: stock.exchange,
    currency: stock.currency,
    sector: stock.sector,
    industry: stock.industry,
    country: stock.country,
    isin: stock.isin,
    lei: stock.lei ?? null,
    cik: stock.cik ?? null,
    identifiers: {
      isin: stock.isin,
      lei: stock.lei ?? null,
      cik: stock.cik ?? null,
    },
    quoteType: stock.quoteType,
    primaryTicker: stock.primaryTicker,
    isPrimaryListing: stock.primaryTicker == null,
  };
}
