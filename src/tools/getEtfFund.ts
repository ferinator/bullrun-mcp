import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import {
  findExactEtf,
  fractionToPct,
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
  listings: FundListing[];
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
      annotations: { readOnlyHint: true },
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
          const [profile, listing] = await Promise.all([
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            findExactEtf(rawTicker),
          ]);
          isin = (profile?.fundIsin ?? listing?.isin ?? "").trim().toUpperCase();
          if (!isin) {
            return toolResult({
              query: { isin: null, ticker: rawTicker, resolvedVia },
              found: false,
              fund: null,
              listings: [],
              warnings: [
                listing
                  ? `${rawTicker} exists but carries no fund ISIN, so it cannot be resolved to a fund-level record. Use get_etf_snapshot for the listing instead.`
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
          return toolResult({
            query: { isin, ticker: rawTicker || null, resolvedVia },
            found: false,
            fund: null,
            listings: [],
            warnings: [`No fund is stored under ISIN ${isin}. Equity ISINs are not covered here — this endpoint is fund-level only.`],
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

        return toolResult({
          query: { isin, ticker: rawTicker || null, resolvedVia },
          found: true,
          fund: {
            fundIsin: fund.fundIsin,
            representativeTicker: fund.ticker,
            fundName: fund.fundName ?? null,
            issuer: fund.fundFamily ?? null,
            category: fund.category ?? null,
            assetClass: fund.assetClass ?? null,
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
            oneYearPriceReturnPct: fund.oneYearPriceReturnPct ?? null,
            priceAsOf: fund.priceAsOf ?? null,
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
