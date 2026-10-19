// Matching ETF holdings as securities, not symbols. Every case is a real row shape
// from prod (2026-10-19): Vanguard and iShares files carry local symbols and no ISIN,
// Amundi/Xtrackers/SPDR carry ISINs and Bullrun-resolved symbols, Yahoo carries
// exchange-qualified symbols and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateHoldings,
  countryName,
  identify,
  namesAgree,
  normalizeCountry,
  normalizeName,
  normalizeSector,
} from "../dist/tools/holdingIdentity.js";

const row = (fields) => ({ ticker: "X", asOfDate: "2026-08-31", holdingKey: fields.holdingSymbol ?? fields.holdingName, weightPct: 1, ...fields });
const vanguard = (symbol, name, country, extra = {}) =>
  row({ holdingSymbol: symbol, holdingName: name, holdingCountry: country, holdingAssetClass: "Equity", source: "ISSUER_VANGUARD", ...extra });

function overlap(rowsA, rowsB) {
  const a = aggregateHoldings(rowsA).matcher;
  const shared = [];
  const used = new Set();
  for (const entry of aggregateHoldings(rowsB).matcher.entries) {
    const hit = a.find(entry.identity, used);
    if (!hit) continue;
    used.add(hit.entry);
    shared.push({ a: hit.entry.payload.name, b: entry.payload.name, basis: hit.basis });
  }
  return shared;
}

test("a symbol shared by two companies on different markets is not an overlap", () => {
  // Vanguard S&P 500 vs Vanguard FTSE Developed Europe, as stored.
  const sp500 = [
    vanguard("ROP", "Roper Technologies Inc", "US"), vanguard("MRK", "Merck & Co Inc", "US"),
    vanguard("EQT", "EQT Corp", "US"), vanguard("HBAN", "Huntington Bancshares Inc/OH", "US"),
    vanguard("SW", "Smurfit Westrock PLC", "US"), vanguard("PRU", "Prudential Financial Inc", "US"),
    vanguard("USD", "US Dollar", "US", { holdingAssetClass: "Cash" }),
  ];
  const europe = [
    vanguard("ROP", "Roche Holding AG", "CH"), vanguard("MRK", "Merck KGaA", "DE"),
    vanguard("EQT", "EQT AB", "SE"), vanguard("HBAN", "Helvetia Baloise Holding AG", "CH"),
    vanguard("SW", "Sodexo SA", "FR"), vanguard("PRU", "Prudential PLC", "GB"),
    vanguard("USD", "US Dollar", "US", { holdingAssetClass: "Cash" }),
  ];
  assert.deepEqual(overlap(sp500, europe), []);
});

test("the same company is matched across providers, ISIN first", () => {
  const amundi = [row({ holdingSymbol: "ROP", holdingName: "ROCHE HOLDING AG - GENUSSS CHF", holdingIsin: "CH1499059983", holdingCountry: "Switzerland", source: "ISSUER_AMUNDI" })];
  const xtrackers = [row({ holdingSymbol: "RHO6", holdingName: "ROCHE HOLDING AG", holdingIsin: "CH1499059983", holdingCountry: "CH", source: "ISSUER_XTRACKERS" })];
  assert.deepEqual(overlap(amundi, xtrackers).map((s) => s.basis), ["isin"]);
  assert.deepEqual(overlap(amundi, [vanguard("ROP", "Roche Holding AG", "CH")]).map((s) => s.basis), ["symbol+name"]);
});

test("providers that disagree on a multinational's country still match it", () => {
  // iShares puts Shell and Glencore in the UK, Xtrackers in NL and AU.
  const ishares = [
    row({ holdingSymbol: "SHEL", holdingName: "SHELL", holdingCountry: "United Kingdom", source: "ISSUER_ISHARES" }),
    row({ holdingSymbol: "GLEN", holdingName: "GLENCORE PLC", holdingCountry: "Jersey", source: "ISSUER_ISHARES" }),
  ];
  const xtrackers = [
    row({ holdingSymbol: "R6C0", holdingName: "SHELL", holdingIsin: "GB00BP6MXD84", holdingCountry: "NL", source: "ISSUER_XTRACKERS" }),
    row({ holdingSymbol: "GLEN", holdingName: "GLENCORE PLC", holdingIsin: "JE00B4T3BW64", holdingCountry: "AU", source: "ISSUER_XTRACKERS" }),
  ];
  assert.equal(overlap(ishares, xtrackers).length, 2);
});

test("renames and abbreviations match on symbol within one country", () => {
  const ishares = [
    row({ holdingSymbol: "GE", holdingName: "GE AEROSPACE", holdingCountry: "United States", source: "ISSUER_ISHARES" }),
    row({ holdingSymbol: "VICI", holdingName: "VICI PPTYS INC", holdingCountry: "United States", source: "ISSUER_ISHARES" }),
  ];
  const vanguardRows = [vanguard("GE", "General Electric Co", "US"), vanguard("VICI", "VICI Properties Inc", "US")];
  assert.deepEqual(overlap(ishares, vanguardRows).map((s) => s.basis), ["symbol+country", "symbol+country"]);
});

test("a depositary receipt matches the ordinary share by name", () => {
  const yahoo = [row({ holdingSymbol: "ASML", holdingName: "ASML Holding NV ADR", source: "YAHOO_TOP_HOLDINGS" })];
  const shared = overlap(yahoo, [vanguard("ASML", "ASML Holding NV", "NL")]);
  assert.equal(shared.length, 1);
});

test("a Yahoo US line does not meet a European company with the same symbol", () => {
  const yahoo = [row({ holdingSymbol: "MRK", holdingName: "Merck & Co Inc", source: "YAHOO_TOP_HOLDINGS" })];
  assert.deepEqual(overlap(yahoo, [vanguard("MRK", "Merck KGaA", "DE")]), []);
});

test("cash, currency and derivative lines are set aside", () => {
  const { matcher, cashWeightPct } = aggregateHoldings([
    vanguard("EUR", "Euro", "XE", { holdingAssetClass: "Cash", weightPct: 0.5 }),
    row({ holdingSymbol: null, holdingName: "TRS:GOLDMAN SACHS GROUP INC USD 2028 AUG 31", holdingCountry: "US", holdingAssetClass: "Equity", weightPct: 0.03, source: "ISSUER_VANGUARD" }),
    vanguard("AAPL", "Apple Inc", "US", { weightPct: 7 }),
  ]);
  assert.equal(matcher.entries.length, 1);
  assert.ok(Math.abs(cashWeightPct - 0.53) < 1e-9);
});

test("share classes of one company merge, related companies do not", () => {
  const { matcher } = aggregateHoldings([
    vanguard("GOOGL", "Alphabet Inc", "US", { weightPct: 2 }), vanguard("GOOG", "Alphabet Inc", "US", { weightPct: 1.5 }),
    vanguard("9984", "SoftBank Group Corp", "JP"), vanguard("9434", "SoftBank Corp", "JP"),
    vanguard("HEIA", "Heineken NV", "NL"), vanguard("HEIO", "Heineken Holding NV", "NL"),
  ]);
  assert.equal(matcher.entries.length, 5);
  assert.equal(matcher.entries[0].payload.weightPct, 3.5);
});

test("names normalise possessives, initials, elision and truncation", () => {
  assert.equal(normalizeName("McDonald's Corp"), normalizeName("MCDONALDS CORP"));
  assert.equal(normalizeName("DR Horton Inc"), normalizeName("D R HORTON"));
  assert.equal(normalizeName("L'Oreal SA"), normalizeName("L OREAL S.A."));
  assert.ok(namesAgree(normalizeName("APPLIED MATERIAL INC"), normalizeName("Applied Materials Inc")));
  assert.ok(namesAgree(normalizeName("WESTINGHOUSE AIR BRAKE TECHNOLOGIE"), normalizeName("Westinghouse Air Brake Technologies Corp")));
  assert.ok(!namesAgree(normalizeName("Roper Technologies Inc"), normalizeName("Roche Holding AG")));
});

test("countries normalise from ISO, English and German, legacy codes included", () => {
  assert.equal(normalizeCountry("United Kingdom"), "GB");
  assert.equal(normalizeCountry("UK"), "GB");
  assert.equal(normalizeCountry("France"), "FR");
  assert.equal(normalizeCountry("Vereinigte Staaten von Amerika"), "US");
  assert.equal(normalizeCountry("Korea, Republic of"), "KR");
  assert.equal(normalizeCountry("Supranational"), "SUPRA");
  assert.equal(normalizeCountry("XX"), null);
  assert.equal(countryName("HK"), "Hong Kong");
  assert.equal(countryName("GB"), "United Kingdom");
});

test("issuer sectors map onto Bullrun's sector names", () => {
  assert.equal(normalizeSector("Information Technology"), "Technology");
  assert.equal(normalizeSector("Health Care"), "Healthcare");
  assert.equal(normalizeSector("Consumer Discretionary"), "Consumer Cyclical");
  assert.equal(normalizeSector("Corporates"), "Corporates");
  assert.equal(normalizeSector("Unknown"), null);
  assert.equal(identify(row({ holdingSymbol: "X", holdingName: "Cash", holdingSector: "Cash and/or Derivatives" })).cash, true);
});
