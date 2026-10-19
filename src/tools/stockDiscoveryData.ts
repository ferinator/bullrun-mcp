import type { Stock } from "./stockIdentity.js";

export interface DiscoveryStock extends Stock {
  fundIsin?: string | null;
  marketCap?: number | null;
  peRatio?: number | null;
  revenueGrowthPct?: number | null;
  lifecycleStatus?: string | null;
  succeededBy?: string | null;
}

export function cleanText(value: unknown, max = 180): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sameText(a: unknown, b: unknown): boolean {
  const left = cleanText(a);
  const right = cleanText(b);
  return left != null && right != null && left.toUpperCase() === right.toUpperCase();
}

/** Read only fields consumed by discovery. Reject rows without a listing identity. */
export function discoveryRows(value: unknown): DiscoveryStock[] {
  if (!Array.isArray(value)) throw new Error("Invalid instrument search response");
  return value.filter((row): row is DiscoveryStock => row != null && typeof row === "object"
    && typeof row.ticker === "string" && row.ticker.trim().length > 0 && row.ticker.length <= 80);
}

export function discoveryIdentity(row: DiscoveryStock) {
  return {
    ticker: cleanText(row.ticker, 80), company: cleanText(row.company), exchange: cleanText(row.exchange, 60),
    quoteCurrency: cleanText(row.currency, 12), country: cleanText(row.country, 80),
    sector: cleanText(row.sector, 100), industry: cleanText(row.industry, 140),
    isin: cleanText(row.isin, 20), fundIsin: cleanText(row.fundIsin, 20), lei: cleanText(row.lei, 24), cik: cleanText(row.cik, 20),
    primaryTicker: cleanText(row.primaryTicker, 80), isPrimaryListing: !cleanText(row.primaryTicker),
    quoteType: cleanText(row.quoteType, 30), lifecycleStatus: cleanText(row.lifecycleStatus, 30),
    succeededBy: cleanText(row.succeededBy, 80),
  };
}

// Existing Bullrun exchange codes and their MIC equivalents, also used by the
// repository's Yahoo-symbol mapping. A suffix constrains a venue; it never
// authorizes blindly dropping every dot-delimited component of a ticker.
const VENUES: Record<string, string[]> = {
  NASDAQ: ["NASDAQ", "XNAS"], NYSE: ["NYSE", "XNYS"],
  L: ["LSE", "XLON"], DE: ["XETRA", "XETR"], F: ["F", "XFRA"],
  PA: ["PA", "XPAR"], AS: ["AS", "XAMS"], BR: ["BR", "XBRU"],
  SW: ["SW", "XSWX"], ST: ["ST", "XSTO", "SSME", "XSAT"],
  OL: ["OL", "XOSL"], CO: ["CO", "XCSE", "DSME"], HE: ["HE", "XHEL", "FSME"],
  MC: ["MC", "XMAD", "GROW", "SCLE"], LS: ["LS", "XLIS"],
  VI: ["VI", "XWBO", "WBAH", "WBDM", "WBDP"], IR: ["IR", "XDUB", "XMSM", "XESM"],
  MI: ["MI", "XMIL"], HK: ["HK", "XHKG"], T: ["TSE", "T", "XTKS", "JPX"],
  TO: ["TO", "XTSE", "TSX"], V: ["V", "XTSX", "TSXV"], AX: ["AU", "ASX", "XASX"],
  KS: ["KO", "KS", "XKRX", "KOSPI"], KQ: ["KQ", "XKOS", "KOSDAQ"],
  SS: ["SHG", "XSHG", "SSE"], SZ: ["SHE", "XSHE", "SZSE"],
  SI: ["SG", "XSES", "SGX"], TW: ["TW", "XTAI", "TWSE"], TWO: ["TWO", "ROCO", "TPEX"],
  WA: ["WAR", "WA", "XWAR"], PR: ["PR", "XPRA"], AT: ["AT", "XATH"],
  SA: ["SA", "BVMF", "B3", "BSP"], MX: ["MX", "XMEX"],
  NS: ["NSE", "XNSE"], BO: ["BSE", "XBOM"], IS: ["IS", "XIST"],
  JO: ["JSE", "XJSE"], NZ: ["NZ", "XNZE", "NZX"],
};

export function exchangeMatches(actual: unknown, requested: string): boolean {
  const normalized = requested.trim().toUpperCase();
  const accepted = Object.values(VENUES).find(group => group.includes(normalized)) ?? [normalized];
  return accepted.some(exchange => sameText(actual, exchange));
}

export function yahooAlternative(query: string): { root: string; suffix: string; venues: string[]; searches: string[] } | null {
  const match = /^(.+)\.([A-Z]{1,3})$/.exec(query.toUpperCase());
  if (!match || !VENUES[match[2]] || ["NASDAQ", "NYSE"].includes(match[2])) return null;
  const root = match[1];
  if (!/^[A-Z0-9][A-Z0-9 .@_-]{0,60}$/.test(root)) return null;
  const searches = [root];
  if (/^\d+$/.test(root)) searches.push(root.replace(/^0+(?=\d)/, ""));
  if (root.includes("-")) searches.push(root.replace(/-/g, " "));
  return { root, suffix: match[2], venues: VENUES[match[2]], searches: [...new Set(searches)] };
}

export function suffixRootMatches(ticker: string, root: string): boolean {
  const normalize = (value: string) => value.toUpperCase().replace(/[ ._-]/g, "").replace(/^0+(?=\d+$)/, "");
  return normalize(ticker.split("@")[0]) === normalize(root);
}

/** ISO 6166 check digit. Shaped-but-invalid identifiers fail before any API call. */
export function validIsin(value: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value)) return false;
  const digits = [...value].map(char => /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char).join("");
  let sum = 0;
  for (let offset = 0; offset < digits.length; offset++) {
    let digit = Number(digits[digits.length - offset - 1]);
    if (offset % 2 === 1) digit *= 2;
    sum += digit > 9 ? digit - 9 : digit;
  }
  return sum % 10 === 0;
}

function issuerName(value: unknown): string | null {
  const name = cleanText(value, 220)?.toUpperCase()
    .replace(/\bCLASS\s+[A-Z0-9]+\b/g, "")
    .replace(/\b(?:ORDINARY|COMMON)\s+(?:SHARES?|STOCK)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!name) return null;
  return name.replace(/(?:\s+(?:INCORPORATED|INC|CORPORATION|CORP|LIMITED|LTD|PLC|AG|SA|NV|SE|AB))+$/, "").trim() || null;
}

/** Conservative best-effort issuer deduplication; missing identifiers stay unknown. */
export function sameIssuer(a: DiscoveryStock, b: DiscoveryStock): boolean {
  const canonical = (row: DiscoveryStock) => cleanText(row.primaryTicker, 80) ?? row.ticker;
  if (sameText(a.ticker, b.ticker) || sameText(canonical(a), canonical(b))) return true;
  if (["isin", "lei", "cik"].some(key => sameText(a[key as keyof DiscoveryStock], b[key as keyof DiscoveryStock]))) return true;
  const name = issuerName(a.company);
  return name != null && name === issuerName(b.company);
}
