import { bullrunGet, bullrunPost, config, type QueryParams } from "../bullrun.js";
import { getMcpUsage } from "../usage/context.js";
import type { Stock } from "./stockIdentity.js";
import type { EtfHolding, EtfProfile } from "./etfData.js";

/** A bounded cache for public instrument data only; never use it for account or portfolio reads. */
export function createPublicReadCache(maxEntries = 128, now: () => number = Date.now) {
  const entries = new Map<string, { expiresAt: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  let generation = 0;
  return {
    async read<T>(key: string, ttlMs: number, load: () => Promise<T>, operationId?: string): Promise<T> {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) return structuredClone(entry.value) as T;
      if (entry) entries.delete(key);
      // A pending HTTP request belongs to its operation lease. Another operation must
      // use its own lease so a capacity refusal also reaches that caller's accounting.
      const flightKey = JSON.stringify([key, operationId]);
      let flight = pending.get(flightKey);
      if (!flight) {
        const createdIn = generation;
        const created = Promise.resolve().then(load).then(value => {
          if (createdIn === generation) {
            entries.set(key, { expiresAt: now() + ttlMs, value });
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
          }
          return value;
        }).finally(() => {
          if (pending.get(flightKey) === created) pending.delete(flightKey);
        });
        pending.set(flightKey, created);
        while (pending.size > maxEntries) pending.delete(pending.keys().next().value!);
        flight = created;
      }
      // Callers can sort or enrich rows without changing another call's cached public data.
      return structuredClone(await flight) as T;
    },
    clear() { entries.clear(); pending.clear(); generation++; },
  };
}

const publicReads = createPublicReadCache();
const PUBLIC_TTL_MS = 30_000;

/** Also lets isolated fixtures change upstream data without waiting for the public-data TTL. */
export function clearEtfPublicReadCache(): void { publicReads.clear(); }

function publicGet<T>(path: string, params?: QueryParams, valid: (value: T) => boolean = () => true): Promise<T> {
  // Keep the shared cache restricted to these public endpoints, including when signed in.
  if (path !== "/api/etfs/search-summary" && !/^\/api\/etfs\/[^/]+\/(?:profile|holdings)$/.test(path)) {
    throw new Error("This endpoint is not a cacheable public ETF read");
  }
  const query = Object.entries(params ?? {}).filter(([, value]) => value != null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  const key = JSON.stringify([config.apiBase, path, query]);
  return publicReads.read(key, PUBLIC_TTL_MS, async () => {
    const value = await bullrunGet<T>(path, params);
    if (!valid(value)) throw new Error("Bullrun returned an invalid public ETF response");
    return value;
  }, getMcpUsage()?.invocationId);
}

export interface EtfSearchSummary { listing: Stock; profile: EtfProfile | null }

export function readEtfSearchSummary(params: QueryParams): Promise<EtfSearchSummary[]> {
  return publicGet<EtfSearchSummary[]>("/api/etfs/search-summary", params,
    rows => Array.isArray(rows) && rows.every(row => typeof row?.listing?.ticker === "string"
      && (row.profile === null || (typeof row.profile === "object" && row.profile !== null))));
}

export function readPublicEtfProfile(ticker: string): Promise<EtfProfile> {
  return publicGet<EtfProfile>(`/api/etfs/${encodeURIComponent(ticker)}/profile`, undefined,
    profile => typeof profile?.ticker === "string");
}

export function readPublicEtfHoldings(ticker: string): Promise<EtfHolding[]> {
  return publicGet<EtfHolding[]>(`/api/etfs/${encodeURIComponent(ticker)}/holdings`, undefined, rows => Array.isArray(rows));
}

export interface HoldingIdentityBatch {
  isinMatches: Record<string, Stock[]>;
  tickerMatches: Record<string, Stock | null>;
}

export function readHoldingIdentityBatch(isins: string[], tickers: string[]): Promise<HoldingIdentityBatch> {
  const body = { isins: [...new Set(isins)].sort(), tickers: [...new Set(tickers)].sort() };
  const key = JSON.stringify([config.apiBase, "/api/stocks/identity-batch", body]);
  return publicReads.read(key, PUBLIC_TTL_MS, async () => {
    const batch = await bullrunPost<HoldingIdentityBatch>("/api/stocks/identity-batch", body);
    if (!batch?.isinMatches || !batch.tickerMatches
      || body.isins.some(isin => !Array.isArray(batch.isinMatches[isin]))
      || body.tickers.some(ticker => !(ticker in batch.tickerMatches)
        || (batch.tickerMatches[ticker] !== null && typeof batch.tickerMatches[ticker]?.ticker !== "string"))) {
      throw new Error("Bullrun returned an invalid public holding identity batch");
    }
    return batch;
  }, getMcpUsage()?.invocationId);
}
