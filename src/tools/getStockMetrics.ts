import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import {
  failureText,
  identityPayload,
  resolveStockTicker,
  settle,
  TICKER_CONVENTION,
  tickerNotFoundText,
  tidy,
} from "./stockIdentity.js";
import { reportedEbitdaWarnings } from "./financialQuality.js";

interface Valuation {
  ticker: string;
  tradeDate: string;
  marketCap: number | null;
  peRatio: number | null;
  dividendYield: number | null;
  annualDividendPerShare: number | null;
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

interface Financials {
  ticker: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceCurrency: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebit?: number | null;
  ebitda: number | null;
  depreciationAndAmortization?: number | null;
  netIncome: number | null;
  dilutedEps: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
  totalDebt: number | null;
  cashAndCashEquivalents: number | null;
  totalAssets: number | null;
  stockholdersEquity: number | null;
  dividendsPerShare: number | null;
}

interface Profile {
  ticker: string;
  longBusinessSummary: string | null;
  website: string | null;
}

function periodLabel(fy: number | null, fq: number | null): string {
  if (fy == null) return "unknown";
  if (fq == null || fq === 0) return `FY${fy} (annual)`;
  return `FY${fy} Q${fq}`;
}

/** Rows arrive newest-first (fiscal_year desc, fiscal_quarter desc). Prefer the
 *  most recent period that actually carries an income-statement figure, so we
 *  don't surface an empty skeleton annual row. */
function pickLatestFinancials(rows: Financials[] | null): Financials | null {
  if (!rows || rows.length === 0) return null;
  return rows.find((r) => r.revenue != null || r.netIncome != null) ?? rows[0];
}

export function registerGetStockMetrics(server: McpServer): void {
  server.registerTool(
    "get_stock_metrics",
    {
      title: "Get stock metrics",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Fetch a consolidated metrics snapshot for a single stock by ticker: identity (company, exchange, currency, sector, industry, country, ISIN), latest daily price (OHLCV), latest valuation (market cap, P/E, dividend yield, annual dividend per share), the most recent reported financials (revenue, gross/operating income, EBITDA, net income, diluted EPS, free & operating cash flow, total debt, cash, total assets, equity) and a short company description. Prices are in the listing's trading currency; financials in their own sourceCurrency. " + TICKER_CONVENTION + " Read-only.",
      inputSchema: {
        ticker: z.string().min(1)
          .describe("The stock ticker as Bullrun lists it, e.g. \"AAPL\", \"BMW\", \"NESN\", \"6324.T\", \"0700.HK\" or \"005930\". A bare numeric code is resolved when exactly one listing matches."),
      },
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        if (!args.ticker.trim()) {
          return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        }
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) {
          return { content: [{ type: "text", text: tickerNotFoundText(args.ticker, resolution) }] };
        }
        const ticker = resolution.ticker;
        const identity = resolution.stock;
        const enc = encodeURIComponent(ticker);

        // Each read keeps its own failure: a 429 on one of them is no evidence that
        // nothing is stored, so its section is null with a warning that says why.
        const [valuationsRead, pricesRead, financialsRead, profileRead] = await Promise.all([
          settle(bullrunGet<Valuation[]>(`/api/valuations/${enc}`, { limit: 1 })),
          settle(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: 1 })),
          settle(bullrunGet<Financials[]>(`/api/financials/${enc}`)),
          settle(bullrunGet<Profile>(`/api/stocks/${enc}/profile`)),
        ]);
        const reads = [
          ["The latest valuation", valuationsRead],
          ["The latest price", pricesRead],
          ["The latest reported financials", financialsRead],
          ["The company description and website", profileRead],
        ] as const;
        if (reads.every(([, read]) => read.failure)) {
          const failure = reads.some(([, read]) => read.failure === "quota") ? "quota" : "unavailable";
          return { isError: true, content: [{ type: "text", text: `get_stock_metrics: ${failureText(`Metrics for ${ticker}`, failure)}` }] };
        }
        const failed = reads.flatMap(([what, read]) => read.failure ? [failureText(what, read.failure)] : []);

        const valuation = valuationsRead.data?.[0] ?? null;
        const price = pricesRead.data?.[0] ?? null;
        const fin = pickLatestFinancials(financialsRead.data);
        const profile = profileRead.data;

        const summary = profile?.longBusinessSummary ?? null;
        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(identity),
          latestPrice: price
            ? {
                date: price.tradeDate,
                close: tidy(price.closePrice),
                open: tidy(price.openPrice),
                high: tidy(price.highPrice),
                low: tidy(price.lowPrice),
                volume: price.volume,
              }
            : null,
          valuation: valuation
            ? {
                date: valuation.tradeDate,
                marketCap: valuation.marketCap,
                peRatio: tidy(valuation.peRatio, 5),
                dividendYieldPct: tidy(valuation.dividendYield, 5),
                annualDividendPerShare: tidy(valuation.annualDividendPerShare),
              }
            : null,
          latestFinancials: fin
            ? {
                period: periodLabel(fin.fiscalYear, fin.fiscalQuarter),
                fiscalYear: fin.fiscalYear,
                fiscalQuarter: fin.fiscalQuarter,
                sourceCurrency: fin.sourceCurrency,
                revenue: fin.revenue,
                grossProfit: fin.grossProfit,
                operatingIncome: fin.operatingIncome,
                ebitda: fin.ebitda,
                netIncome: fin.netIncome,
                dilutedEps: tidy(fin.dilutedEps),
                freeCashflow: fin.freeCashflow,
                operatingCashflow: fin.operatingCashflow,
                totalDebt: fin.totalDebt,
                cash: fin.cashAndCashEquivalents,
                totalAssets: fin.totalAssets,
                stockholdersEquity: fin.stockholdersEquity,
                dividendsPerShare: tidy(fin.dividendsPerShare),
              }
            : null,
          description: summary ? (summary.length > 900 ? `${summary.slice(0, 900)}...` : summary) : null,
          website: profile?.website ?? null,
          warnings: [
            ...failed,
            ...(fin ? reportedEbitdaWarnings([{
              period: periodLabel(fin.fiscalYear, fin.fiscalQuarter),
              ebit: fin.ebit,
              ebitda: fin.ebitda,
              depreciationAndAmortization: fin.depreciationAndAmortization,
            }]) : []),
          ],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_stock_metrics failed: ${msg}` }] };
      }
    },
  );
}
