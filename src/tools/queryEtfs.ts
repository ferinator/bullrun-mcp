import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe, type Stock } from "./stockIdentity.js";

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
    .describe("Exact ETF category filter. This maps to Bullrun's ETF category column."),
  focus: z.string().optional()
    .describe("Exact ETF focus filter. This maps to Bullrun's ETF focus / asset-class column."),
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
      annotations: { readOnlyHint: true },
      description:
        "Search the Bullrun ETF universe by ticker/fund name plus ETF category, focus, domicile, exchange and currency. For an exact ticker, returns ETF profile details, recent historical price rows, and latest holdings. Read-only.",
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
        let profile: EtfProfile | null = null;
        let holdings: EtfHolding[] | null = null;
        let prices: Price[] | null = null;

        if (ticker) {
          const enc = encodeURIComponent(ticker);
          const [profileResult, holdingsResult, pricesResult] = await Promise.all([
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            args.includeHoldings
              ? safe(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`))
              : Promise.resolve(null),
            args.priceLimit > 0
              ? safe(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: args.priceLimit }))
              : Promise.resolve(null),
          ]);
          profile = profileResult;
          holdings = holdingsResult;
          prices = pricesResult;
        }

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
                profile: toProfilePayload(profile),
                prices: prices?.map(toPricePayload) ?? [],
                holdingsReturned: holdings ? Math.min(holdings.length, args.holdingsLimit) : 0,
                holdings: holdings?.slice(0, args.holdingsLimit).map(toHoldingPayload) ?? [],
              }
            : null,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `query_etfs failed: ${msg}` }] };
      }
    },
  );
}
