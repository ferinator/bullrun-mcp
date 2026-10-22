import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { errorText, failureText, NOT_REQUESTED, settle, type Settled, type Stock } from "./stockIdentity.js";

interface EtfProfile {
  ticker: string;
  fundName: string | null;
  fundFamily: string | null;
  category: string | null;
  assetClass: string | null;
  region: string | null;
  domicile: string | null;
  expenseRatio: number | null;
  totalAssets: number | null;
  nav: number | null;
  yieldTtm: number | null;
  inceptionDate: string | null;
  benchmark: string | null;
  website: string | null;
  description: string | null;
  holdingsCount: number | null;
  sourceUpdatedAt: string | null;
  updatedAt: string | null;
}

interface EtfHolding {
  ticker: string;
  asOfDate: string;
  holdingKey: string;
  holdingSymbol: string | null;
  holdingName: string | null;
  weightPct: number | null;
  shares: number | null;
  marketValue: number | null;
  currency: string | null;
  updatedAt: string | null;
}

interface Price {
  ticker: string;
  tradeDate: string;
  closePrice: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
}

function toEtfSummary(row: Stock): Record<string, unknown> {
  return {
    ticker: row.ticker,
    fund: row.company,
    exchange: row.exchange,
    currency: row.currency,
    category: row.sector,
    focus: row.industry,
    domicile: row.country,
    isin: row.isin,
    primaryTicker: row.primaryTicker,
    isPrimaryListing: row.primaryTicker == null,
  };
}

function toProfilePayload(profile: EtfProfile | null): Record<string, unknown> | null {
  if (!profile) return null;
  return {
    ticker: profile.ticker,
    fundName: profile.fundName,
    fundFamily: profile.fundFamily,
    category: profile.category,
    focus: profile.assetClass,
    region: profile.region,
    domicile: profile.domicile,
    expenseRatio: profile.expenseRatio,
    totalAssets: profile.totalAssets,
    nav: profile.nav,
    yieldTtm: profile.yieldTtm,
    inceptionDate: profile.inceptionDate,
    benchmark: profile.benchmark,
    website: profile.website,
    description: profile.description,
    holdingsCount: profile.holdingsCount,
    sourceUpdatedAt: profile.sourceUpdatedAt,
    updatedAt: profile.updatedAt,
  };
}

function toHoldingPayload(holding: EtfHolding): Record<string, unknown> {
  return {
    asOfDate: holding.asOfDate,
    symbol: holding.holdingSymbol,
    name: holding.holdingName,
    weightPct: holding.weightPct,
    shares: holding.shares,
    marketValue: holding.marketValue,
    currency: holding.currency,
    updatedAt: holding.updatedAt,
  };
}

function toPricePayload(price: Price): Record<string, unknown> {
  return {
    date: price.tradeDate,
    close: price.closePrice,
    open: price.openPrice,
    high: price.highPrice,
    low: price.lowPrice,
    volume: price.volume,
  };
}

const inputSchema = {
  search: z.string().optional()
    .describe("Free-text ETF search by ticker or fund name. Omit to list the first ETFs."),
  ticker: z.string().optional()
    .describe("Exact ETF ticker for profile, prices, and optional holdings, e.g. SPY, VWRL.L, EUNL.DE."),
  category: z.string().optional()
    .describe("Exact broad ETF asset-class filter, such as Equity, Fixed Income, Commodity, Crypto, or Real Estate. Kept as category for API compatibility."),
  focus: z.string().optional()
    .describe("Exact ETF exposure filter, such as Japan, Equity - Australia, TOPIX, or an exchange/source exposure label. Kept as focus for API compatibility."),
  domicile: z.string().optional()
    .describe("Exact ETF domicile filter."),
  exchange: z.string().optional()
    .describe("Exact exchange filter, e.g. NYSE ARCA, LSE, XETRA."),
  currency: z.string().optional()
    .describe("Exact trading currency filter, e.g. USD, EUR, CHF."),
  includeSecondary: z.boolean().default(false)
    .describe("Include secondary/cross-listed ETF tickers. Default false."),
  includeInactive: z.boolean().default(false)
    .describe("Include ETFs with no recent price bar. Default false."),
  includeHoldings: z.boolean().default(true)
    .describe("When ticker is supplied, include latest holdings. Ignored for broad searches."),
  holdingsLimit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum holdings to return for an exact ticker, 1-100."),
  priceLimit: z.number().int().min(0).max(250).default(1)
    .describe("Recent daily price rows to return for an exact ticker. Use 0 to skip prices."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum ETF search rows to return, 1-100."),
};

export function registerQueryEtfs(server: McpServer): void {
  server.registerTool(
    "query_etfs",
    {
      title: "Query ETFs",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Compatibility tool for older clients: search the Bullrun ETF universe and optionally bundle profile, recent prices, and latest holdings for an exact ticker. New clients should use search_etfs, get_etf_snapshot, and get_etf_holdings for smaller responses, structured output, quantitative filters, and explicit coverage metadata. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");

        const ticker = args.ticker?.trim().toUpperCase() ?? "";
        const search = ticker || args.search?.trim() || "";
        const rows = await bullrunGet<Stock[]>("/api/etfs", {
          search,
          exchange: args.exchange,
          currency: args.currency,
          sector: args.category,
          industry: args.focus,
          country: args.domicile,
          includeSecondary: args.includeSecondary,
          includeInactive: args.includeInactive,
          limit: args.limit,
        });

        const exact = ticker
          ? rows.find((row) => row.ticker.toUpperCase() === ticker) ?? null
          : null;
        let profileRead: Settled<EtfProfile> = NOT_REQUESTED;
        let holdingsRead: Settled<EtfHolding[]> = NOT_REQUESTED;
        let pricesRead: Settled<Price[]> = NOT_REQUESTED;

        if (ticker) {
          const enc = encodeURIComponent(ticker);
          // A failed detail read is named in the warnings and its field is null: a 429
          // is never shown as an empty profile, price list or holdings list.
          [profileRead, holdingsRead, pricesRead] = await Promise.all([
            settle(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            args.includeHoldings
              ? settle(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`))
              : Promise.resolve(NOT_REQUESTED),
            args.priceLimit > 0
              ? settle(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: args.priceLimit }))
              : Promise.resolve(NOT_REQUESTED),
          ]);
        }
        const holdings = holdingsRead.data;
        const prices = pricesRead.data;
        const warnings = ([
          [`The fund profile of ${ticker}`, profileRead],
          [`Prices for ${ticker}`, pricesRead],
          [`Holdings for ${ticker}`, holdingsRead],
        ] as const).flatMap(([what, read]) => read.failure ? [failureText(what, read.failure)] : []);

        const payload = {
          query: {
            search: args.search ?? null,
            ticker: ticker || null,
            category: args.category ?? null,
            focus: args.focus ?? null,
            domicile: args.domicile ?? null,
            exchange: args.exchange ?? null,
            currency: args.currency ?? null,
            includeSecondary: args.includeSecondary,
            includeInactive: args.includeInactive,
            limit: args.limit,
          },
          totalMatches: rows.length,
          returned: rows.length,
          results: rows.map(toEtfSummary),
          detail: ticker
            ? {
                ticker,
                identity: exact ? toEtfSummary(exact) : null,
                profile: toProfilePayload(profileRead.data),
                prices: pricesRead.failure ? null : prices?.map(toPricePayload) ?? [],
                holdingsReturned: holdingsRead.failure ? null : holdings ? Math.min(holdings.length, args.holdingsLimit) : 0,
                holdings: holdingsRead.failure ? null : holdings?.slice(0, args.holdingsLimit).map(toHoldingPayload) ?? [],
                warnings,
              }
            : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: errorText(err, "The ETF search", `query_etfs failed: ${msg}`) }] };
      }
    },
  );
}
