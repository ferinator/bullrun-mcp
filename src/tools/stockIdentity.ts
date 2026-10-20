import { bullrunGet } from "../bullrun.js";
import { sameText, yahooAlternative } from "./stockDiscoveryData.js";

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
}

/**
 * Null on ANY error. Only for optional extras a tool can do without (a freshness
 * stamp, a live quote over a daily close). A read whose emptiness the tool reports
 * ("no risk factors are stored") must use {@link settle}: a 429 is not "nothing stored".
 */
export async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * Why a bullrun-api read failed, when the answer was not simply "nothing stored":
 * the connection's request quota or per-minute rate limit (429), or an API that
 * did not answer (5xx, timeout, unreachable). Neither says anything about coverage.
 */
export type ReadFailure = "quota" | "unavailable";

/** What to tell the user about a failed read, without upstream bodies or internal addresses. */
export function failureText(what: string, failure: ReadFailure): string {
  return failure === "quota"
    ? `${what} could not be loaded: Bullrun's request quota or rate limit for this connection was reached (HTTP 429). This is not a coverage answer; retry later.`
    : `${what} could not be loaded: Bullrun's data API is not reachable right now. This is not a coverage answer; retry shortly.`;
}

/** A quota or outage error, thrown so the tool reports it rather than "not found". */
export class UpstreamReadError extends Error {
  constructor(readonly failure: ReadFailure, what: string) {
    super(failureText(what, failure));
    this.name = "UpstreamReadError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return /bullrun-api 404 /.test(errorMessage(err));
}

/** The quota or outage behind an error from a bullrun-api read, or null when it was neither. */
export function readFailure(err: unknown): ReadFailure | null {
  if (err instanceof UpstreamReadError) return err.failure;
  const message = errorMessage(err);
  if (/bullrun-api 429 /.test(message)) return "quota";
  return /bullrun-api 5\d\d |Failed to reach bullrun-api /.test(message) ? "unavailable" : null;
}

/** A read's data (null when nothing is stored), or why it could not be loaded. */
export interface Settled<T> {
  data: T | null;
  failure: ReadFailure | null;
}

/** The {@link Settled} value of a read that was not requested. */
export const NOT_REQUESTED: Settled<never> = { data: null, failure: null };

/**
 * Like {@link safe}, but keeps a failed read apart from an empty one: a 404 is
 * "nothing stored", every other error is a failure the tool must report as such.
 */
export async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { data: await p, failure: null };
  } catch (err) {
    return { data: null, failure: isNotFound(err) ? null : readFailure(err) ?? "unavailable" };
  }
}

/** The data, or null when nothing is stored (404); a quota or outage error is thrown. */
export async function storedRead<T>(p: Promise<T>, what: string): Promise<T | null> {
  const result = await settle(p);
  if (result.failure) throw new UpstreamReadError(result.failure, what);
  return result.data;
}

/** A tool's error text: the quota or outage wording when that is what failed, else the fallback. */
export function errorText(err: unknown, what: string, fallback: string): string {
  const failure = readFailure(err);
  return failure ? failureText(what, failure) : fallback;
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
  return (await readExactStock(ticker)).data;
}

/**
 * {@link findExactStock}, keeping a failed lookup (quota, outage) apart from "no such
 * listing": when neither read finds the ticker and either one failed, the failure is kept.
 */
export async function readExactStock(ticker: string): Promise<Settled<Stock>> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return { data: null, failure: null };

  const enc = encodeURIComponent(normalized);
  const direct = await settle(bullrunGet<Stock>(`/api/stocks/${enc}`));
  if (sameTicker(direct.data, normalized)) return direct;

  const matches = await settle(
    bullrunGet<Stock[]>("/api/stocks", {
      search: normalized,
      quoteType: "ALL",
      includeSecondary: true,
      includeInactive: true,
      limit: 500,
    }),
  );

  const found = matches.data?.find((s) => sameTicker(s, normalized)) ?? null;
  return { data: found, failure: found ? null : direct.failure ?? matches.failure };
}

/**
 * How Bullrun stores tickers, for tool descriptions and not-found messages. The
 * convention is NOT uniform: US and most European listings are the plain local
 * symbol, while Asian listings keep their exchange suffix.
 */
export const TICKER_CONVENTION =
  "Bullrun tickers: US and most European listings use the plain local symbol (AAPL, BMW, NESN, ABBN); most Asian and Indian listings keep their exchange suffix (Tokyo 6324.T, Hong Kong 0700.HK, Shanghai 600519.SS, Shenzhen 000001.SZ, Taiwan 2330.TW, Korea 000100.KS, Singapore D05.SI, India RELIANCE.NS), but some Japanese and Korean large caps are plain codes (Toyota 7203, Samsung 005930). Either form is resolved automatically when exactly one listing matches; use search_stocks to find a ticker by company name or ISIN.";

export interface TickerResolution {
  /** The Bullrun ticker to use, or null when none or several listings match. */
  ticker: string | null;
  stock: Stock | null;
  /** Set when the input was not itself a stored ticker, e.g. "6324 resolved to 6324.T". */
  note: string | null;
  /** Listings the input could mean, when it is ambiguous. */
  candidates: Stock[];
}

/**
 * Suffixes a bare numeric code may be stored under: Japanese and Hong Kong/Taiwan
 * codes are four digits, Korean and mainland Chinese six; Hong Kong also writes
 * short codes unpadded (700 = 0700.HK).
 */
function numericVariants(code: string): string[] {
  if (/^\d{6}$/.test(code)) return [`${code}.KS`, `${code}.KQ`, `${code}.SS`, `${code}.SZ`];
  if (/^\d{4}$/.test(code)) return [`${code}.T`, `${code}.HK`, `${code}.TW`, `${code}.TWO`];
  if (/^\d{1,3}$/.test(code)) return [`${code.padStart(4, "0")}.HK`];
  const hk = /^(\d{1,3})\.HK$/.exec(code);
  return hk ? [`${hk[1].padStart(4, "0")}.HK`] : [];
}

/**
 * GET /api/stocks/{ticker}: the listing, a retired ticker's survivor, or null when
 * there is none. Anything else -- unreachable API, quota, 5xx -- is thrown, so a
 * tool reports an outage instead of telling the user the company is not covered.
 */
async function storedListing(ticker: string): Promise<Stock | null> {
  const row = await storedRead(bullrunGet<Stock>(`/api/stocks/${encodeURIComponent(ticker)}`), "The ticker lookup");
  if (row && typeof row.ticker !== "string") throw new UpstreamReadError("unavailable", "The ticker lookup");
  return row;
}

/**
 * Resolve what a user or agent typed to the stored Bullrun ticker: the ticker
 * itself, a retired ticker's successor, a bare numeric code whose exchange suffix
 * was left off (6324 -> 6324.T) when exactly one listing matches, or a Yahoo
 * suffix on a symbol stored bare (BMW.DE -> BMW) when the venue agrees. Several
 * matches are returned as candidates, never guessed between.
 */
export async function resolveStockTicker(input: string): Promise<TickerResolution> {
  const normalized = input.trim().toUpperCase();
  if (!normalized) return { ticker: null, stock: null, note: null, candidates: [] };
  const direct = await storedListing(normalized);
  if (direct) {
    const renamed = direct.ticker.toUpperCase() !== normalized;
    return {
      ticker: direct.ticker,
      stock: direct,
      note: renamed ? `${normalized} is a retired ticker; its listing is now ${direct.ticker}.` : null,
      candidates: [],
    };
  }

  const variants = numericVariants(normalized);
  if (variants.length) {
    const found = (await Promise.all(variants.map(storedListing)))
      .filter((stock): stock is Stock => stock != null);
    const unique = [...new Map(found.map((stock) => [stock.ticker.toUpperCase(), stock])).values()];
    if (unique.length === 1) {
      const stock = unique[0];
      return {
        ticker: stock.ticker,
        stock,
        note: `${normalized} resolved to ${stock.ticker} (${[stock.company, stock.exchange].filter(Boolean).join(", ")}): Bullrun keeps the exchange suffix on this market.`,
        candidates: [],
      };
    }
    if (unique.length > 1) return { ticker: null, stock: null, note: null, candidates: unique };
  }

  const yahoo = yahooAlternative(normalized);
  if (yahoo) {
    for (const root of yahoo.searches) {
      const stock = await storedListing(root);
      if (stock && yahoo.venues.some((venue) => sameText(stock.exchange, venue))) {
        return {
          ticker: stock.ticker,
          stock,
          note: `${normalized} resolved to ${stock.ticker} (${stock.exchange}): Bullrun stores this listing without the Yahoo suffix.`,
          candidates: [],
        };
      }
    }
  }
  return { ticker: null, stock: null, note: null, candidates: [] };
}

/** The not-found text for a stock tool: candidates when ambiguous, else the convention. */
export function tickerNotFoundText(input: string, resolution: TickerResolution): string {
  const typed = input.trim().toUpperCase();
  if (resolution.candidates.length) {
    const list = resolution.candidates
      .map((stock) => `${stock.ticker} (${[stock.company, stock.exchange, stock.country].filter(Boolean).join(", ")})`)
      .join("; ");
    return `"${typed}" matches more than one Bullrun listing: ${list}. Call again with the exact ticker of the one you mean.`;
  }
  return `No Bullrun listing for "${typed}". ${TICKER_CONVENTION} A missing listing here is not proof the company does not exist.`;
}

/**
 * A price or ratio without storage noise: stored float32 closes come back as
 * 758.5999755859375. Seven significant digits keep every real price intact.
 */
export function tidy(value: number | null | undefined, significant = 7): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toPrecision(significant));
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
