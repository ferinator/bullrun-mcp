/**
 * Shared Global Markets plumbing: the overview payload type, the macro indicators it carries
 * per country, and the map from a human instrument name ("S&P 500", "Brent", "Fed") to the
 * `macro_series` code that `/api/markets/history` serves. Every `/api/markets/*` endpoint is
 * quota-free in bullrun-api, so these tools cost the caller nothing.
 */
import { bullrunGet } from "../bullrun.js";

export interface CountryValue { country: string; growthPct: number | null; period: string | null; source: string | null }

export interface MarketsOverview {
  asOf: string;
  metrics: Array<{ key: string; label: string; value: string; changePct: number | null; changeLabel: string | null; sub: string | null; tone: string | null; spark?: number[] }>;
  indices: Array<{ name: string; region: string | null; currency: string | null; price: number | null; changePct: number | null; trend?: number[]; proxy?: boolean }>;
  centralBanks: Array<{ bank: string; code: string; ratePct: number | null; changeBps: number | null; trend?: number[] }>;
  commodities: Array<{ name: string; price: number | null; changePct: number | null; trend?: number[] }>;
  currencies: Array<{ pair: string; price: number | null; changePct: number | null }>;
  yields: Array<{ name: string; yieldPct: number | null; changeBps: number | null; asOf: string | null; spreadBps: number | null; anchor: string | null; seriesCode: string | null; frequency: string | null }>;
  calendar: CalendarEvent[];
  rateDecisions: CalendarEvent[];
  news: NewsItem[];
  usHousing: {
    asOf: string | null; tilt: string | null; headline: string | null; headlineNote: string | null;
    rows: Array<{ key: string; label: string; value: string; basis: string | null; delta: number | null; deltaUnit: string | null; tilt: string | null; period: string | null; seriesCode: string | null }>;
  } | null;
  gdpYear?: number | null;
  gdpQuarter?: string | null;
  [key: string]: unknown;
}

export interface CalendarEvent {
  date: string; time: string | null; event: string; countryCode: string | null; impact: string | null;
  actual: string | null; forecast: string | null; previous: string | null;
}

export interface NewsItem { headline: string; minutesAgo: number | null; source: string | null; url: string | null }

export function fetchOverview(): Promise<MarketsOverview> {
  return bullrunGet<MarketsOverview>("/api/markets/overview");
}

/** One per-country macro indicator carried by the overview (its `*Map` array). */
export interface IndicatorSpec {
  mapKey: string;
  label: string;
  unit: string;
  /** Which end is the "worse" reading, so rankings can say what top means. */
  higherIs: "better" | "worse" | "neutral";
  /** `/api/markets/history` code for one country. */
  historyCode: (country: string) => string;
  note?: string;
}

export const INDICATORS: Record<string, IndicatorSpec> = {
  gdp_growth: {
    mapKey: "gdpMap", label: "Real GDP growth, latest broadly covered year", unit: "% YoY", higherIs: "better",
    historyCode: (c) => `GDP_GROWTH:${c}`, note: "World Bank annual; lags the calendar year. Use gdp_growth_quarterly for fresher data.",
  },
  gdp_growth_quarterly: {
    mapKey: "gdpMapQuarterly", label: "Real GDP growth, latest reported quarter", unit: "% YoY", higherIs: "better",
    historyCode: (c) => `GDP_GROWTH_Q:${c}`, note: "OECD primary with official fallbacks; ~45 economies.",
  },
  inflation: {
    mapKey: "inflationMap", label: "Consumer price inflation, latest", unit: "% YoY", higherIs: "worse",
    historyCode: (c) => (c === "United States" ? "BLS_US_CPI_YOY" : `CPI_INFLATION:${c}`), note: "Period varies by country; check each row's period.",
  },
  government_debt: {
    mapKey: "debtMap", label: "General government gross debt", unit: "% of GDP", higherIs: "worse",
    historyCode: (c) => `DEBT_GDP:${c}`, note: "IMF.",
  },
  unemployment: {
    mapKey: "jobsMap", label: "Unemployment rate", unit: "%", higherIs: "worse",
    historyCode: (c) => `UNEMPLOYMENT:${c}`,
  },
  youth_unemployment: {
    mapKey: "youthMap", label: "Youth unemployment, ages 15-24", unit: "%", higherIs: "worse",
    historyCode: (c) => `UNEMPLOYMENT_YOUTH:${c}`,
  },
  real_house_prices: {
    mapKey: "housingMap", label: "Real house prices", unit: "% YoY", higherIs: "neutral",
    historyCode: (c) => `HOUSE_PRICE_REAL_YOY:${c}`, note: "BIS.",
  },
  house_price_to_income: {
    mapKey: "houseIncomeMap", label: "House price-to-income vs long-run average", unit: "% deviation", higherIs: "worse",
    historyCode: (c) => `HOUSE_PRICE_TO_INCOME_DEV:${c}`, note: "OECD; positive = less affordable than the country's own norm.",
  },
  house_price_to_rent: {
    mapKey: "houseRentMap", label: "House price-to-rent vs long-run average", unit: "% deviation", higherIs: "worse",
    historyCode: (c) => `HOUSE_PRICE_TO_RENT_DEV:${c}`, note: "OECD; positive = prices stretched relative to rents.",
  },
  credit_gap: {
    mapKey: "creditMap", label: "Credit-to-GDP gap vs long-run trend", unit: "pp", higherIs: "worse",
    historyCode: (c) => `CREDIT_GAP:${c}`, note: "BIS early-warning indicator; above ~10pp has historically preceded banking stress.",
  },
  household_debt_service: {
    mapKey: "householdDsrMap", label: "Household debt service ratio", unit: "% of income", higherIs: "worse",
    historyCode: (c) => `DSR_HOUSEHOLD:${c}`, note: "BIS.",
  },
  household_credit: {
    mapKey: "householdCreditMap", label: "Household credit", unit: "% of GDP", higherIs: "worse",
    historyCode: (c) => `CREDIT_HOUSEHOLD_GDP:${c}`, note: "BIS.",
  },
  business_confidence: {
    mapKey: "businessConfMap", label: "Business confidence", unit: "index, 100 = own long-run average", higherIs: "better",
    historyCode: (c) => `BUSINESS_CONFIDENCE:${c}`, note: "OECD amplitude-adjusted.",
  },
  consumer_confidence: {
    mapKey: "consumerConfMap", label: "Consumer confidence", unit: "index, 100 = own long-run average", higherIs: "better",
    historyCode: (c) => `CONSUMER_CONFIDENCE:${c}`, note: "OECD amplitude-adjusted.",
  },
  macro_stress: {
    mapKey: "stressMap", label: "Bullrun macro stress score", unit: "0-100, higher = more stress", higherIs: "worse",
    historyCode: (c) => `STRESS:${c}`, note: "Composite of six pillars (labour, housing, credit, fiscal, external, cycle); use get_country_macro for the breakdown.",
  },
};

export const INDICATOR_KEYS = Object.keys(INDICATORS) as [string, ...string[]];

/** Headline tiles on the dashboard → their history series (mirrors the GUI's METRIC_HISTORY). */
const METRIC_HISTORY: Record<string, string> = {
  gdp: "WB_WLD_GDP",
  inflation: "OECD_CPI_YOY",
  debt: "IMF_WLD_DEBT",
  brent: "DCOILBRENTEU",
  wti: "DCOILWTICO",
  gold: "YAHOO_GC_F",
  dxy: "YAHOO_DXY",
  us10y: "DGS10",
  curve: "T10Y2Y",
  vix: "YAHOO_VIX",
  eurusd: "DEXUSEU",
  btc: "YAHOO_BTC_USD",
};

const CENTRAL_BANK_HISTORY: Record<string, string> = {
  US: "BIS_CBPOL_US",
  EU: "BIS_CBPOL_XM",
  GB: "BIS_CBPOL_GB",
  JP: "BIS_CBPOL_JP",
  CH: "BIS_CBPOL_CH",
  CA: "BIS_CBPOL_CA",
};

const COMMODITY_HISTORY: Record<string, string> = {
  "Brent Oil": "DCOILBRENTEU",
  "WTI Oil": "DCOILWTICO",
  "Natural Gas": "DHHNGSP",
  Gold: "YAHOO_GC_F",
  Copper: "YAHOO_HG_F",
};

const CURRENCY_HISTORY: Record<string, string> = {
  "EUR/USD": "DEXUSEU",
  "USD/JPY": "DEXJPUS",
  "USD/CNY": "DEXCHUS",
  "GBP/USD": "DEXUSUK",
  "USD/CAD": "DEXCAUS",
  "AUD/USD": "DEXUSAL",
  "USD/CHF": "DEXSZUS",
  "USD/HKD": "YAHOO_HKD_X",
  "USD/SGD": "YAHOO_SGD_X",
  "USD/INR": "DEXINUS",
  "EUR/GBP": "YAHOO_EURGBP_X",
  "USD/KRW": "DEXKOUS",
  "USD/MXN": "DEXMXUS",
  "NZD/USD": "DEXUSNZ",
  "USD/TWD": "YAHOO_TWD_X",
  "USD/SEK": "YAHOO_SEK_X",
  "EUR/JPY": "YAHOO_EURJPY_X",
  "EUR/CHF": "YAHOO_EURCHF_X",
  "USD/BRL": "DEXBZUS",
  "USD/NOK": "YAHOO_NOK_X",
};

const INDEX_HISTORY: Record<string, string> = {
  "S&P 500": "YAHOO_GSPC",
  "Nasdaq-100": "YAHOO_NDX",
  "Dow Jones": "YAHOO_DJI",
  "Russell 2000": "YAHOO_RUT",
  "MSCI World": "YAHOO_URTH",
  "MSCI ACWI": "YAHOO_ACWI",
  "FTSE All-World": "YAHOO_VT",
  "FTSE 100": "YAHOO_FTSE",
  DAX: "YAHOO_GDAXI",
  "CAC 40": "YAHOO_FCHI",
  "Euro Stoxx 50": "YAHOO_STOXX50E",
  "STOXX Europe 600": "YAHOO_STOXX",
  SMI: "YAHOO_SSMI",
  "Nikkei 225": "YAHOO_N225",
  TOPIX: "YAHOO_1306_T",
  "Hang Seng": "YAHOO_HSI",
  "CSI 300": "YAHOO_000300_SS",
  "Nifty 50": "YAHOO_NSEI",
  Sensex: "YAHOO_BSESN",
};

/** 10Y sovereign yields on the bonds card (daily CNBC bars). */
const YIELD_COUNTRIES: Record<string, string> = {
  "United States": "US", Germany: "DE", Japan: "JP", "United Kingdom": "GB", France: "FR", Italy: "IT",
  China: "CN", Canada: "CA", Brazil: "BR", "South Korea": "KR", Australia: "AU", Spain: "ES",
  Mexico: "MX", Indonesia: "ID", Netherlands: "NL", Switzerland: "CH",
};

const ALIASES: Record<string, string> = {
  "fed": "BIS_CBPOL_US", "federal reserve": "BIS_CBPOL_US", "fed funds": "BIS_CBPOL_US",
  "ecb": "BIS_CBPOL_XM", "european central bank": "BIS_CBPOL_XM",
  "boe": "BIS_CBPOL_GB", "bank of england": "BIS_CBPOL_GB",
  "boj": "BIS_CBPOL_JP", "bank of japan": "BIS_CBPOL_JP",
  "snb": "BIS_CBPOL_CH", "swiss national bank": "BIS_CBPOL_CH",
  "boc": "BIS_CBPOL_CA", "bank of canada": "BIS_CBPOL_CA",
  "brent": "DCOILBRENTEU", "wti": "DCOILWTICO", "oil": "DCOILBRENTEU", "natural gas": "DHHNGSP",
  "gold": "YAHOO_GC_F", "copper": "YAHOO_HG_F", "bitcoin": "YAHOO_BTC_USD", "btc": "YAHOO_BTC_USD",
  "vix": "YAHOO_VIX", "dxy": "YAHOO_DXY", "dollar index": "YAHOO_DXY",
  "us 2s10s": "T10Y2Y", "2s10s": "T10Y2Y", "yield curve": "T10Y2Y", "us yield curve": "T10Y2Y",
  "spx": "YAHOO_GSPC", "sp500": "YAHOO_GSPC", "s&p": "YAHOO_GSPC", "nasdaq": "YAHOO_NDX", "dow": "YAHOO_DJI",
  "nikkei": "YAHOO_N225", "ftse": "YAHOO_FTSE", "stoxx 50": "YAHOO_STOXX50E", "hang seng": "YAHOO_HSI",
  "global gdp": "WB_WLD_GDP", "world gdp": "WB_WLD_GDP", "global inflation": "OECD_CPI_YOY",
  "global debt": "IMF_WLD_DEBT", "us cpi": "BLS_US_CPI_YOY", "us inflation": "BLS_US_CPI_YOY",
};

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Every named instrument the history tool understands, for discovery and error messages. */
export function historyCatalog(): Record<string, Record<string, string>> {
  const yields: Record<string, string> = {};
  for (const [country, cc] of Object.entries(YIELD_COUNTRIES)) yields[`${country} 10Y`] = `CNBC_${cc}10Y`;
  const banks: Record<string, string> = {};
  for (const [cc, code] of Object.entries(CENTRAL_BANK_HISTORY)) banks[cc] = code;
  return {
    headline: { ...METRIC_HISTORY },
    indices: { ...INDEX_HISTORY },
    commodities: { ...COMMODITY_HISTORY },
    currencies: { ...CURRENCY_HISTORY },
    centralBankPolicyRates: banks,
    yields10y: yields,
  };
}

/** Resolve a free-text instrument name to a history code, or null. Exact codes pass through. */
export function resolveInstrument(query: string): string | null {
  const q = norm(query);
  if (!q) return null;
  if (ALIASES[q]) return ALIASES[q];
  const tables = [INDEX_HISTORY, COMMODITY_HISTORY, CURRENCY_HISTORY, METRIC_HISTORY];
  for (const table of tables) {
    for (const [name, code] of Object.entries(table)) {
      if (norm(name) === q || norm(code) === q) return code;
    }
  }
  const pair = q.replace(/\s/g, "").toUpperCase();
  if (/^[A-Z]{6}$/.test(pair)) {
    const slashed = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    if (CURRENCY_HISTORY[slashed]) return CURRENCY_HISTORY[slashed];
  }
  const cb = CENTRAL_BANK_HISTORY[query.trim().toUpperCase()];
  if (cb) return cb;
  const yieldMatch = q.match(/^(.+?)\s*10\s*-?y(ear)?( yield)?$/);
  if (yieldMatch) {
    const who = yieldMatch[1].trim();
    for (const [country, cc] of Object.entries(YIELD_COUNTRIES)) {
      if (norm(country) === who || cc.toLowerCase() === who || (who === "us" && cc === "US") || (who === "uk" && cc === "GB")) {
        return `CNBC_${cc}10Y`;
      }
    }
  }
  return null;
}

export function historyCodeForIndex(name: string): string | null { return INDEX_HISTORY[name] ?? null; }
export function historyCodeForCommodity(name: string): string | null { return COMMODITY_HISTORY[name] ?? null; }
export function historyCodeForCurrency(pair: string): string | null { return CURRENCY_HISTORY[pair] ?? null; }
export function historyCodeForCentralBank(code: string): string | null { return CENTRAL_BANK_HISTORY[code] ?? null; }
export function historyCodeForMetric(key: string): string | null { return METRIC_HISTORY[key] ?? null; }

/** Case/whitespace-insensitive country match ("united states" == "United States"). */
export function sameCountry(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

const COUNTRY_ALIASES: Record<string, string> = {
  "us": "United States", "usa": "United States", "u.s.": "United States", "united states of america": "United States", "america": "United States",
  "uk": "United Kingdom", "u.k.": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom",
  "korea": "South Korea", "republic of korea": "South Korea", "eurozone": "Euro Area", "euro zone": "Euro Area", "euro area": "Euro Area",
  "czech republic": "Czechia", "turkiye": "Turkey", "türkiye": "Turkey", "russian federation": "Russia", "ivory coast": "Côte d'Ivoire",
  "uae": "United Arab Emirates", "holland": "Netherlands", "drc": "Dem. Rep. Congo",
};

/** Every country name any overview indicator carries, as the API spells it. */
export function overviewCountries(overview: MarketsOverview): string[] {
  const names = new Set<string>();
  for (const spec of Object.values(INDICATORS)) {
    for (const row of (overview[spec.mapKey] as CountryValue[] | undefined) ?? []) {
      if (row?.country) names.add(row.country);
    }
  }
  return [...names].sort();
}

/**
 * The API's own spelling for a country the user typed. bullrun-api matches country names
 * exactly ("germany" scores as an unknown country), so resolve against the names the
 * overview actually carries, then common aliases. Returns the input trimmed if nothing
 * matches, so the API can still answer with its "insufficient" payload.
 */
export function canonicalCountry(input: string, known: string[]): string {
  const q = norm(input);
  const direct = known.find((k) => norm(k) === q);
  if (direct) return direct;
  const alias = COUNTRY_ALIASES[q];
  if (alias) return known.find((k) => norm(k) === norm(alias)) ?? alias;
  return input.trim();
}
