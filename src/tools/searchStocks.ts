import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { discoveryIdentity, discoveryRows, exchangeMatches, sameText, suffixRootMatches, validIsin, yahooAlternative, type DiscoveryStock } from "./stockDiscoveryData.js";
import { listingCountry, normalizeCountry } from "./holdingIdentity.js";

const SCAN_LIMIT = 500;
const TIMEOUT_MS = 6_000;

/**
 * Whether a listing trades on its issuer's home market: the venue's country (from the
 * stored exchange, else the ticker suffix) is the company's stored country, else its
 * ISIN's. Hong Kong counts as home for mainland Chinese issuers, whose H shares list there.
 */
function onHomeVenue(row: DiscoveryStock): boolean {
  const venue = listingCountry(row) ?? listingCountry({ ticker: row.ticker, exchange: null });
  const home = normalizeCountry(row.country) ?? normalizeCountry(row.isin?.slice(0, 2));
  return venue != null && home != null && (venue === home || home === "CN" && venue === "HK");
}

/**
 * Among candidates that share an ISIN, the home-venue listing takes the group's best
 * place: Harmonic Drive's 6324.T before Frankfurt's K3R, although K3R's provider label
 * "HARMONIC DRIVE" is the exact name. Within each part the given order holds, and rows
 * with no home-venue sibling keep their positions.
 */
function homeVenueFirst(rows: DiscoveryStock[]): DiscoveryStock[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const isin = row.isin?.trim().toUpperCase();
    if (isin) groups.set(isin, [...(groups.get(isin) ?? []), index]);
  });
  const out = rows.slice();
  for (const positions of groups.values()) {
    const members = positions.map(index => rows[index]);
    const home = members.filter(onHomeVenue);
    if (!home.length || home.length === members.length) continue;
    const ordered = [...home, ...members.filter(row => !home.includes(row))];
    positions.forEach((position, index) => { out[position] = ordered[index]; });
  }
  return out;
}

export function registerSearchStocks(server: McpServer): void {
  server.registerTool("search_stocks", {
    title: "Find stock tickers and company listings",
    annotations: { readOnlyHint: true },
    description: "Resolve a company name, native ticker, ISIN or exchange-qualified symbol to Bullrun listings before calling exact-ticker research tools. Supports exchange/MIC, country, currency and instrument-type filters. Recognized Yahoo suffixes are checked against compatible stored venues; dots in native share-class tickers are preserved. Returns explicit ambiguous candidates and never picks a listing when alternatives remain. No enrichment or market-data refresh. Read-only.",
    inputSchema: {
      query: z.string().trim().min(1).max(120).describe("Company/name phrase, exact native ticker (AAPL, BMW, BRK.B), ISIN, EXCHANGE:TICKER, or Yahoo symbol (BMW.DE, NESN.SW)."),
      exchange: z.string().trim().min(1).max(60).optional().describe("Stored exchange code or supported MIC, e.g. XETRA/XETR, NASDAQ/XNAS, SW/XSWX. A conflicting prefix is rejected."),
      country: z.string().trim().min(1).max(80).optional().describe("Exact stored country name, e.g. Germany or Switzerland."),
      currency: z.string().trim().min(1).max(12).optional().describe("Listing quote currency, e.g. USD, CHF or GBX. GBX and GBP are different quote units."),
      quoteType: z.enum(["EQUITY", "ETF", "ALL"]).default("EQUITY").describe("Default stocks, including unclassified equities. ETF/ALL allow other instrument lookup; this does not make stock-only research tools valid for funds."),
      includeSecondary: z.boolean().default(true).describe("Include alternative venue listings. ISIN/name matches across venues require an explicit listing choice."),
      includeInactive: z.boolean().default(false).describe("Include inactive/retired listings. Returned lifecycle/successor fields must be checked."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum output candidates. A backend scan is capped at 500 candidates per search."),
    },
  }, async args => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text" as const, text: 'search_stocks requires the "read:market" scope.' }] }; }
    try {
      let query = args.query.trim().replace(/\s+/g, " ");
      let exchange = args.exchange;
      const prefixed = /^([A-Z0-9][A-Z0-9_-]{1,23}):([^:]+)$/i.exec(query);
      if (prefixed) {
        if (exchange && !exchangeMatches(prefixed[1], exchange)) {
          return { isError: true, content: [{ type: "text" as const, text: "The exchange prefix conflicts with the exchange filter. Use one matching venue." }] };
        }
        exchange = exchange ?? prefixed[1];
        query = prefixed[2].trim();
      }
      const upper = query.toUpperCase();
      const currency = args.currency?.toUpperCase();
      const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(upper);
      if (isin && !validIsin(upper)) return { isError: true, content: [{ type: "text" as const, text: "The ISIN check digit is invalid. Check the identifier and retry." }] };
      const searches: Array<{ search: string; returned: number; mayBeTruncated: boolean }> = [];
      const search = async (term: string) => {
        const rows = discoveryRows(await bullrunGet<unknown>("/api/stocks", {
          search: term, quoteType: args.quoteType, includeSecondary: args.includeSecondary,
          includeInactive: args.includeInactive, country: args.country, currency, limit: SCAN_LIMIT,
        }, TIMEOUT_MS));
        searches.push({ search: term, returned: rows.length, mayBeTruncated: rows.length >= SCAN_LIMIT });
        return rows.filter(row => (!exchange || exchangeMatches(row.exchange, exchange))
          && (!args.country || sameText(row.country, args.country))
          && (!currency || sameText(row.currency, currency))
          && (args.includeSecondary || !row.primaryTicker)
          && (args.includeInactive || row.lifecycleStatus == null || ["ACTIVE", "RENAMED"].includes(row.lifecycleStatus.toUpperCase()))
          && (args.quoteType === "ALL" || sameText(row.quoteType, args.quoteType) || args.quoteType === "EQUITY" && row.quoteType == null));
      };
      let rows = await search(query);
      const nativeExact = rows.filter(row => sameText(row.ticker, upper));
      const suffix = nativeExact.length ? null : yahooAlternative(upper);
      let usedSuffix = false;
      if (suffix) {
        const alternatives = (await Promise.all(suffix.searches.map(search))).flat()
          .filter(row => suffixRootMatches(row.ticker, suffix.root)
            && suffix.venues.some(venue => sameText(row.exchange, venue)));
        if (alternatives.length) { rows = alternatives; usedSuffix = true; }
      }
      const unique = [...new Map(rows.map(row => [row.ticker.toUpperCase(), row])).values()];
      const isinMatches = (row: DiscoveryStock) => sameText(row.isin, upper) || sameText(row.fundIsin, upper);
      const exact = unique.filter(row => isin ? isinMatches(row) : sameText(row.ticker, upper));
      // Provider company labels vary by venue ("HARMONIC DRIVE" versus
      // "Harmonic Drive Systems Inc."). An exact name is a ranking hint, not
      // evidence that other returned listings are unrelated or unavailable.
      const candidates: DiscoveryStock[] = exact.length ? exact : unique;
      const truncatedScan = searches.some(entry => entry.mayBeTruncated);
      const ranked = homeVenueFirst(candidates.slice().sort((a, b) => Number(sameText(b.company, query)) - Number(sameText(a.company, query))
        || Number(Boolean(a.primaryTicker)) - Number(Boolean(b.primaryTicker))
        || a.ticker.localeCompare(b.ticker)));
      // A single fuzzy, name or suffix suggestion is still a suggestion. Only a
      // unique exact native ticker/ISIN can establish an unambiguous listing.
      const resolved = exact.length === 1 && !usedSuffix && (!isin || !truncatedScan)
        && !["RENAMED", "DELISTED", "OUT_OF_SCOPE"].includes(exact[0].lifecycleStatus?.toUpperCase() ?? "") ? exact[0].ticker : null;
      return toolResult({
        query: args.query, normalizedQuery: query, retrievedAt: new Date().toISOString(),
        status: resolved ? "resolved" : ranked.length > 1 ? "ambiguous" : ranked.length ? "candidate" : "not_found",
        resolvedTicker: resolved, candidateCount: ranked.length, returnedCount: Math.min(ranked.length, args.limit),
        candidates: ranked.slice(0, args.limit).map(row => ({ ...discoveryIdentity(row),
          match: usedSuffix ? "venue_checked_yahoo_alternative" : isin && isinMatches(row) ? "exact_isin"
            : sameText(row.ticker, upper) ? "exact_native_ticker" : sameText(row.company, query) ? "exact_company_name" : "name_or_symbol_search" })),
        filters: { exchange: exchange ?? null, country: args.country ?? null, currency: currency ?? null,
          quoteType: args.quoteType, includeSecondary: args.includeSecondary, includeInactive: args.includeInactive },
        coverage: { searches, mayBeTruncated: truncatedScan || ranked.length > args.limit, completeUniverse: false },
        methodology: { suffix: usedSuffix ? { input: upper, root: suffix?.root, compatibleVenues: suffix?.venues } : null,
          resolution: "Only one exact native ticker or one exact ISIN listing is resolved. Name and Yahoo-format alternatives require confirmation of the intended listing; multiple venues/share classes remain alternatives.",
          ordering: "Exact company names first, then primary listings, then ticker. Among listings that share an ISIN, the one on the issuer's home market comes first (Hong Kong counts as home for mainland Chinese issuers); other rows keep their place.",
          classification: "Null quoteType is an unclassified equity in the backend, not proof of equity classification. Missing identifiers and lifecycle fields are unknown." },
        warnings: [
          ...(usedSuffix ? ["The Yahoo suffix was interpreted using compatible stored exchange codes. Verify the returned company, share class, exchange and currency before choosing a native ticker."] : []),
          ...(truncatedScan ? ["A search reached its 500-candidate backend cap. Other listings may exist; add a more specific name, country or exchange filter."] : []),
          ...(ranked.length > args.limit ? ["Additional candidates were omitted from the output. Increase limit or narrow the query before choosing a listing."] : []),
          ...(ranked.length ? [] : ["No matching stored listing was found in this bounded lookup. This does not prove the security does not exist."]),
          "ISIN identifies a security/share class, not necessarily a unique trading venue. Alternative venue listings of the same security are not diversification.",
        ],
      });
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Stock lookup could not be loaded. Check the query/filters and retry; no enrichment was started." }] };
    }
  });
}
