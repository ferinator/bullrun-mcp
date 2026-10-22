import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, NOT_REQUESTED, safe, settle, storedRead } from "./stockIdentity.js";
import { pricesAscending } from "./etfAnalytics.js";
import { toolResult, type EtfPrice, type EtfProfile } from "./etfData.js";

const seriesType = z.enum(["price", "price_return", "nav", "total_return", "benchmark", "premium_discount"]);
type Interval = "daily" | "weekly" | "monthly";

const inputSchema = {
  ticker: z.string().min(1).describe("Exact Bullrun ETF listing ticker."),
  series: z.array(seriesType).min(1).max(6).default(["price"])
    .describe("Requested series. Unsupported stored series are reported in unavailableSeries rather than synthesized."),
  benchmarkTicker: z.string().min(1).optional()
    .describe("Exact priced ticker to use when benchmark is requested. A benchmark name alone cannot resolve a price series safely."),
  interval: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(1300).default(260)
    .describe("Maximum recent daily source bars to load before date filtering and interval aggregation."),
};

const outputSchema = {
  ticker: z.string(),
  requestedSeries: z.array(seriesType),
  availableSeries: z.array(seriesType),
  unavailableSeries: z.array(seriesType),
  interval: z.enum(["daily", "weekly", "monthly"]),
  series: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

function periodKey(date: string, interval: Interval): string {
  if (interval === "daily") return date;
  if (interval === "monthly") return date.slice(0, 7);
  const value = new Date(`${date}T00:00:00Z`);
  const dayFromMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - dayFromMonday);
  return value.toISOString().slice(0, 10);
}

function aggregatePrices(rows: EtfPrice[], interval: Interval): Array<Record<string, unknown>> {
  const groups = new Map<string, EtfPrice[]>();
  for (const row of rows) {
    const key = periodKey(row.tradeDate, interval);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([period, group]) => {
    const first = group[0];
    const last = group.at(-1) as EtfPrice;
    const highs = group.map((row) => row.highPrice).filter((value): value is number => value != null);
    const lows = group.map((row) => row.lowPrice).filter((value): value is number => value != null);
    const volumes = group.map((row) => row.volume).filter((value): value is number => value != null);
    return {
      period,
      startDate: first.tradeDate,
      endDate: last.tradeDate,
      open: first.openPrice,
      high: highs.length ? Math.max(...highs) : null,
      low: lows.length ? Math.min(...lows) : null,
      close: last.closePrice,
      volume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null,
    };
  });
}

function priceReturnSeries(rows: EtfPrice[], interval: Interval): Array<Record<string, unknown>> {
  const aggregated = aggregatePrices(rows, interval);
  const firstClose = aggregated.find((row) => typeof row.close === "number" && row.close > 0)?.close as number | undefined;
  return aggregated.map((row) => ({
    period: row.period,
    date: row.endDate,
    priceReturnPct: firstClose && typeof row.close === "number"
      ? Number(((row.close / firstClose - 1) * 100).toFixed(8))
      : null,
  }));
}

export function registerGetEtfTimeseries(server: McpServer): void {
  server.registerTool(
    "get_etf_timeseries",
    {
      title: "Get ETF time series",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Fetch ETF price or price-return history at daily, weekly, or monthly intervals. NAV, true total-return, benchmark, and premium/discount series are returned only when their required source data or an explicit benchmark ticker exists; unavailable requested series are named explicitly and never approximated with price returns. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        if (args.startDate && args.endDate && args.startDate > args.endDate) {
          throw new Error("startDate must be on or before endDate");
        }
        const ticker = args.ticker.trim().toUpperCase();
        const requestedSeries = [...new Set(args.series)];
        const needsFundPrices = requestedSeries.includes("price") || requestedSeries.includes("price_return");
        const benchmarkTicker = args.benchmarkTicker?.trim().toUpperCase() ?? null;
        // The profile only names the benchmark. A failed price read throws or is named in
        // the warnings: a 429 is not "no price history was found".
        const [profile, priceRows, benchmarkRead] = await Promise.all([
          safe(bullrunGet<EtfProfile>(`/api/etfs/${encodeURIComponent(ticker)}/profile`)),
          needsFundPrices
            ? storedRead(bullrunGet<EtfPrice[]>(`/api/prices/${encodeURIComponent(ticker)}`, { limit: args.limit }), `Prices for ${ticker}`)
            : Promise.resolve(null),
          requestedSeries.includes("benchmark") && benchmarkTicker
            ? settle(bullrunGet<EtfPrice[]>(`/api/prices/${encodeURIComponent(benchmarkTicker)}`, { limit: args.limit }))
            : Promise.resolve(NOT_REQUESTED),
        ]);
        const prices = pricesAscending(priceRows, args.startDate, args.endDate);
        const benchmarkPrices = pricesAscending(benchmarkRead.data, args.startDate, args.endDate);
        const output: Record<string, unknown> = {};
        const availableSeries: z.infer<typeof seriesType>[] = [];
        const unavailableSeries: z.infer<typeof seriesType>[] = [];

        for (const requested of requestedSeries) {
          if (requested === "price" && prices.length) {
            output.price = aggregatePrices(prices, args.interval);
            availableSeries.push(requested);
          } else if (requested === "price_return" && prices.length) {
            output.price_return = priceReturnSeries(prices, args.interval);
            availableSeries.push(requested);
          } else if (requested === "benchmark" && benchmarkPrices.length) {
            output.benchmark = {
              ticker: benchmarkTicker,
              prices: aggregatePrices(benchmarkPrices, args.interval),
            };
            availableSeries.push(requested);
          } else {
            unavailableSeries.push(requested);
          }
        }

        const warnings: string[] = [];
        if (unavailableSeries.includes("nav")) warnings.push("Historical NAV is not stored; current profile NAV is a snapshot only.");
        if (unavailableSeries.includes("total_return")) warnings.push("Distribution-adjusted total-return history is not stored; use price_return only when price performance is acceptable.");
        if (unavailableSeries.includes("premium_discount")) warnings.push("Premium/discount requires aligned market-price and historical NAV series, which are not currently stored.");
        if (unavailableSeries.includes("benchmark")) warnings.push(
          !benchmarkTicker ? "benchmark requires an explicit benchmarkTicker; a benchmark name is not a safe ticker mapping."
            : benchmarkRead.failure ? failureText(`Benchmark prices for ${benchmarkTicker}`, benchmarkRead.failure)
              : `No price history was found for benchmarkTicker ${benchmarkTicker}.`,
        );

        return toolResult({
          ticker,
          requestedSeries,
          availableSeries,
          unavailableSeries,
          interval: args.interval,
          series: output,
          metadata: {
            sourceDailyBars: prices.length,
            sourceStartDate: prices[0]?.tradeDate ?? null,
            sourceEndDate: prices.at(-1)?.tradeDate ?? null,
            profileBenchmarkName: profile?.benchmark ?? null,
            benchmarkTicker,
            totalReturnIncludesDistributions: false,
          },
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_timeseries failed: ${msg}` }] };
      }
    },
  );
}
