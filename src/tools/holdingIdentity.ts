/**
 * Which ETF holdings are the same security, and what country and sector a holding is.
 *
 * A provider's symbol is not an identity. Vanguard's Europe file lists Roche as ROP,
 * which is Roper Technologies in its S&P 500 file; MRK is Merck KGaA in one and
 * Merck & Co in the other. Matching or classifying holdings on the bare symbol
 * invented 20 "shared holdings" between an S&P 500 fund and a Europe fund, and
 * resolving a copper miner's symbols through the stock table put 28% of it in EUR.
 *
 * So identity is layered, strongest first:
 *   1. the same ISIN;
 *   2. the same symbol, when the names agree and the countries are compatible, or
 *      when both providers put it in the same country (renames: GE Aerospace);
 *   3. the same normalised name, when the countries are compatible.
 * Two rows that both carry an ISIN and disagree on it are never the same security,
 * and cash, currency and derivative lines are never "shared holdings".
 *
 * "Compatible" is looser than equal because providers disagree about where a
 * multinational belongs -- Xtrackers puts Shell in NL and Glencore in AU, iShares
 * puts both in the UK -- but not so loose that a US company meets a European one:
 * that is where same-symbol collisions come from (MRK, EQT, PRU).
 *
 * Country and sector come from the provider's own row (issuer files carry both),
 * normalised to one vocabulary, before anything is looked up.
 */
import type { EtfHolding } from "./etfData.js";

/** Holding rows as /api/etfs/{ticker}/holdings returns them, provider fields included. */
export type HoldingRow = EtfHolding;

/** Anything with a symbol and a name -- a holding row, or a portfolio position. */
export type HoldingLike = Partial<Pick<EtfHolding,
  "holdingSymbol" | "holdingName" | "holdingIsin" | "holdingCountry" | "holdingSector" | "holdingAssetClass" | "source">>;

export type MatchBasis = "isin" | "symbol+name" | "symbol+country" | "name";

export interface HoldingIdentity {
  isin: string | null;
  /** Symbol with any exchange suffix and class separator normalised, leading zeros dropped. */
  baseSymbol: string | null;
  /** Normalised name: no legal forms, share-class words or punctuation. */
  nameKey: string;
  /** ISO 3166 alpha-2, "SUPRA" for supranational issuers, or null when unknown. */
  country: string | null;
  /** Where {@link country} came from. */
  countrySource: "provider" | "listing" | null;
  /** Provider sector in Bullrun's vocabulary (or as reported when it has no equivalent). */
  sector: string | null;
  /** Cash, currency and derivative lines. */
  cash: boolean;
}

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Aggregator feeds whose symbols are exchange-qualified Yahoo-style tickers. */
const AGGREGATOR_SOURCES = new Set(["YAHOO_TOP_HOLDINGS", "STOCKANALYSIS_HOLDINGS", "ALPHAVANTAGE_HOLDINGS"]);

/**
 * Yahoo exchange suffix -> country of the listing, for venues where listings are
 * overwhelmingly home-market companies. German regional venues and LSE's
 * international order book are left out on purpose: they list foreign shares.
 */
const SUFFIX_COUNTRY: Record<string, string> = {
  L: "GB", SW: "CH", VX: "CH", PA: "FR", AS: "NL", BR: "BE", MI: "IT", MC: "ES", LS: "PT",
  IR: "IE", VI: "AT", ST: "SE", CO: "DK", HE: "FI", OL: "NO", IC: "IS", WA: "PL", PR: "CZ",
  BD: "HU", AT: "GR", IS: "TR", T: "JP", HK: "HK", SS: "CN", SZ: "CN", TW: "TW", TWO: "TW",
  KS: "KR", KQ: "KR", SI: "SG", AX: "AU", NZ: "NZ", TO: "CA", V: "CA", NE: "CA", NS: "IN",
  BO: "IN", JK: "ID", KL: "MY", BK: "TH", SA: "BR", MX: "MX", JO: "ZA", TA: "IL", SR: "SA",
};

/** Exchange suffixes stripped to compare symbols across conventions (country or not). */
const EXCHANGE_SUFFIXES = new Set([
  ...Object.keys(SUFFIX_COUNTRY), "DE", "F", "BE", "DU", "HM", "HA", "MU", "SG", "IL", "XC", "XD",
]);

const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "GBX", "JPY", "CHF", "CAD", "AUD", "NZD", "HKD", "SGD", "CNY", "CNH",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ZAR", "BRL", "MXN", "INR", "KRW", "TWD",
  "IDR", "MYR", "THB", "PHP", "ILS", "SAR", "AED", "QAR", "KWD", "CLP", "COP", "PEN", "RUB",
]);
const CURRENCY_NAME = /\b(DOLLAR|EURO|YEN|POUND|STERLING|FRANC|KRONA|KRONE|KRONER|ZLOTY|FORINT|REAL|RAND|PESO|WON|YUAN|RENMINBI|RUPEE|RINGGIT|BAHT|SHEKEL|RIYAL|DIRHAM|CASH)\b/;
const CASH_ASSET = /\b(CASH|CURRENCY|FX|MONEY MARKET|FUTURES?|FORWARDS?|SWAPS?|DERIVATIVES?|OPTIONS?|MARGIN|COLLATERAL|STIV)\b/;
/** Derivative legs some files class as the underlying's asset class ("TRS:GOLDMAN SACHS ..."). */
const DERIVATIVE_NAME = /^(TRS|CFD|FWD)\b|\b(TOTAL RETURN SWAP|SWAP|FUTURES?|FORWARD CONTRACT)\b/;

/**
 * Tokens that say what kind of share or company a line is, not which company.
 * GROUP and HOLDING are deliberately absent: SoftBank Group and SoftBank Corp,
 * Heineken Holding and Heineken, are different listed companies.
 */
const NAME_NOISE = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "COS", "LTD", "LIMITED", "PLC",
  "AG", "SA", "SE", "NV", "BV", "AB", "ASA", "OYJ", "SPA", "KGAA", "SCA", "SAB", "CV", "BHD",
  "TBK", "PCL", "LLC", "LP", "THE", "ADR", "ADRS", "ADS", "PAR",
  "GDR", "SPONSORED", "UNSPONSORED", "CLASS", "CL", "CLS", "REG", "REGS", "REGISTERED", "ORD",
  "ORDINARY", "SHS", "SHARES", "SHARE", "COMMON", "STOCK", "NPV", "PREF", "PREFERRED", "AND",
  "OF", "NAMEN", "NAMENS", "AKT", "AKTIE", "AKTIEN", "INHABER", "VZ", "GENUSSS", "GENUSSSCHEIN",
  "PARTICIPATION", "CERT", "CERTIFICATE", "CERTIFICATES", "UNITS", "UNIT", "USD", "EUR", "CHF",
  "GBP", "GBX", "JPY", "HKD", "COMPANIES",
]);

/** Issuer and Morningstar/GICS sector spellings -> Bullrun's (Yahoo) sector names. */
const SECTOR_ALIASES: Record<string, string> = {
  "INFORMATION TECHNOLOGY": "Technology",
  "TECHNOLOGY": "Technology",
  "INFORMATIONSTECHNOLOGIE": "Technology",
  "HEALTH CARE": "Healthcare",
  "HEALTHCARE": "Healthcare",
  "GESUNDHEITSWESEN": "Healthcare",
  "FINANCIALS": "Financial Services",
  "FINANCIAL SERVICES": "Financial Services",
  "FINANZWESEN": "Financial Services",
  "FINANZEN": "Financial Services",
  "CONSUMER DISCRETIONARY": "Consumer Cyclical",
  "CONSUMER CYCLICAL": "Consumer Cyclical",
  "ZYKLISCHE KONSUMGUTER": "Consumer Cyclical",
  "NICHT BASISKONSUMGUTER": "Consumer Cyclical",
  "CONSUMER STAPLES": "Consumer Defensive",
  "CONSUMER DEFENSIVE": "Consumer Defensive",
  "BASISKONSUMGUTER": "Consumer Defensive",
  "MATERIALS": "Basic Materials",
  "BASIC MATERIALS": "Basic Materials",
  "ROHSTOFFE": "Basic Materials",
  "MATERIALIEN": "Basic Materials",
  "COMMUNICATION SERVICES": "Communication Services",
  "COMMUNICATION": "Communication Services",
  "COMMUNICATIONS": "Communication Services",
  "TELECOMMUNICATION SERVICES": "Communication Services",
  "TELECOMMUNICATIONS": "Communication Services",
  "KOMMUNIKATIONSDIENSTE": "Communication Services",
  "KOMMUNIKATION": "Communication Services",
  "INDUSTRIALS": "Industrials",
  "INDUSTRIE": "Industrials",
  "ENERGY": "Energy",
  "ENERGIE": "Energy",
  "UTILITIES": "Utilities",
  "VERSORGER": "Utilities",
  "VERSORGUNGSBETRIEBE": "Utilities",
  "REAL ESTATE": "Real Estate",
  "IMMOBILIEN": "Real Estate",
};
const UNCLASSIFIED_SECTORS = new Set(["", "UNKNOWN", "OTHER", "OTHERS", "N A", "NA", "UNASSIGNED", "SONSTIGE"]);
const CASH_SECTOR = /\b(CASH|DERIVATIVES?)\b/;

/** Not countries, but stated in country columns of bond and multinational funds. */
const SUPRANATIONAL = new Set([
  "SUPRANATIONAL", "SUPRANATIONALS", "SUPRA NATIONAL", "SUPRANATIONAAL", "SNAT", "MULT",
  "MULTINATIONAL", "EUROPEAN UNION", "EUROPAISCHE UNION", "EUROZONE", "EUROPE", "EU", "EZ", "XE",
]);
const UNKNOWN_COUNTRY = new Set(["XX", "UNASSIGNED", "UNKNOWN", "OTHER", "N A", "BELGIUM LUXEMBOURG"]);
const NON_COUNTRY_CODES = new Set(["EU", "EZ", "UN", "ZZ", "QO", "XA", "XB"]);

/**
 * Holding-company domiciles: a company incorporated here usually operates
 * somewhere else, so providers split between the domicile and the operating
 * country (Glencore: JE or AU; Chinese groups: KY or CN). Compatible with anything.
 */
const DOMICILE_WILDCARDS = new Set(["KY", "BM", "VG", "JE", "GG", "IM", "LU", "IE", "NL", "PA", "LR", "MH", "CW", "BS", "MU", "CY"]);

const REGION_MEMBERS: Record<string, string> = {
  NORTH_AMERICA: "US CA PR",
  EUROPE: "AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO SE SI SK GG JE IM GI FO AD SM VA RS ME MK AL BA UA MD TR RU",
  ASIA_PACIFIC: "JP CN HK MO TW KR SG AU NZ IN ID MY TH PH VN PK BD LK KH MM MN KZ",
  LATIN_AMERICA: "BR MX AR CL CO PE UY PY BO EC VE CR PA GT HN SV DO JM TT BS BB",
  MIDDLE_EAST_AFRICA: "ZA EG NG KE MA AE SA QA KW BH OM IL JO LB GH CI SN MU",
};
const REGION_OF = new Map<string, string>();
for (const [region, members] of Object.entries(REGION_MEMBERS)) {
  for (const code of members.split(" ")) if (!REGION_OF.has(code)) REGION_OF.set(code, region);
}

const COUNTRY_ALIASES: Record<string, string> = {
  "USA": "US", "UNITED STATES OF AMERICA": "US", "VEREINIGTE STAATEN VON AMERIKA": "US", "US": "US",
  "UK": "GB", "GREAT BRITAIN": "GB", "GROSSBRITANNIEN": "GB", "ENGLAND": "GB",
  "KOREA": "KR", "KOREA SOUTH": "KR", "KOREA REPUBLIC OF": "KR", "REPUBLIC OF KOREA": "KR",
  "KOREA REPUBLIK SUDKOREA": "KR", "SOUTH KOREA": "KR",
  "HONG KONG": "HK", "HONGKONG": "HK", "MACAU": "MO", "MACAO": "MO",
  "CHINA VOLKSREPUBLIK": "CN", "REPUBLIK CHINA TAIWAN": "TW", "TAIWAN": "TW",
  "CZECH REPUBLIC": "CZ", "SLOVAK REPUBLIC": "SK", "RUSSIAN FEDERATION": "RU", "RUSSIA": "RU",
  "TURKEY": "TR", "TURKIYE": "TR", "UAE": "AE", "VER ARABISCHE EMIRATE": "AE",
  "IVORY COAST": "CI", "COTE D IVOIRE": "CI", "COTE DIVOIRE": "CI", "COTE D IVOIRE IVORY COAST": "CI",
  "CROATIA HRVATSKA": "HR", "VENEZUELA BOLIVARIAN REPUBLIC OF": "VE",
  "BOLIVIA PLURINATIONAL STATE OF": "BO", "CONGO REPUBLIC OF": "CG", "CONGO": "CG",
  "CONGO THE DEMOCRATIC REPUBLIC OF": "CD", "DEMOCRATIC REP OF CONGO": "CD",
  "MACEDONIA": "MK", "NORTH MACEDONIA": "MK",
  "BRITISH VIRGIN": "VG", "BRITISH VIRGIN ISLANDS": "VG", "BRITISH VERGIN ISLANDS": "VG",
  "VIRGIN ISLANDS": "VG", "CAYMAN ISLAND": "KY", "C I GUERNSEY": "GG", "C I JERSEY": "JE",
  "JERSEY KANALINSEL": "JE", "ISLE OF MAN": "IM", "DOMINICAN REPB": "DO", "KAZACHSTAN": "KZ",
};

/** Display names matching Bullrun's stock.country vocabulary where ICU differs. */
const COUNTRY_DISPLAY: Record<string, string> = {
  HK: "Hong Kong", MO: "Macau", CZ: "Czech Republic", TR: "Turkey", MK: "Macedonia",
  CI: "Ivory Coast", CD: "DR Congo", CG: "Congo", SUPRA: "Supranational",
};

function normalizeText(raw: string): string {
  return raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ").trim();
}

const { COUNTRY_CODES, COUNTRY_BY_NAME, ENGLISH_NAMES } = (() => {
  const english = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const german = new Intl.DisplayNames(["de"], { type: "region", fallback: "none" });
  const codes = new Set<string>();
  const byName = new Map<string, string>();
  const names = new Map<string, string>();
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      if (NON_COUNTRY_CODES.has(code)) continue;
      // ICU still names retired codes (UK, FX, AN...); they must not take over
      // "United Kingdom" or "France" from GB and FR.
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      const en = english.of(code);
      if (!en) continue;
      codes.add(code);
      names.set(code, en);
      byName.set(normalizeText(en), code);
      const de = german.of(code);
      if (de) byName.set(normalizeText(de), code);
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) byName.set(alias, code);
  return { COUNTRY_CODES: codes, COUNTRY_BY_NAME: byName, ENGLISH_NAMES: names };
})();

/** ISO alpha-2 code (or "SUPRA") for a provider's country string, in English, German or ISO form. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = normalizeText(raw);
  if (!text || UNKNOWN_COUNTRY.has(text)) return null;
  if (SUPRANATIONAL.has(text)) return "SUPRA";
  if (text.length === 2) {
    const canonical = Intl.getCanonicalLocales(`und-${text}`)[0]?.slice(4) ?? text;
    if (COUNTRY_CODES.has(canonical)) return canonical;
  }
  return COUNTRY_BY_NAME.get(text)
    ?? COUNTRY_BY_NAME.get(text.replace(/^SONDERVERWALTUNGSREGION /, ""))
    ?? null;
}

/** English display name for an ISO code from {@link normalizeCountry}. */
export function countryName(code: string | null): string | null {
  if (!code) return null;
  return COUNTRY_DISPLAY[code] ?? ENGLISH_NAMES.get(code) ?? code;
}

/** Provider sector in Bullrun's vocabulary; bond-sector labels with no equivalent pass through. */
export function normalizeSector(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = normalizeText(raw);
  if (UNCLASSIFIED_SECTORS.has(text)) return null;
  return SECTOR_ALIASES[text] ?? raw.trim();
}

export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  const upper = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    // French elision is its own word (L'OREAL -> OREAL); a possessive is not (MCDONALD'S).
    .replace(/(^|[^A-Z])([LD])['\u2019](?=[A-Z])/g, "$1 ")
    .replace(/['\u2019]/g, "")
    .replace(/\bA\/S\b/g, " ")
    .replace(/\/[A-Z]{2}$/, "");
  const tokens = upper.replace(/[^A-Z0-9]+/g, " ").split(" ").filter(Boolean);
  // Initials written apart are one word (D R HORTON = DR HORTON); a lone letter is a share class.
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    if (token.length === 1) while (tokens[i + 1]?.length === 1) token += tokens[++i];
    merged.push(token);
  }
  return merged.filter((token) => token.length > 1 && !NAME_NOISE.has(token)).join(" ");
}

/**
 * Equal, or one is the other's leading words -- the last of them possibly cut
 * short, as fixed-width files do ("WESTINGHOUSE AIR BRAKE TECHNOLOGIE",
 * "APPLIED MATERIAL"): "ROCHE" agrees with "ROCHE GENUSSSCHEINE".
 */
export function namesAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a.split(" "), b.split(" ")] : [b.split(" "), a.split(" ")];
  if (short.join(" ").length < 3 || short.length > long.length) return false;
  const last = short.length - 1;
  for (let i = 0; i < last; i++) if (short[i] !== long[i]) return false;
  return short[last] === long[last] || (short[last].length >= 4 && long[last].startsWith(short[last]));
}

function countriesCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b || a === b || a === "SUPRA" || b === "SUPRA") return true;
  if (DOMICILE_WILDCARDS.has(a) || DOMICILE_WILDCARDS.has(b)) return true;
  const region = REGION_OF.get(a);
  return region != null && region === REGION_OF.get(b);
}

function splitSymbol(raw: string | null | undefined): { base: string | null; suffix: string | null } {
  if (!raw) return { base: null, suffix: null };
  const symbol = raw.trim().toUpperCase().replace(/[\s/-]+/g, ".");
  if (!symbol) return { base: null, suffix: null };
  const dot = symbol.lastIndexOf(".");
  let base = symbol;
  let suffix: string | null = null;
  if (dot > 0 && EXCHANGE_SUFFIXES.has(symbol.slice(dot + 1))) {
    base = symbol.slice(0, dot);
    suffix = symbol.slice(dot + 1);
  }
  if (/^\d+$/.test(base)) base = base.replace(/^0+(?=\d)/, "");
  return { base, suffix };
}

/** Bullrun exchange codes -> country of the venue. German regional venues count as DE. */
const EXCHANGE_COUNTRY: Record<string, string> = {
  "NYSE": "US", "NASDAQ": "US", "NYSE ARCA": "US", "NYSE MKT": "US", "AMEX": "US", "BATS": "US", "OTC": "US",
  "TO": "CA", "V": "CA", "TSX": "CA", "TSXV": "CA", "NEO": "CA", "CN": "CA",
  "LSE": "GB", "IL": "GB", "XETRA": "DE", "F": "DE", "DU": "DE", "MU": "DE", "BE": "DE", "HM": "DE",
  "HA": "DE", "STU": "DE", "SG": "DE", "TSE": "JP", "SGX": "SG", "ASX": "AU", "NSE": "IN", "BSE": "IN",
  // ISO 10383 MICs, which Bullrun stores for SYMBOL@MIC listings (NDA@XETR).
  "XNYS": "US", "XNAS": "US", "ARCX": "US", "XASE": "US", "XTSE": "CA", "XTSX": "CA", "XLON": "GB",
  "XETR": "DE", "XFRA": "DE", "XBER": "DE", "XDUS": "DE", "XHAM": "DE", "XHAN": "DE", "XMUN": "DE",
  "XSTU": "DE", "XSWX": "CH", "XVTX": "CH", "XPAR": "FR", "XAMS": "NL", "XBRU": "BE", "XMIL": "IT",
  "XMAD": "ES", "XLIS": "PT", "XDUB": "IE", "XMSM": "IE", "XWBO": "AT", "XSTO": "SE", "XCSE": "DK",
  "XHEL": "FI", "XOSL": "NO", "XICE": "IS", "XWAR": "PL", "XPRA": "CZ", "XBUD": "HU", "XATH": "GR",
  "XIST": "TR", "XZAG": "HR", "XBEL": "RS", "XLJU": "SI", "XBUL": "BG", "XBSE": "RO", "XTKS": "JP",
  "XHKG": "HK", "XSHG": "CN", "XSHE": "CN", "XTAI": "TW", "XKRX": "KR", "XKOS": "KR", "XSES": "SG",
  "XASX": "AU", "XNZE": "NZ", "XNSE": "IN", "XBOM": "IN", "XIDX": "ID", "XKLS": "MY", "XBKK": "TH",
  "BVMF": "BR", "XMEX": "MX", "XJSE": "ZA", "XTAE": "IL", "XSAU": "SA",
};

/** Country of the venue a Bullrun listing trades on, from its exchange or its ticker suffix. */
export function listingCountry(listing: { ticker?: string | null; exchange?: string | null }): string | null {
  const exchange = listing.exchange?.trim().toUpperCase();
  if (exchange) return EXCHANGE_COUNTRY[exchange] ?? SUFFIX_COUNTRY[exchange] ?? null;
  const ticker = listing.ticker?.toUpperCase() ?? "";
  const mic = ticker.match(/@([A-Z0-9]{4})$/)?.[1];
  if (mic) return EXCHANGE_COUNTRY[mic] ?? null;
  const suffix = ticker.match(/\.([A-Z]{1,4})$/)?.[1];
  return suffix ? SUFFIX_COUNTRY[suffix] ?? null : null;
}

const EURO_AREA = "AT BE DE EE ES FI FR GR HR IT LT LV MT NL PT SI SK";
const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", GB: "GBP", CH: "CHF", LI: "CHF", JP: "JPY", HK: "HKD", TW: "TWD", KR: "KRW",
  SG: "SGD", AU: "AUD", NZ: "NZD", IN: "INR", ID: "IDR", MY: "MYR", TH: "THB", PH: "PHP", SE: "SEK",
  NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY", IL: "ILS",
  ZA: "ZAR", BR: "BRL", MX: "MXN", CL: "CLP", CO: "COP", PE: "PEN", SA: "SAR", AE: "AED", QA: "QAR",
  KW: "KWD", EG: "EGP",
  ...Object.fromEntries(EURO_AREA.split(" ").map((code) => [code, "EUR"])),
};

/**
 * The currency a company in this country is normally listed in, as a last resort
 * for files that state no currency. Absent for holding-company domiciles (Cayman,
 * Jersey, Ireland, Luxembourg...) and for China, whose groups list in CNY and HKD.
 */
export function countryCurrency(code: string | null): string | null {
  return code ? COUNTRY_CURRENCY[code] ?? null : null;
}

/** Pence and other minor units are the same currency exposure as their major unit. */
export function majorCurrency(code: string | null | undefined): string | null {
  const value = code?.trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === "GBX") return "GBP";
  if (upper === "ZAC") return "ZAR";
  if (upper === "ILA") return "ILS";
  return upper;
}

export function validIsin(raw: string | null | undefined): string | null {
  const isin = raw?.trim().toUpperCase() ?? "";
  return ISIN_PATTERN.test(isin) ? isin : null;
}

export function identify(row: HoldingLike): HoldingIdentity {
  const { base, suffix } = splitSymbol(row.holdingSymbol);
  const name = row.holdingName ?? "";
  const upperName = name.toUpperCase();
  const providerCountry = normalizeCountry(row.holdingCountry);
  let country = providerCountry;
  let countrySource: HoldingIdentity["countrySource"] = providerCountry ? "provider" : null;
  if (!country && row.source && AGGREGATOR_SOURCES.has(row.source) && base) {
    // Yahoo-style feeds: a bare symbol is a US line (unless it is a depositary
    // receipt, whose issuer is foreign); a suffix names the home exchange.
    const listing = suffix ? SUFFIX_COUNTRY[suffix] ?? null
      : /\b(ADR|ADS|GDR)\b/.test(upperName) ? null : "US";
    if (listing) {
      country = listing;
      countrySource = "listing";
    }
  }
  const assetClass = (row.holdingAssetClass ?? "").toUpperCase();
  const rawSector = (row.holdingSector ?? "").toUpperCase();
  const cash = CASH_ASSET.test(assetClass) || CASH_SECTOR.test(rawSector)
    || DERIVATIVE_NAME.test(normalizeText(name))
    || (base != null && CURRENCY_CODES.has(base) && CURRENCY_NAME.test(normalizeText(name)));
  return {
    isin: validIsin(row.holdingIsin),
    baseSymbol: base,
    nameKey: normalizeName(name),
    country,
    countrySource,
    sector: cash ? null : normalizeSector(row.holdingSector),
    cash,
  };
}

export interface Indexed<T> {
  identity: HoldingIdentity;
  payload: T;
}

/** Holdings indexed for {@link find}; one entry per distinct security. */
export class HoldingMatcher<T> {
  readonly entries: Indexed<T>[] = [];
  private readonly byIsin = new Map<string, Indexed<T>>();
  private readonly bySymbol = new Map<string, Indexed<T>[]>();
  private readonly byName = new Map<string, Indexed<T>[]>();

  find(identity: HoldingIdentity, exclude?: Set<Indexed<T>>): { entry: Indexed<T>; basis: MatchBasis } | null {
    const usable = (entry: Indexed<T>) => !exclude?.has(entry)
      && !(entry.identity.isin && identity.isin && entry.identity.isin !== identity.isin);
    if (identity.isin) {
      const entry = this.byIsin.get(identity.isin);
      if (entry && !exclude?.has(entry)) return { entry, basis: "isin" };
    }
    if (identity.baseSymbol) {
      for (const entry of this.bySymbol.get(identity.baseSymbol) ?? []) {
        if (!usable(entry) || !countriesCompatible(entry.identity.country, identity.country)) continue;
        if (namesAgree(entry.identity.nameKey, identity.nameKey)) return { entry, basis: "symbol+name" };
        // Same symbol in the same country by both providers' own account: one
        // security under two spellings, or a rename (GENERAL ELECTRIC / GE AEROSPACE).
        if (entry.identity.countrySource === "provider" && identity.countrySource === "provider"
            && entry.identity.country === identity.country && entry.identity.country !== "SUPRA") {
          return { entry, basis: "symbol+country" };
        }
      }
    }
    if (identity.nameKey) {
      for (const entry of this.byName.get(identity.nameKey) ?? []) {
        if (usable(entry) && countriesCompatible(entry.identity.country, identity.country)) {
          return { entry, basis: "name" };
        }
      }
    }
    return null;
  }

  add(identity: HoldingIdentity, payload: T): Indexed<T> {
    const entry: Indexed<T> = { identity: { ...identity }, payload };
    this.entries.push(entry);
    this.index(entry);
    return entry;
  }

  /** Fill identifiers the entry lacked from another row of the same security. */
  learn(entry: Indexed<T>, other: HoldingIdentity): void {
    const known = entry.identity;
    const before = { isin: known.isin, baseSymbol: known.baseSymbol, nameKey: known.nameKey };
    if (!known.isin && other.isin) known.isin = other.isin;
    if (!known.baseSymbol && other.baseSymbol) known.baseSymbol = other.baseSymbol;
    if (!known.nameKey && other.nameKey) known.nameKey = other.nameKey;
    if ((!known.country || known.countrySource !== "provider") && other.countrySource === "provider") {
      known.country = other.country;
      known.countrySource = "provider";
    }
    if (!known.sector && other.sector) known.sector = other.sector;
    if (known.isin !== before.isin || known.baseSymbol !== before.baseSymbol || known.nameKey !== before.nameKey) {
      this.index(entry, before);
    }
  }

  private index(entry: Indexed<T>, already?: { isin: string | null; baseSymbol: string | null; nameKey: string }): void {
    const { isin, baseSymbol, nameKey } = entry.identity;
    if (isin && isin !== already?.isin && !this.byIsin.has(isin)) this.byIsin.set(isin, entry);
    if (baseSymbol && baseSymbol !== already?.baseSymbol) push(this.bySymbol, baseSymbol, entry);
    if (nameKey && nameKey !== already?.nameKey) push(this.byName, nameKey, entry);
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface AggregatedHolding {
  symbol: string | null;
  name: string | null;
  weightPct: number;
  rows: number;
}

/**
 * One fund's holdings as distinct securities: lines of the same security are
 * summed (Alphabet A and C, a share listed twice), cash and derivative lines are
 * set aside.
 */
export function aggregateHoldings(rows: HoldingRow[]): {
  matcher: HoldingMatcher<AggregatedHolding>;
  cashWeightPct: number;
  cashRows: number;
} {
  const matcher = new HoldingMatcher<AggregatedHolding>();
  let cashWeightPct = 0;
  let cashRows = 0;
  const ordered = [...rows].sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0));
  for (const row of ordered) {
    const identity = identify(row);
    const weight = row.weightPct ?? 0;
    if (identity.cash) {
      cashWeightPct += weight;
      cashRows++;
      continue;
    }
    if (!identity.isin && !identity.baseSymbol && !identity.nameKey) continue;
    const hit = matcher.find(identity);
    if (hit) {
      hit.entry.payload.weightPct += weight;
      hit.entry.payload.rows++;
      matcher.learn(hit.entry, identity);
    } else {
      matcher.add(identity, { symbol: row.holdingSymbol, name: row.holdingName, weightPct: weight, rows: 1 });
    }
  }
  return { matcher, cashWeightPct, cashRows };
}
