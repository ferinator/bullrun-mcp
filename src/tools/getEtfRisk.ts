import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, NOT_REQUESTED, settle, storedRead } from "./stockIdentity.js";
import {
  benchmarkRisk,
  calculatePriceRisk,
  priceLimitForDays,
  pricesAscending,
} from "./etfAnalytics.js";
import { toolResult, type EtfPrice } from "./etfData.js";

const inputSchema = {
  ticker: z.string().min(1).describe("Exact Bullrun ETF listing ticker."),
  days: z.number().int().min(30).max(1825).default(370)
    .describe("Calendar-day lookback for daily close-price risk calculations."),
  benchmarkTicker: z.string().min(1).optional()
    .describe("Optional exact priced benchmark/proxy ticker for beta, correlation, tracking error, active return, and information ratio."),
  riskFreeRatePct: z.number().min(-10).max(30).default(0)
    .describe("Annual risk-free rate in percentage points for Sharpe, Sortino, and Calmar ratios."),
};

const outputSchema = {
  ticker: z.string(),
  lookbackDays: z.number().int(),
  methodology: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  risk: z.record(z.string(), z.unknown()),
  benchmarkRelative: z.record(z.string(), z.unknown()).nullable(),
  warnings: z.array(z.string()),
};

export function registerGetEtfRisk(server: McpServer): void {
  server.registerTool(
    "get_etf_risk",
    {
      title: "Get ETF risk",
      annotations: { readOnlyHint: true },
      description:
        "Calculate drawdown, annualized volatility, downside volatility, historical VaR, Sharpe, Sortino and Calmar ratios from stored daily close prices. With benchmarkTicker, also calculates beta, correlation, tracking error, active return and information ratio on aligned dates. Results are price-return risk, not distribution-adjusted total-return risk. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const benchmarkTicker = args.benchmarkTicker?.trim().toUpperCase() ?? null;
        const startDate = new Date(Date.now() - args.days * 86_400_000).toISOString().slice(0, 10);
        const limit = priceLimitForDays(args.days);
        // A failed price read throws: a 429 is not "fewer than 20 observations".
        const [fundResult, benchmarkRead] = await Promise.all([
          storedRead(bullrunGet<EtfPrice[]>(`/api/prices/${encodeURIComponent(ticker)}`, { limit }), `Prices for ${ticker}`),
          benchmarkTicker
            ? settle(bullrunGet<EtfPrice[]>(`/api/prices/${encodeURIComponent(benchmarkTicker)}`, { limit }))
            : Promise.resolve(NOT_REQUESTED),
        ]);
        const fundPrices = pricesAscending(fundResult, startDate);
        const benchmarkPrices = pricesAscending(benchmarkRead.data, startDate);
        const risk = calculatePriceRisk(fundPrices, args.riskFreeRatePct);
        const relative = benchmarkTicker ? benchmarkRisk(fundPrices, benchmarkPrices) : null;
        const warnings: string[] = [
          "Metrics use close-price returns and exclude distributions, taxes, trading costs, and historical NAV.",
        ];
        if (risk.observations < 20) warnings.push("Fewer than 20 return observations are available; risk estimates are not statistically robust.");
        if (benchmarkTicker && benchmarkRead.failure) warnings.push(failureText(`Benchmark prices for ${benchmarkTicker}`, benchmarkRead.failure));
        else if (benchmarkTicker && !relative) warnings.push("Insufficient aligned fund/benchmark observations for benchmark-relative risk.");

        return toolResult({
          ticker,
          lookbackDays: args.days,
          methodology: {
            returnType: "daily_simple_close_price_return",
            annualizationTradingDays: 252,
            riskFreeRatePct: args.riskFreeRatePct,
            historicalVarConfidencePct: 95,
          },
          coverage: {
            priceRows: fundPrices.length,
            returnObservations: risk.observations,
            startDate: risk.startDate,
            endDate: risk.endDate,
            benchmarkTicker,
            benchmarkPriceRows: benchmarkPrices.length,
          },
          risk,
          benchmarkRelative: relative,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_risk failed: ${msg}` }] };
      }
    },
  );
}
