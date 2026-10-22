import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import {
  failureText,
  readExactStock,
  settle,
  storedRead,
  type ReadFailure,
  type Settled,
  type Stock,
} from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { etfClassification, mapWithConcurrency, toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";
import {
  countryCurrency,
  countryName,
  identify,
  listingCountry,
  majorCurrency,
  namesAgree,
  normalizeCountry,
  normalizeName,
  normalizeSector,
  type HoldingIdentity,
} from "./holdingIdentity.js";

const exposureType = z.enum(["sector", "country", "currency", "asset", "factor", "thematic"]);

const inputSchema = {
  ticker: z.string().min(1).describe("Exact Bullrun ETF listing ticker."),
  types: z.array(exposureType).min(1).max(6).default(["sector", "country", "currency", "asset"]),
  limitPerType: z.number().int().min(1).max(100).default(25),
};

const outputSchema = {
  ticker: z.string(),
  requestedTypes: z.array(exposureType),
  availableTypes: z.array(exposureType),
  unavailableTypes: z.array(exposureType),
  /** Types whose source read failed (quota, outage): unknown, not unavailable. */
  notLoadedTypes: z.array(exposureType).optional(),
  exposures: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

/** Most Bullrun lookups one call makes for positions the provider left unclassified. */
const MAX_LOOKUPS = 150;
const UNCLASSIFIED = "Unclassified";
const CASH_BUCKET = "Cash & derivatives";
const NOT_REPORTED = "Not reported";
/** Weight left unclassified because its Bullrun lookup failed (quota, outage), not for want of data. */
const LOOKUP_FAILED = "Not loaded (lookup failed)";

interface Classified {
  weight: number;
  cash: boolean;
  sector: string | null;
  country: string | null;
  currency: string | null;
  currencyBasis: "reported" | "home_listing" | "country" | null;
  sectorBasis: "provider" | "bullrun" | null;
  countryBasis: "provider" | "bullrun" | "listing" | null;
  /** No instrument was found and a lookup failed, so a missing field may be that failure. */
  lookupFailed: boolean;
}

/**
 * The Bullrun instrument a holding is, for rows whose provider gave no sector or
 * country. By ISIN where there is one; otherwise by exact symbol, accepted only
 * when the instrument's name agrees with the holding's -- a bare symbol alone is
 * a different company on another market as often as not (HBM, FM, S19). When no
 * instrument is found and any lookup failed, the failure is kept: the instrument
 * may exist, so the position is not "unclassified".
 */
async function resolve(row: EtfHolding, identity: HoldingIdentity): Promise<Settled<Stock>> {
  let failure: ReadFailure | null = null;
  if (identity.isin) {
    const matches = await settle(bullrunGet<Stock[]>("/api/stocks", {
      search: identity.isin, quoteType: "ALL", includeSecondary: true, includeInactive: true, limit: 20,
    }));
    failure = matches.failure;
    const exact = (matches.data ?? []).filter((stock) => stock.isin?.toUpperCase() === identity.isin);
    // One ISIN, many venues: the home-market line first (5713.T, not Duesseldorf's S19).
    const home = identity.country && identity.country !== "SUPRA" ? identity.country : identity.isin.slice(0, 2);
    const score = (stock: Stock) => (listingCountry(stock) === home ? 4 : 0)
      + (stock.primaryTicker == null ? 2 : 0) + (stock.sector ? 1 : 0);
    const pick = [...exact].sort((a, b) => score(b) - score(a))[0];
    if (pick) return { data: pick, failure: null };
  }
  const symbol = row.holdingSymbol?.trim().toUpperCase();
  if (!symbol || !identity.nameKey) return { data: null, failure };
  const candidates = [symbol];
  if (identity.baseSymbol && identity.baseSymbol !== symbol) candidates.push(identity.baseSymbol);
  for (const candidate of candidates) {
    const read = await readExactStock(candidate);
    failure ??= read.failure;
    const stock = read.data;
    if (!stock || !namesAgree(normalizeName(stock.company), identity.nameKey)) continue;
    const stockCountry = normalizeCountry(stock.country);
    if (identity.countrySource === "provider" && stockCountry && identity.country !== stockCountry) continue;
    return { data: stock, failure: null };
  }
  return { data: null, failure };
}

/** The bucket for a field a failed lookup left empty; null sends it to the type's own fallback. */
function notLoaded(row: Classified): string | null {
  return row.lookupFailed ? LOOKUP_FAILED : null;
}

function buckets(
  rows: Classified[],
  selector: (row: Classified) => string | null,
  fallback: string,
): Array<Record<string, unknown>> {
  const grouped = new Map<string, { weightPct: number; holdingCount: number }>();
  for (const row of rows) {
    const name = selector(row) ?? fallback;
    const current = grouped.get(name) ?? { weightPct: 0, holdingCount: 0 };
    current.weightPct += row.weight;
    current.holdingCount++;
    grouped.set(name, current);
  }
  return [...grouped.entries()]
    .map(([name, value]) => ({ name, weightPct: roundMetric(value.weightPct, 4), holdingCount: value.holdingCount }))
    .sort((a, b) => Number(b.weightPct) - Number(a.weightPct));
}

function weightWhere(rows: Classified[], predicate: (row: Classified) => boolean): number | null {
  return roundMetric(rows.reduce((sum, row) => sum + (predicate(row) ? row.weight : 0), 0), 4);
}

export function registerGetEtfExposures(server: McpServer): void {
  server.registerTool(
    "get_etf_exposures",
    {
      title: "Get ETF exposures",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Calculate sector, country, currency, and broad asset exposure from the latest stored ETF holdings. Sector and country come from the fund provider's own holdings file where it states them (normalized to Bullrun's sector and country names), otherwise from the Bullrun instrument the holding resolves to by ISIN or by symbol with a matching company name. Currency uses the reported holding currency, else an explicitly disclosed estimate from the company's home-market listing or usual country currency. This is a holding quote/listing-currency proxy, not revenue FX exposure, economic currency risk or hedge-adjusted fund exposure. Positions without a classification or currency basis are Unclassified / Not reported. Sector and currency cover all stored rows; country covers securities and excludes cash and derivatives. Coverage states complete bucket weights and any buckets omitted by limitPerType. Broad asset class comes from the normalized fund profile. Factor and thematic look-through are unavailable until dedicated source data exists. Coverage states how much fund weight was classified and how, so partial top-holdings data is never presented as full exposure. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const requestedTypes = [...new Set(args.types)];
        const enc = encodeURIComponent(ticker);
        // Every look-through type is computed from the holdings, so a failed holdings read
        // is an error, never an empty fund. The profile adds only the asset class and the
        // provider's holdings count: its failure is named and the rest still answers.
        const [holdingsResult, profileRead] = await Promise.all([
          storedRead(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`), `Holdings for ${ticker}`),
          settle(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
        ]);
        const holdings = holdingsResult ?? [];
        const profile = profileRead.data;
        const identities = holdings.map((row) => identify(row));
        // Rows the provider already classified need no lookup. The rest are looked
        // up largest first, capped: an issuer file can have thousands of lines.
        const toResolve = holdings
          .map((row, index) => ({ row, index, identity: identities[index] }))
          .filter(({ identity }) => !identity.cash && !(identity.sector && identity.countrySource === "provider"))
          .sort((a, b) => (b.row.weightPct ?? 0) - (a.row.weightPct ?? 0));
        const lookups = toResolve.slice(0, MAX_LOOKUPS);
        const found = await mapWithConcurrency(lookups, 12, ({ row, identity }) => resolve(row, identity));
        const resolved = new Array<Stock | null>(holdings.length).fill(null);
        const lookupFailure = new Array<ReadFailure | null>(holdings.length).fill(null);
        lookups.forEach(({ index }, position) => {
          resolved[index] = found[position].data;
          lookupFailure[index] = found[position].failure;
        });

        const classified: Classified[] = holdings.map((row, index) => {
          const identity = identities[index];
          const stock = resolved[index];
          const providerCountry = identity.countrySource === "provider" ? countryName(identity.country) : null;
          const bullrunSector = identity.sector ? null : normalizeSector(stock?.sector);
          const sector = identity.sector ?? bullrunSector;
          const bullrunCountry = providerCountry ? null : countryName(normalizeCountry(stock?.country));
          const listingCountryName = providerCountry || bullrunCountry || identity.countrySource !== "listing"
            ? null : countryName(identity.country);
          const country = providerCountry ?? bullrunCountry ?? listingCountryName;
          const symbol = row.holdingSymbol?.trim().toUpperCase() ?? "";
          const reported = majorCurrency(row.currency)
            ?? (identity.cash && /^[A-Z]{3}$/.test(symbol) ? symbol : null);
          // Without a reported currency, the instrument's own trading currency counts only
          // when that line is on the company's home market: a Frankfurt line of a Canadian
          // miner trades in EUR, the miner does not.
          const companyCountry = identity.countrySource === "provider"
            ? identity.country
            : normalizeCountry(stock?.country);
          const homeListing = stock != null && companyCountry != null
            && listingCountry(stock) === companyCountry;
          const fromListing = !reported && homeListing ? majorCurrency(stock?.currency) : null;
          const fromCountry = !reported && !fromListing && !identity.cash ? countryCurrency(companyCountry) : null;
          return {
            weight: row.weightPct ?? 0,
            cash: identity.cash,
            sector,
            country,
            currency: reported ?? fromListing ?? fromCountry,
            currencyBasis: reported ? "reported" : fromListing ? "home_listing" : fromCountry ? "country" : null,
            sectorBasis: identity.sector ? "provider" : bullrunSector ? "bullrun" : null,
            countryBasis: providerCountry ? "provider" : bullrunCountry ? "bullrun" : listingCountryName ? "listing" : null,
            lookupFailed: lookupFailure[index] != null,
          };
        });
        const securities = classified.filter((row) => !row.cash);

        const exposures: Record<string, unknown> = {};
        const bucketCoverage: Record<string, Record<string, unknown>> = {};
        const availableTypes: z.infer<typeof exposureType>[] = [];
        const unavailableTypes: z.infer<typeof exposureType>[] = [];
        const notLoadedTypes: z.infer<typeof exposureType>[] = [];
        const assetClass = etfClassification(profile).assetClass;
        for (const type of requestedTypes) {
          if (type === "asset" && profileRead.failure) {
            // Unknown, not unavailable: the profile that carries the asset class was not read.
            exposures[type] = null;
            notLoadedTypes.push(type);
            continue;
          }
          let values: Array<Record<string, unknown>> = [];
          if (type === "sector" && holdings.length) {
            values = buckets(classified, (row) => row.cash ? CASH_BUCKET : row.sector ?? notLoaded(row), UNCLASSIFIED);
          }
          if (type === "country" && securities.length) {
            values = buckets(securities, (row) => row.country ?? notLoaded(row), UNCLASSIFIED);
          }
          if (type === "currency" && holdings.length) {
            values = buckets(classified, (row) => row.currency ?? notLoaded(row), NOT_REPORTED);
          }
          if (type === "asset" && typeof assetClass === "string" && assetClass) {
            values = [{ name: assetClass, weightPct: 100, methodology: "fund_profile_classification" }];
          }
          const returned = values.slice(0, args.limitPerType);
          const sumWeight = (rows: Array<Record<string, unknown>>) => rows.reduce((sum, row) => sum + Number(row.weightPct ?? 0), 0);
          bucketCoverage[type] = {
            totalBuckets: values.length,
            returnedBuckets: returned.length,
            totalWeightPct: roundMetric(sumWeight(values), 4),
            returnedWeightPct: roundMetric(sumWeight(returned), 4),
            omittedWeightPct: roundMetric(sumWeight(values.slice(args.limitPerType)), 4),
          };
          exposures[type] = returned;
          (values.length ? availableTypes : unavailableTypes).push(type);
        }
        if (profileRead.failure && notLoadedTypes.length && !availableTypes.length) {
          return { isError: true, content: [{ type: "text" as const, text: `get_etf_exposures: ${failureText(`The fund profile of ${ticker}`, profileRead.failure)}` }] };
        }

        const lookThroughWeightPct = classified.reduce((sum, row) => sum + row.weight, 0);
        const reported = profile?.holdingsCount ?? null;
        const isComplete = reported == null ? null : holdings.length >= reported && lookThroughWeightPct >= 98;
        const currencyReported = weightWhere(classified, (row) => row.currencyBasis === "reported") ?? 0;
        const currencyFromListing = weightWhere(classified, (row) => row.currencyBasis === "home_listing") ?? 0;
        const currencyFromCountry = weightWhere(classified, (row) => row.currencyBasis === "country") ?? 0;
        const failedLookups = classified.filter((row) => row.lookupFailed);
        const failedLookupWeightPct = weightWhere(failedLookups, () => true);
        const warnings: string[] = [];
        if (profileRead.failure) {
          warnings.push(`${failureText(`The fund profile of ${ticker}`, profileRead.failure)} Without it the asset class and the provider-reported holdings count are unknown (not missing), so completeness is unknown too.`);
        }
        if (failedLookups.length) {
          const failure = lookupFailure.includes("quota") ? "quota" : "unavailable";
          warnings.push(`${failureText(`The Bullrun classification of ${failedLookups.length} position(s) (${failedLookupWeightPct}% of fund weight)`, failure)} Weight they leave without a sector, country or currency is shown as "${LOOKUP_FAILED}" (coverage.lookupFailures), not as ${UNCLASSIFIED} or ${NOT_REPORTED}.`);
        }
        for (const [type, detail] of Object.entries(bucketCoverage)) {
          if (Number(detail.totalBuckets) > Number(detail.returnedBuckets)) {
            warnings.push(`${type} exposures omit ${Number(detail.totalBuckets) - Number(detail.returnedBuckets)} buckets (${detail.omittedWeightPct}% of fund weight) because of limitPerType; see coverage.bucketCoverage.`);
          }
        }
        if (isComplete !== true) warnings.push("Holdings are partial or completeness is unknown; exposure weights are lower-bound look-through coverage, not a full fund allocation.");
        if (requestedTypes.includes("currency") && holdings.length && currencyReported < lookThroughWeightPct * 0.9) {
          warnings.push("This fund's holdings file does not state a currency for most positions. Where it does not, the currency shown is inferred: the company's home-market listing in Bullrun, else the usual currency of its country (see coverage.currencyBasisWeightPct). This is a holding quote/listing-currency proxy, not revenue FX exposure, economic currency risk or hedge-adjusted fund exposure; a secondary line on another exchange is never used, and positions with neither basis are \"Not reported\".");
        }
        if (toResolve.length > MAX_LOOKUPS) {
          warnings.push(`${toResolve.length - MAX_LOOKUPS} of the smallest positions had no provider classification and were not looked up; they count as Unclassified.`);
        }
        if (unavailableTypes.includes("factor")) warnings.push("Factor exposure requires dedicated factor classifications or return-regression factors, which are not stored.");
        if (unavailableTypes.includes("thematic")) warnings.push("Thematic exposure requires a dedicated taxonomy/source, which is not stored.");

        return toolResult({
          ticker,
          requestedTypes,
          availableTypes,
          unavailableTypes,
          ...(notLoadedTypes.length ? { notLoadedTypes } : {}),
          exposures,
          coverage: {
            asOfDate: holdings[0]?.asOfDate ?? null,
            source: holdings[0]?.source ?? null,
            storedHoldingRows: holdings.length,
            reportedHoldingsCount: reported,
            lookThroughWeightPct: roundMetric(lookThroughWeightPct, 4),
            bucketCoverage,
            cashAndDerivativesWeightPct: weightWhere(classified, (row) => row.cash),
            classifiedWeightPct: {
              sector: weightWhere(securities, (row) => row.sector != null),
              country: weightWhere(securities, (row) => row.country != null),
              currency: roundMetric(currencyReported + currencyFromListing + currencyFromCountry, 4),
            },
            currencyBasisWeightPct: {
              reported: currencyReported,
              homeListing: currencyFromListing,
              countryCurrency: currencyFromCountry,
              notReported: weightWhere(classified, (row) => row.currency == null && !row.lookupFailed),
            },
            // Where each classification came from, as fund weight: the provider's own
            // file, the Bullrun instrument the holding resolved to, or (country only) the
            // exchange of an aggregator's symbol. Unclassified excludes failed lookups,
            // which lookupFailures counts.
            sectorBasisWeightPct: {
              providerReported: weightWhere(securities, (row) => row.sectorBasis === "provider"),
              bullrunInstrument: weightWhere(securities, (row) => row.sectorBasis === "bullrun"),
              unclassified: weightWhere(securities, (row) => row.sectorBasis == null && !row.lookupFailed),
            },
            countryBasisWeightPct: {
              providerReported: weightWhere(securities, (row) => row.countryBasis === "provider"),
              bullrunInstrument: weightWhere(securities, (row) => row.countryBasis === "bullrun"),
              listingExchange: weightWhere(securities, (row) => row.countryBasis === "listing"),
              unclassified: weightWhere(securities, (row) => row.countryBasis == null && !row.lookupFailed),
            },
            ...(failedLookups.length
              ? {
                  lookupFailures: {
                    positions: failedLookups.length,
                    weightPct: failedLookupWeightPct,
                    notLoadedWeightPct: {
                      sector: weightWhere(failedLookups, (row) => row.sector == null),
                      country: weightWhere(failedLookups, (row) => row.country == null),
                      currency: weightWhere(failedLookups, (row) => row.currency == null),
                    },
                  },
                }
              : {}),
            isComplete,
          },
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_exposures failed: ${msg}` }] };
      }
    },
  );
}
