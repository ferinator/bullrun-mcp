import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, resolveStockTicker, settle, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";
import { mapWithConcurrency, toolResult } from "./etfData.js";
import {
  FORECAST_CAVEAT,
  MODEL_INFO,
  MODEL_KEYS,
  VALUATION_CAVEAT,
  interpretScore,
  type MlScore,
  type ModelKey,
} from "./valuationModelData.js";

/** Preference order for the one-line headline: P/E before P/S, quarterly before annual. */
const VALUATION_PREFERENCE: ModelKey[] = ["valuation", "valuation_annual_1y", "valuation_ps", "valuation_ps_annual_1y"];
const FORECAST_PREFERENCE: ModelKey[] = ["forecast", "forecast_annual_1y"];

const inputSchema = {
  tickers: z.array(z.string().min(1)).min(1).max(10)
    .describe("1-10 Bullrun tickers, e.g. [\"AAPL\",\"MSFT\"] or [\"ASML\",\"SAP\",\"NESN\"]. " + TICKER_CONVENTION),
};

export function registerGetValuationModel(server: McpServer): void {
  server.registerTool(
    "get_valuation_model",
    {
      title: "Get Bullrun valuation model",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Bullrun's proprietary machine-learning valuation and forecast scores for 1-10 stocks, recomputed nightly. Valuation: a LightGBM model predicts the P/E (or price/sales for loss-makers) that companies with similar fundamentals typically command a year out; the gap = typical / current multiple - 1 (positive = trades below its typical multiple), with the implied model-typical P/E, percentile and rank in the scored universe. Forecast: a relative 1-year return-rank signal with percentile. Both on quarterly and on annual financials (annual covers most non-US companies). Use for \"is X cheap or expensive\", \"what's X's fair P/E\", \"compare valuations of X, Y, Z\", or a valuation sanity check before buying. Descriptive context, not a price target or recommendation. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const requested = [...new Set(args.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
        const resolutions = await mapWithConcurrency(requested, 4, (ticker) => resolveStockTicker(ticker));
        const warnings: string[] = [];
        const unresolved: Array<{ ticker: string; found: false; scored: false }> = [];
        requested.forEach((ticker, i) => {
          const resolution = resolutions[i];
          if (!resolution.ticker) {
            warnings.push(tickerNotFoundText(ticker, resolution));
            unresolved.push({ ticker, found: false, scored: false });
          } else if (resolution.note) {
            warnings.push(resolution.note);
          }
        });
        const tickers = [...new Set(resolutions.map((r) => r.ticker).filter((t): t is string => t != null))];
        const summaries = await mapWithConcurrency(tickers, 4, (ticker) =>
          settle(bullrunGet<{ results: Partial<Record<string, MlScore>> }>("/api/ml-scores/summary", { ticker, includePs: true })),
        );
        const failures = summaries.map((summary) => summary.failure);
        if (tickers.length && failures.every((failure) => failure)) {
          const failure = failures.includes("quota") ? "quota" : "unavailable";
          return { isError: true, content: [{ type: "text", text: `get_valuation_model: ${failureText("Model scores", failure)}` }] };
        }

        const results: Array<Record<string, unknown>> = tickers.map((ticker, i) => {
          const failure = failures[i];
          if (failure) {
            // A failed read says nothing about whether the models score this company.
            warnings.push(`${ticker}: ${failureText("Model scores", failure)}`);
            return { ticker, scored: null, loaded: false };
          }
          const scores = summaries[i].data?.results ?? {};
          const keys = MODEL_KEYS.filter((k) => scores[k]);
          if (!keys.length) {
            warnings.push(`${ticker}: no model score. The models skip companies with too little reported history, a sub-p10 market cap for their currency, a 50%+ one-year collapse, or (P/E model) an out-of-band trailing P/E. Check the exact ticker with get_stock_metrics.`);
            return { ticker, scored: false };
          }
          const any = scores[keys[0]] as MlScore;
          const models: Record<string, unknown> = {};
          for (const k of keys) models[k] = interpretScore(k, scores[k] as MlScore);
          const headlineValuation = VALUATION_PREFERENCE.find((k) => scores[k]);
          const headlineForecast = FORECAST_PREFERENCE.find((k) => scores[k]);
          if (keys.some((k) => scores[k]?.dataQuality === "partial")) {
            warnings.push(`${ticker}: some scores rest on a partial financial window (fewer than 8 quarters / 4 years), so treat them with extra caution.`);
          }
          return {
            ticker,
            scored: true,
            company: any.company,
            sector: any.sector,
            country: any.country,
            exchange: any.exchange,
            currency: any.currency,
            marketCap: any.marketCap != null ? Math.round(any.marketCap) : null,
            headline: {
              valuation: headlineValuation ? models[headlineValuation] : null,
              forecast: headlineForecast ? models[headlineForecast] : null,
            },
            models,
          };
        });

        return toolResult({
          results: [...results, ...unresolved],
          modelCatalog: Object.fromEntries(MODEL_KEYS.map((k) => [k, MODEL_INFO[k].label])),
          methodology: { valuation: VALUATION_CAVEAT, forecast: FORECAST_CAVEAT },
          warnings,
          webPage: tickers.length === 1 ? `https://bull-run.org/stocks/${encodeURIComponent(tickers[0])}` : "https://bull-run.org/stocks/undervalued",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_valuation_model failed: ${msg}` }] };
      }
    },
  );
}
