import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requirePublicScope } from "../auth/scopes.js";
import {
  failureText,
  NOT_REQUESTED,
  readFailure,
  settle,
  storedRead,
  type ReadFailure,
  type Settled,
  type Stock,
} from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { etfClassification, toolResult, type EtfHolding } from "./etfData.js";
import {
  readHoldingIdentityBatch,
  readPublicEtfHoldings,
  readPublicEtfProfile,
  type HoldingIdentityBatch,
} from "./etfPublicReads.js";
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
  // Fresh enums: a reused zod schema is emitted as a $ref.
  requestedTypes: z.array(z.enum(exposureType.options)),
  availableTypes: z.array(z.enum(exposureType.options)),
  unavailableTypes: z.array(z.enum(exposureType.options)),
  /** Types whose source read failed (quota, outage): unknown, not unavailable. */
  notLoadedTypes: z.array(z.enum(exposureType.options)).optional(),
  exposures: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

/** Maximum distinct holding identities enriched in one bounded backend batch. */
const MAX_LOOKUPS = 150;
const BATCH_TICKER = /^[A-Z0-9^][A-Z0-9.^=_&/@ -]{0,79}$/;
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
function symbols(row: EtfHolding, identity: HoldingIdentity): string[] {
  const symbol = row.holdingSymbol?.trim().toUpperCase();
  if (!symbol || !identity.nameKey) return [];
  return [...new Set([symbol, identity.baseSymbol].filter((value): value is string => !!value && BATCH_TICKER.test(value)))];
}

function resolve(row: EtfHolding, identity: HoldingIdentity, batch: Settled<HoldingIdentityBatch>): Settled<Stock> {
  if (identity.isin) {
    const exact = (batch.data?.isinMatches[identity.isin] ?? [])
      .filter((stock) => stock.isin?.toUpperCase() === identity.isin);
    // One ISIN, many venues: the home-market line first (5713.T, not Duesseldorf's S19).
    const home = identity.country && identity.country !== "SUPRA" ? identity.country : identity.isin.slice(0, 2);
    const score = (stock: Stock) => (listingCountry(stock) === home ? 4 : 0)
      + (stock.primaryTicker == null ? 2 : 0) + (stock.sector ? 1 : 0);
    const pick = [...exact].sort((a, b) => score(b) - score(a))[0];
    if (pick) return { data: pick, failure: null };
  }
  const candidates = symbols(row, identity);
  for (const candidate of candidates) {
    const stock = batch.data?.tickerMatches[candidate];
    // A retired symbol's successor is not an exact holding match by symbol alone.
    if (!stock || stock.ticker?.toUpperCase() !== candidate || !namesAgree(normalizeName(stock.company), identity.nameKey)) continue;
    const stockCountry = normalizeCountry(stock.country);
    if (identity.countrySource === "provider" && stockCountry && identity.country !== stockCountry) continue;
    return { data: stock, failure: null };
  }
  return { data: null, failure: identity.isin || candidates.length ? batch.failure : null };
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
        const lookThrough = requestedTypes.some(type => ["sector", "country", "currency"].includes(type));
        const needsProfile = lookThrough || requestedTypes.includes("asset");
        // Every look-through type is computed from the holdings, so a failed holdings read
        // is an error, never an empty fund. The profile adds only the asset class and the
        // provider's holdings count: its failure is named and the rest still answers.
        const [holdingsResult, profileRead] = await Promise.all([
          lookThrough ? storedRead(readPublicEtfHoldings(ticker), `Holdings for ${ticker}`) : Promise.resolve(null),
          needsProfile ? settle(readPublicEtfProfile(ticker)) : Promise.resolve(NOT_REQUESTED),
        ]);
        const holdings = holdingsResult ?? [];
        const profile = profileRead.data;
        const identities = holdings.map((row) => identify(row));
        // Only requested missing fields need enrichment. Fully provider-classified rows
        // retain the existing country-currency fallback when no currency was reported.
        const toResolve = holdings
          .map((row, index) => ({ row, index, identity: identities[index] }))
          .filter(({ row, identity }) => !identity.cash && (
            (requestedTypes.includes("sector") && !identity.sector)
            || (requestedTypes.includes("country") && identity.countrySource !== "provider")
            || (requestedTypes.includes("currency") && !majorCurrency(row.currency)
              && !(identity.sector && identity.countrySource === "provider"))
          ))
          .sort((a, b) => (b.row.weightPct ?? 0) - (a.row.weightPct ?? 0));
        const key = ({ row, identity }: typeof toResolve[number]) => JSON.stringify([
          identity.isin, symbols(row, identity), identity.nameKey, identity.country, identity.countrySource,
        ]);
        const canResolve = ({ row, identity }: typeof toResolve[number]) => !!identity.isin || symbols(row, identity).length > 0;
        const distinct = new Map<string, typeof toResolve[number]>();
        for (const holding of toResolve) if (canResolve(holding) && !distinct.has(key(holding))) distinct.set(key(holding), holding);
        const unique = [...distinct.values()];
        const lookups = unique.slice(0, MAX_LOOKUPS);
        const isins = [...new Set(lookups.flatMap(({ identity }) => identity.isin ? [identity.isin] : []))];
        const tickers = [...new Set(lookups.flatMap(({ row, identity }) => symbols(row, identity)))];
        let batch: Settled<HoldingIdentityBatch> = { data: null, failure: null };
        if (isins.length || tickers.length) {
          try { batch = { data: await readHoldingIdentityBatch(isins, tickers), failure: null }; }
          catch (error) {
            // This endpoint always answers 200 for unknown identifiers. A 404 means
            // the batch service is unavailable, never that every holding is unknown.
            batch = { data: null, failure: readFailure(error) ?? "unavailable" };
          }
        }
        const found = new Map(lookups.map(holding => [key(holding), resolve(holding.row, holding.identity, batch)]));
        const resolved = new Array<Stock | null>(holdings.length).fill(null);
        const lookupFailure = new Array<ReadFailure | null>(holdings.length).fill(null);
        toResolve.forEach(holding => {
          const read = found.get(key(holding));
          resolved[holding.index] = read?.data ?? null;
          lookupFailure[holding.index] = read?.failure ?? null;
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
        const isComplete = !lookThrough || reported == null ? null : holdings.length >= reported && lookThroughWeightPct >= 98;
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
        if (lookThrough && isComplete !== true) warnings.push("Holdings are partial or completeness is unknown; exposure weights are lower-bound look-through coverage, not a full fund allocation.");
        if (requestedTypes.includes("currency") && holdings.length && currencyReported < lookThroughWeightPct * 0.9) {
          warnings.push("This fund's holdings file does not state a currency for most positions. Where it does not, the currency shown is inferred: the company's home-market listing in Bullrun, else the usual currency of its country (see coverage.currencyBasisWeightPct). This is a holding quote/listing-currency proxy, not revenue FX exposure, economic currency risk or hedge-adjusted fund exposure; a secondary line on another exchange is never used, and positions with neither basis are \"Not reported\".");
        }
        const skipped = toResolve.filter(holding => canResolve(holding) && !found.has(key(holding))).length;
        if (skipped) {
          warnings.push(`${skipped} of the smallest positions exceeded the ${MAX_LOOKUPS} distinct-identity lookup cap and were not looked up; their missing fields remain Unclassified / Not reported.`);
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
            storedHoldingRows: lookThrough ? holdings.length : null,
            holdingsLoaded: lookThrough,
            reportedHoldingsCount: reported,
            lookThroughWeightPct: lookThrough ? roundMetric(lookThroughWeightPct, 4) : null,
            bucketCoverage,
            cashAndDerivativesWeightPct: lookThrough ? weightWhere(classified, (row) => row.cash) : null,
            classifiedWeightPct: {
              sector: lookThrough ? weightWhere(securities, (row) => row.sector != null) : null,
              country: lookThrough ? weightWhere(securities, (row) => row.country != null) : null,
              currency: lookThrough ? roundMetric(currencyReported + currencyFromListing + currencyFromCountry, 4) : null,
            },
            currencyBasisWeightPct: {
              reported: lookThrough ? currencyReported : null,
              homeListing: lookThrough ? currencyFromListing : null,
              countryCurrency: lookThrough ? currencyFromCountry : null,
              notReported: lookThrough ? weightWhere(classified, (row) => row.currency == null && !row.lookupFailed) : null,
            },
            // Where each classification came from, as fund weight: the provider's own
            // file, the Bullrun instrument the holding resolved to, or (country only) the
            // exchange of an aggregator's symbol. Unclassified excludes failed lookups,
            // which lookupFailures counts.
            sectorBasisWeightPct: {
              providerReported: lookThrough ? weightWhere(securities, (row) => row.sectorBasis === "provider") : null,
              bullrunInstrument: lookThrough ? weightWhere(securities, (row) => row.sectorBasis === "bullrun") : null,
              unclassified: lookThrough ? weightWhere(securities, (row) => row.sectorBasis == null && !row.lookupFailed) : null,
            },
            countryBasisWeightPct: {
              providerReported: lookThrough ? weightWhere(securities, (row) => row.countryBasis === "provider") : null,
              bullrunInstrument: lookThrough ? weightWhere(securities, (row) => row.countryBasis === "bullrun") : null,
              listingExchange: lookThrough ? weightWhere(securities, (row) => row.countryBasis === "listing") : null,
              unclassified: lookThrough ? weightWhere(securities, (row) => row.countryBasis == null && !row.lookupFailed) : null,
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
