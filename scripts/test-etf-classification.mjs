// Per-listing ETF classification, as compare_etfs, search_etfs and get_etf_snapshot
// state it. An MCP review on 2026-10-19 found them publishing the raw asset_class --
// iShares MSCI Brazil Dist read "Brazil" on IDBZ.L and "EXCHANGE TRADED FUNDS - PASSIV"
// on IQQB.DE while get_etf_fund called the fund Equity. Profiles are prod rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { etfClassification, etfSummary } from "../dist/tools/etfData.js";

const profile = (fields) => ({ ticker: "X", fundName: "x", category: null, assetClass: null, ...fields });

test("every venue of one fund reads as the fund's asset class", () => {
  const venues = [
    profile({ ticker: "IDBZ.L", assetClass: "Brazil", category: "Equity", assetClassLabel: "Equity", categoryLabel: null }),
    profile({ ticker: "IQQB.DE", assetClass: "EXCHANGE TRADED FUNDS - PASSIV", category: "Equity", assetClassLabel: "Equity", categoryLabel: null }),
    profile({ ticker: "IBZL.AS", assetClass: "Equity", category: "Equity", assetClassLabel: "Equity", categoryLabel: null }),
  ];
  for (const venue of venues) {
    const classification = etfClassification(venue);
    assert.equal(classification.assetClass, "Equity", venue.ticker);
    assert.equal(classification.category, null, venue.ticker);
    assert.equal("focus" in classification, false);
  }
});

test("the provider's raw columns are kept, flagged, only where they differ", () => {
  const raw = etfClassification(profile({ assetClass: "Brazil", category: "Equity", assetClassLabel: "Equity", categoryLabel: null }));
  assert.deepEqual(raw.providerClassification, { assetClass: "Brazil", category: "Equity" });
  const same = etfClassification(profile({ assetClass: "Equity", category: "Large Blend", assetClassLabel: "Equity", categoryLabel: "Large Blend" }));
  assert.deepEqual(same, { assetClass: "Equity", category: "Large Blend" });
});

test("a non-answer stays unanswered rather than echoing the raw value", () => {
  // ZGLD.SW before V185: asset_class "Other", no category.
  const gold = etfClassification(profile({ assetClass: "Other", assetClassLabel: null, categoryLabel: null }));
  assert.equal(gold.assetClass, null);
  assert.deepEqual(gold.providerClassification, { assetClass: "Other", category: null });
});

test("without a profile the listing's sector is used; an older API's raw columns are read", () => {
  assert.deepEqual(etfClassification(null, { sector: "Fixed Income" }), { assetClass: "Fixed Income", category: null });
  // No label keys at all: the API predates them.
  assert.deepEqual(etfClassification(profile({ assetClass: "Equity", category: "Large Blend" })),
    { assetClass: "Equity", category: "Large Blend" });
});

test("search_etfs rows carry the normalised class, not focus", () => {
  const row = { ticker: "IQQB.DE", company: "iShares MSCI Brazil", exchange: "XETRA", currency: "EUR",
    sector: "Equity", industry: "EXCHANGE TRADED FUNDS - PASSIV", country: "Ireland", isin: "IE00B0M63516", primaryTicker: null };
  const summary = etfSummary(row, profile({ ticker: "IQQB.DE", assetClass: "EXCHANGE TRADED FUNDS - PASSIV", category: "Equity",
    assetClassLabel: "Equity", categoryLabel: null }));
  assert.equal(summary.assetClass, "Equity");
  assert.equal("focus" in summary, false);
  assert.equal(summary.providerClassification.assetClass, "EXCHANGE TRADED FUNDS - PASSIV");
});
