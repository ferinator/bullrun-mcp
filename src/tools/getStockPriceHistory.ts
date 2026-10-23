import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { errorText, identityPayload, resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import { aggregateDailyPrices, closePerformance, emaSeries, macdSeries, normalizeDailyPrices, roundPriceMetric, rsiSeries, smaSeries, validCalendarDate } from "./stockPriceHistoryData.js";

// A factory, not a shared instance: a reused zod schema is emitted as a $ref, which the Claude
// directory reads as a parameter with no type.
const calendarDate = () => z.string().refine(validCalendarDate, "Use a real calendar date in YYYY-MM-DD format.");
const inputSchema = {
  ticker: z.string().trim().min(1).max(32).describe("Bullrun stock ticker, e.g. AAPL, SAP, ABBN, 6324.T or 7203. " + TICKER_CONVENTION),
  interval: z.enum(["daily", "weekly", "monthly"]).default("daily").describe("Aggregate stored daily bars. Weekly buckets start Monday; monthly buckets use the calendar month. No intraday or live quotes."),
  startDate: calendarDate().optional().describe("Inclusive trade-date cutoff, applied after loading the latest source bars. Cannot page into history older than the source limit."),
  endDate: calendarDate().optional().describe("Inclusive last trade date; the API still loads the most recent source bars before this filter."),
  limit: z.number().int().min(1).max(2600).default(260).describe("Maximum most-recent DAILY source bars to load before date filtering and aggregation (hard cap 2600). Increase for indicator warm-up or longer history."),
  indicators: z.array(z.enum(["sma", "ema", "rsi", "macd"])).max(4).default([]).describe("Optional indicators computed on the selected interval's closes after date filtering. Insufficient warm-up yields null, never a fabricated value."),
  movingAveragePeriod: z.number().int().min(2).max(250).default(20).describe("Observation count for SMA and EMA, in the selected interval."),
  rsiPeriod: z.number().int().min(2).max(100).default(14).describe("Number of close-to-close changes for Wilder RSI. MACD uses fixed EMA periods 12/26 and signal 9."),
};

export function registerGetStockPriceHistory(server: McpServer): void {
  server.registerTool("get_stock_price_history", {
    title: "Get stock price history and technical indicators",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Read bounded stored stock OHLCV history, ascending by trade date, as daily, weekly or monthly bars, with close-based price returns/drawdown and optional deterministic SMA, EMA, Wilder RSI and MACD. Useful for price trends, volatility context and technical analysis; use get_stock_metrics for a latest company snapshot. Up to 2600 recent daily source rows; dates filter that bounded window. Provider split/dividend adjustment is unknown: returns are not verified total returns. Missing OHLCV/indicator warm-up remains null; no synthetic sessions, intraday data or live quote claims. Read-only.",
    inputSchema,
  }, async (args) => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text", text: 'get_stock_price_history requires the "read:market" scope.' }] }; }
    if (args.startDate && args.endDate && args.startDate > args.endDate) {
      return { isError: true, content: [{ type: "text", text: "startDate must be on or before endDate." }] };
    }
    try {
      const resolution = await resolveStockTicker(args.ticker);
      if (!resolution.ticker) return { content: [{ type: "text", text: tickerNotFoundText(args.ticker, resolution) }] };
      const ticker = resolution.ticker.toUpperCase();
      const identity = resolution.stock;
      const raw = await bullrunGet<unknown>(`/api/prices/${encodeURIComponent(ticker)}`, { limit: args.limit }, 8_000);
      if (!Array.isArray(raw)) throw new Error("Invalid price response");
      const normalized = normalizeDailyPrices(raw.slice(0, args.limit), ticker);
      const selected = normalized.prices.filter(row => (!args.startDate || row.tradeDate >= args.startDate) && (!args.endDate || row.tradeDate <= args.endDate));
      const bars = aggregateDailyPrices(selected, args.interval);
      const closes = bars.map(bar => bar.close);
      const performance = closePerformance(bars);
      const requestedIndicators = [...new Set(args.indicators)];
      const sma = requestedIndicators.includes("sma") ? smaSeries(closes, args.movingAveragePeriod) : null;
      const ema = requestedIndicators.includes("ema") ? emaSeries(closes, args.movingAveragePeriod) : null;
      const rsi = requestedIndicators.includes("rsi") ? rsiSeries(closes, args.rsiPeriod) : null;
      const macd = requestedIndicators.includes("macd") ? macdSeries(closes) : null;
      const rounded = (value: number | null) => value == null ? null : roundPriceMetric(value);
      const warnings = ["Stored daily prices have unknown split/dividend adjustment. Price returns and drawdown are not verified total returns; currency is not converted."];
      if (!identity) warnings.push("Exact stock identity is unavailable; any returned prices match only the requested ticker. Resolve the listing before relying on its currency or identity.");
      if (!bars.length) warnings.push("No usable stored price bars match this bounded source window and date filter; this does not prove that older history is absent.");
      if (normalized.omittedRows) warnings.push(`${normalized.omittedRows} rows with invalid dates, mismatched ticker or non-positive/missing closes were omitted; gaps are not filled.`);
      if (normalized.duplicateDates) warnings.push(`${normalized.duplicateDates} duplicate trade dates were omitted, keeping the first API observation.`);
      if (raw.length >= args.limit) warnings.push("The latest-daily-source limit was reached. Older data may exist; date filters do not fetch a separate historical page.");
      if (args.startDate && normalized.prices[0] && args.startDate < normalized.prices[0].tradeDate) warnings.push("The requested start precedes the oldest loaded usable observation; full requested-date coverage cannot be established.");
      if (args.interval !== "daily") warnings.push("First/last period buckets may be partial because of source limits, date cutoffs, missing sessions or the current unfinished week/month.");
      const required = { sma: args.movingAveragePeriod, ema: args.movingAveragePeriod, rsi: args.rsiPeriod + 1, macd: 34 };
      for (const name of requestedIndicators) if (bars.length < required[name]) warnings.push(`${name.toUpperCase()} requires ${required[name]} selected interval observations for a fully warmed value; only ${bars.length} are available.`);
      return toolResult({
        ticker, ...(resolution.note ? { tickerResolution: resolution.note } : {}),
        identity: identityPayload(identity), interval: args.interval, requestedIndicators,
        bars: bars.map((bar, index) => ({ ...bar, ...performance.observations[index],
          ...(sma ? { sma: rounded(sma[index]) } : {}), ...(ema ? { ema: rounded(ema[index]) } : {}),
          ...(rsi ? { rsi: rounded(rsi[index]) } : {}),
          ...(macd ? { macd: { value: rounded(macd[index].macd), signal: rounded(macd[index].signal), histogram: rounded(macd[index].histogram) } } : {}),
        })),
        summary: performance.summary,
        coverage: { requestedStartDate: args.startDate ?? null, requestedEndDate: args.endDate ?? null, sourceDailyLimit: args.limit,
          loadedDailyRows: Math.min(raw.length, args.limit), usableDailyRows: normalized.prices.length, selectedDailyRows: selected.length,
          returnedBars: bars.length, oldestLoadedDate: normalized.prices[0]?.tradeDate ?? null, latestLoadedDate: normalized.prices.at(-1)?.tradeDate ?? null,
          selectedStartDate: selected[0]?.tradeDate ?? null, selectedEndDate: selected.at(-1)?.tradeDate ?? null,
          omittedRows: normalized.omittedRows, duplicateDates: normalized.duplicateDates, sourceLimitReached: raw.length >= args.limit,
          completeSessionCoverage: "unknown", retrievedAt: new Date().toISOString(), sourceFetchedAt: null },
        methodology: { ordering: "Ascending by period, with actual first/last source trade dates. Weekly periods are identified by Monday; monthly by YYYY-MM.",
          aggregation: "Open is the first source open, close the last source close. High/low/volume are null unless every selected daily row has that field. Volume is summed; no missing days or prices are interpolated.",
          returns: "Consecutive selected-bar closes; first period return is null. Cumulative return and drawdown start at the first selected close. Maximum drawdown uses selected-interval closing peaks, not intraday highs or omitted daily closes. One bar is insufficient for summary return/drawdown.",
          indicators: "Computed after date filtering/aggregation on selected closes only; no hidden earlier warm-up. SMA arithmetic mean; EMA seeds with period-length SMA, alpha=2/(period+1). RSI uses Wilder smoothing, initial mean of period gains/losses; flat=50, no losses=100, no gains=0. MACD=EMA12-EMA26 (first value at observation26), signal=EMA9 of MACD (first at34); histogram=MACD-signal. Values rounded to 8 decimals only after computation.",
          movingAveragePeriod: args.movingAveragePeriod, rsiPeriod: args.rsiPeriod, macdPeriods: { fast: 12, slow: 26, signal: 9 },
          priceAdjustment: "unknown", totalReturnVerified: false, quoteCurrency: identity?.currency ?? null,
          freshness: "trade dates describe observations, not ingestion times. retrievedAt is this read time. No live or intraday source is queried." },
        warnings,
      });
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: errorText(err, "Stock price history",
        "Stock price history could not be loaded. Check the exact Bullrun ticker and retry; upstream details are not exposed.") }] };
    }
  });
}
