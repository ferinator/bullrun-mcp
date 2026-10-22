import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe, settle, tidy, UpstreamReadError, type Stock } from "./stockIdentity.js";
import {
  fractionToPct,
  readExactEtf,
  toolResult,
  type EtfProfile,
} from "./etfData.js";

/** ISIN shape: 2-letter country code, 9 alphanumerics, 1 check digit. */
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

interface FundListing {
  ticker: string;
  exchange?: string | null;
  currency?: string | null;
  country?: string | null;
}

/** GET /api/etfs/isin/{isin} — the fund, with every venue listing of it. */
interface Fund {
  fundIsin: string;
  ticker: string;
  fundName?: string | null;
  fundFamily?: string | null;
  category?: string | null;
  assetClass?: string | null;
  region?: string | null;
  domicile?: string | null;
  /** Fraction, not percent. */
  expenseRatio?: number | null;
  totalAssets?: number | null;
  nav?: number | null;
  /** Fraction, not percent. */
  yieldTtm?: number | null;
  inceptionDate?: string | null;
  benchmark?: string | null;
  indexKey?: string | null;
  website?: string | null;
  description?: string | null;
  holdingsCount?: number | null;
  distributionPolicy?: string | null;
  productType?: string | null;
  updatedAt?: string | null;
  oneYearPriceReturnPct?: number | null;
  priceAsOf?: string | null;
  /** Close the one-year return starts from (last close on or before priceAsOf - 365 days). */
  oneYearPriceReturnFrom?: string | null;
  /** Asset class normalised by the API from the venue rows' mixed vocabularies, or null. */
  assetClassLabel?: string | null;
  categoryLabel?: string | null;
  listings: FundListing[];
}

interface ListingRow extends Stock {
  fundIsin?: string | null;
}

/**
 * Other funds whose tickers share this one's symbol before the venue suffix:
 * COPX is Global X's US fund, COPX.L its UCITS fund -- two funds, not two venues.
 */
async function symbolSiblings(ticker: string, excludeIsin: string | null): Promise<Array<Record<string, unknown>>> {
  const base = ticker.split(".")[0];
  if (!base) return [];
  const rows = await safe(bullrunGet<ListingRow[]>("/api/etfs", {
    search: base, includeSecondary: true, includeInactive: false, limit: 60,
  }));
  const byFund = new Map<string, ListingRow[]>();
  for (const row of rows ?? []) {
    if (row.ticker?.split(".")[0]?.toUpperCase() !== base) continue;
    const key = (row.fundIsin ?? row.isin ?? row.ticker).toUpperCase();
    if (excludeIsin && key === excludeIsin) continue;
    byFund.set(key, [...(byFund.get(key) ?? []), row]);
  }
  return [...byFund.values()].slice(0, 10).map((group) => ({
    fundIsin: group[0].fundIsin ?? group[0].isin ?? null,
    name: group[0].company,
    tickers: group.map((row) => row.ticker),
    exchanges: [...new Set(group.map((row) => row.exchange).filter(Boolean))],
    tradingCurrencies: [...new Set(group.map((row) => row.currency).filter(Boolean))],
  }));
}

const inputSchema = {
  isin: z.string().optional()
    .describe("Fund ISIN, e.g. IE00B4L5Y983. The identifier European factsheets and brokers quote."),
  ticker: z.string().optional()
    .describe("Any venue listing ticker of the fund, e.g. EUNL.DE or IWDA.L. Resolved to its fund ISIN first. Provide this or isin."),
};

const outputSchema = {
  query: z.record(z.string(), z.unknown()),
  found: z.boolean(),
  fund: z.record(z.string(), z.unknown()).nullable(),
  listings: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
};

export function registerGetEtfFund(server: McpServer): void {
  server.registerTool(
    "get_etf_fund",
    {
      title: "Get ETF fund by ISIN",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Resolve one FUND rather than one listing. Given an ISIN (or any venue ticker of the fund) it returns the fund's identity, costs, index, distribution policy, wrapper type and every venue it is listed on with exchange and trading currency. Use this when the user quotes an ISIN, asks \"which ticker do I buy on my exchange?\", or when several tickers may be the same underlying fund. Ratios are percentage points. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const warnings: string[] = [];
        const rawIsin = args.isin?.trim().toUpperCase() ?? "";
        const rawTicker = args.ticker?.trim().toUpperCase() ?? "";

        if (!rawIsin && !rawTicker) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "get_etf_fund requires either isin or ticker." }],
          };
        }

        let isin = rawIsin;
        let resolvedVia: string = "isin";

        if (!isin) {
          resolvedVia = "ticker";
          const enc = encodeURIComponent(rawTicker);
          const [profileRead, listingRead] = await Promise.all([
            settle(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            readExactEtf(rawTicker),
          ]);
          const listing = listingRead.data;
          isin = (profileRead.data?.fundIsin ?? listing?.isin ?? "").trim().toUpperCase();
          // A failed lookup is not "no ETF listing matches".
          const failure = profileRead.failure ?? listingRead.failure;
          if (!isin && failure) throw new UpstreamReadError(failure, `The fund lookup for ${rawTicker}`);
          if (!isin) {
            const siblings = await symbolSiblings(rawTicker, null);
            return toolResult({
              query: { isin: null, ticker: rawTicker, resolvedVia },
              found: false,
              fund: null,
              listings: [],
              ...(siblings.length ? { candidates: siblings } : {}),
              warnings: [
                listing
                  ? `${rawTicker} exists but carries no fund ISIN, so it cannot be resolved to a fund-level record. Use get_etf_snapshot for the listing instead.`
                  : siblings.length
                    ? `No ETF listing is called exactly ${rawTicker}; the candidates share its symbol on other venues. Each candidate is a separate fund unless its fundIsin matches.`
                    : `No ETF listing matches ${rawTicker}. Use search_etfs to find the right ticker.`,
              ],
            });
          }
        } else if (!ISIN_PATTERN.test(isin)) {
          return toolResult({
            query: { isin: rawIsin, ticker: rawTicker || null, resolvedVia },
            found: false,
            fund: null,
            listings: [],
            warnings: [`"${rawIsin}" is not a valid ISIN (expected 2 letters, 9 alphanumerics, 1 check digit).`],
          });
        }

        const fund = await bullrunGet<Fund>(`/api/etfs/isin/${encodeURIComponent(isin)}`)
          .catch((err) => {
            if (err instanceof Error && / 404 /.test(err.message)) return null;
            throw err;
          });

        if (!fund) {
          const siblings = rawTicker ? await symbolSiblings(rawTicker, isin) : [];
          return toolResult({
            query: { isin, ticker: rawTicker || null, resolvedVia },
            found: false,
            fund: null,
            listings: [],
            ...(siblings.length ? { otherFundsSharingThisSymbol: siblings } : {}),
            warnings: [
              resolvedVia === "ticker"
                ? `${rawTicker} is an ETF listing (ISIN ${isin}), but Bullrun keeps no fund-level record for that ISIN: fund records cover funds with a fund ISIN shared across venues, mostly European UCITS funds. Use get_etf_snapshot or compare_etfs for this listing.`
                : `No fund is stored under ISIN ${isin}. It may be a share or bond ISIN, or a fund Bullrun does not cover; search_etfs or search_stocks can check.`,
              ...(siblings.length ? ["Other funds share this symbol on other venues (otherFundsSharingThisSymbol). They are different funds, not venues of this one."] : []),
            ],
          });
        }

        const listings = (fund.listings ?? []).map((listing) => ({
          ticker: listing.ticker,
          exchange: listing.exchange ?? null,
          currency: listing.currency ?? null,
          country: listing.country ?? null,
        }));

        if (listings.length > 1) {
          warnings.push(
            `This fund trades on ${listings.length} venues under different tickers. They are the same fund — do not treat them as separate holdings or as diversification.`,
          );
        }
        if (fund.expenseRatio == null) {
          warnings.push("No expense ratio is published for this fund; cost cannot be compared.");
        }
        if (rawTicker && !rawTicker.includes(".")) {
          const siblings = await symbolSiblings(rawTicker, fund.fundIsin?.toUpperCase() ?? isin);
          if (siblings.length) {
            warnings.push(`Other funds also trade under the symbol ${rawTicker} on other venues: ${siblings.map((row) => `${(row.tickers as string[]).join("/")} (${row.name ?? "unnamed"}, ${row.fundIsin ?? "no ISIN"})`).join("; ")}. They are separate funds.`);
          }
        }
        const representativeCurrency = listings.find((listing) => listing.ticker === fund.ticker)?.currency ?? null;

        return toolResult({
          query: { isin, ticker: rawTicker || null, resolvedVia },
          found: true,
          fund: {
            fundIsin: fund.fundIsin,
            representativeTicker: fund.ticker,
            fundName: fund.fundName ?? null,
            issuer: fund.fundFamily ?? null,
            // The raw columns mix vocabularies across venue rows ("Equity", "Europe",
            // the fund's own name); the API's labels are the normalised reading.
            assetClass: fund.assetClassLabel ?? null,
            category: fund.categoryLabel ?? null,
            ...((fund.assetClass ?? null) !== (fund.assetClassLabel ?? null)
              || (fund.category ?? null) !== (fund.categoryLabel ?? null)
              ? { providerClassification: { assetClass: fund.assetClass ?? null, category: fund.category ?? null } }
              : {}),
            region: fund.region ?? null,
            domicile: fund.domicile ?? null,
            productType: fund.productType ?? null,
            indexKey: fund.indexKey ?? null,
            benchmark: fund.benchmark ?? null,
            distributionPolicy: fund.distributionPolicy ?? null,
            expenseRatioPct: fractionToPct(fund.expenseRatio),
            yieldTtmPct: fractionToPct(fund.yieldTtm),
            totalAssets: fund.totalAssets ?? null,
            nav: fund.nav ?? null,
            holdingsCount: fund.holdingsCount ?? null,
            inceptionDate: fund.inceptionDate ?? null,
            oneYearPriceReturnPct: tidy(fund.oneYearPriceReturnPct, 6),
            priceAsOf: fund.priceAsOf ?? null,
            oneYearPriceReturnBasis: fund.oneYearPriceReturnPct == null ? null : {
              ticker: fund.ticker,
              tradingCurrency: representativeCurrency,
              fromDate: fund.oneYearPriceReturnFrom ?? null,
              toDate: fund.priceAsOf ?? null,
              method: "Close-to-close price return of the representative (most traded) listing, from the last close on or before toDate minus 365 days; distributions excluded. Other venues in other currencies return differently.",
            },
            website: fund.website ?? null,
            description: fund.description ?? null,
            updatedAt: fund.updatedAt ?? null,
            listingCount: listings.length,
          },
          listings,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_fund failed: ${msg}` }] };
      }
    },
  );
}
