import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";

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
  ebitda: number | null;
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
      annotations: { readOnlyHint: true },
      description:
        "Fetch a consolidated metrics snapshot for a single stock by ticker: identity (company, exchange, currency, sector, industry, country, ISIN), latest daily price (OHLCV), latest valuation (market cap, P/E, dividend yield, annual dividend per share), the most recent reported financials (revenue, gross/operating income, EBITDA, net income, diluted EPS, free & operating cash flow, total debt, cash, total assets, equity) and a short company description. Use the exact ticker as listed on Bullrun - the native local-exchange symbol (e.g. AAPL, BMW, ABBN, NESN, or a numeric code like 005930), NOT Yahoo-style country suffixes like BMW.DE or ABBN.SW. If a ticker returns no data, use screen_stocks (by sector/country) to find the exact symbol. Read-only.",
      inputSchema: {
        ticker: z.string().min(1)
          .describe("The stock ticker exactly as listed on Bullrun - the native local-exchange symbol, e.g. \"AAPL\", \"BMW\" (not \"BMW.DE\"), \"ABBN\" (not \"ABBN.SW\"), \"NESN\", or a numeric code like \"005930\". Do not append Yahoo-style country suffixes."),
      },
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        if (!ticker) {
          return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        }
        const enc = encodeURIComponent(ticker);

        const [identity, valuations, prices, financials, profile] = await Promise.all([
          findExactStock(ticker),
          safe(bullrunGet<Valuation[]>(`/api/valuations/${enc}`, { limit: 1 })),
          safe(bullrunGet<Price[]>(`/api/prices/${enc}`, { limit: 1 })),
          safe(bullrunGet<Financials[]>(`/api/financials/${enc}`)),
          safe(bullrunGet<Profile>(`/api/stocks/${enc}/profile`)),
        ]);

        const valuation = valuations?.[0] ?? null;
        const price = prices?.[0] ?? null;
        const fin = pickLatestFinancials(financials);

        if (!identity && !valuation && !price && !fin && !profile) {
          return {
            content: [{
              type: "text",
              text: `No data found for ticker "${ticker}". Bullrun uses the plain local-exchange symbol, not Yahoo-style suffixes - e.g. "BMW" not "BMW.DE", "ABBN" not "ABBN.SW". Drop any .XX suffix and retry, or use screen_stocks (by sector/country) to find the exact symbol.`,
            }],
          };
        }

        const summary = profile?.longBusinessSummary ?? null;
        const payload = {
          ticker,
          identity: identityPayload(identity),
          latestPrice: price
            ? {
                date: price.tradeDate,
                close: price.closePrice,
                open: price.openPrice,
                high: price.highPrice,
                low: price.lowPrice,
                volume: price.volume,
              }
            : null,
          valuation: valuation
            ? {
                date: valuation.tradeDate,
                marketCap: valuation.marketCap,
                peRatio: valuation.peRatio,
                dividendYieldPct: valuation.dividendYield,
                annualDividendPerShare: valuation.annualDividendPerShare,
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
                dilutedEps: fin.dilutedEps,
                freeCashflow: fin.freeCashflow,
                operatingCashflow: fin.operatingCashflow,
                totalDebt: fin.totalDebt,
                cash: fin.cashAndCashEquivalents,
                totalAssets: fin.totalAssets,
                stockholdersEquity: fin.stockholdersEquity,
                dividendsPerShare: fin.dividendsPerShare,
              }
            : null,
          description: summary ? (summary.length > 900 ? `${summary.slice(0, 900)}...` : summary) : null,
          website: profile?.website ?? null,
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_stock_metrics failed: ${msg}` }] };
      }
    },
  );
}
