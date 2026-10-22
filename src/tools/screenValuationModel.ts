import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import {
  FORECAST_CAVEAT,
  MODEL_INFO,
  VALUATION_CAVEAT,
  interpretScore,
  type MlScore,
} from "./valuationModelData.js";

/** The leaderboard keys bullrun-api publishes (the annual P/S sibling is per-ticker only). */
const SCREEN_MODELS = ["valuation", "valuation_ps", "valuation_annual_1y", "forecast", "forecast_annual_1y"] as const;
const SCAN_CAP = 1000;

const inputSchema = {
  model: z.enum(SCREEN_MODELS).default("valuation")
    .describe("valuation = P/E gap on quarterly financials (profitable companies); valuation_ps = price/sales gap (covers loss-makers); valuation_annual_1y = P/E gap on annual financials (broader non-US coverage); forecast / forecast_annual_1y = relative 1-year return-rank signal."),
  end: z.enum(["top", "bottom"]).default("top")
    .describe("top = highest percentile first (valuation: furthest BELOW typical multiple, i.e. cheapest vs fundamentals; forecast: strongest signal). bottom = lowest first (richest vs fundamentals / weakest signal)."),
  coverage: z.enum(["all", "full", "limited"]).default("all")
    .describe("full = only stocks whose model window (8 quarters / 4 years) is fully populated; limited = the rest."),
  sector: z.string().optional().describe("Exact sector, case-insensitive, e.g. \"Technology\", \"Healthcare\", \"Financial Services\"."),
  country: z.string().optional().describe("Exact country, case-insensitive, e.g. \"United States\", \"Germany\", \"Japan\"."),
  exchange: z.string().optional().describe("Exact exchange code, case-insensitive, e.g. \"NASDAQ\", \"XETRA\", \"LSE\"."),
  limit: z.number().int().min(1).max(100).default(25),
};

function eq(a: string | null | undefined, b: string | undefined): boolean {
  return !b || (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

export function registerScreenValuationModel(server: McpServer): void {
  server.registerTool(
    "screen_valuation_model",
    {
      title: "Screen by Bullrun valuation model",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Rank the whole scored stock universe (market cap >= $100M) by Bullrun's proprietary ML models: the stocks trading furthest below (or above) the P/E or price/sales multiple their fundamentals typically command, or the strongest/weakest relative 1-year forecast signals. Filter by sector, country, exchange and financial-history coverage. Each row has the valuation gap or forecast edge, the model-typical vs current P/E, percentile, rank and data quality. Use for \"cheapest stocks vs fundamentals in Europe\", \"most expensive tech names by the model\", \"best forecast scores in Japan\". The valuation gap is descriptive context, not a return prediction; follow up with get_stock_metrics, get_company_risk and get_quality_moat_metrics before drawing conclusions. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const filtered = Boolean(args.sector || args.country || args.exchange);
        const fetchLimit = filtered ? SCAN_CAP : args.limit;
        const board = await bullrunGet<{ access: string; total: number; rows: MlScore[] }>("/api/ml-scores", {
          model: args.model,
          limit: fetchLimit,
          coverage: args.coverage,
          order: args.end === "bottom" ? "asc" : undefined,
        });

        let rows = board.rows ?? [];
        // Before bullrun-api understood `order`, it always answered best-first; never
        // label that as the bottom of the board.
        const servedAscending = rows.length < 2 || (rows[0].percentile ?? 0) <= (rows[rows.length - 1].percentile ?? 0);
        const warnings: string[] = [];
        if (args.end === "bottom" && !servedAscending) {
          rows = [...rows].reverse();
          warnings.push(`This API version serves the board best-first only, so "bottom" shows the weakest of the top ${rows.length} rows, not the bottom of the whole cohort.`);
        }

        const matches = rows.filter((r) => eq(r.sector, args.sector) && eq(r.country, args.country) && eq(r.exchange, args.exchange));
        if (filtered && board.total > rows.length) {
          warnings.push(`Filters were applied to the ${rows.length} rows nearest the ${args.end} of a ${board.total}-stock cohort; matches further in are not shown.`);
        }
        if (filtered && !matches.length) {
          warnings.push("No scored stock matched the filters. Sector, country and exchange must match exactly (e.g. \"Financial Services\", \"United Kingdom\").");
        }

        const info = MODEL_INFO[args.model];
        return toolResult({
          model: args.model,
          label: info.label,
          end: args.end,
          coverage: args.coverage,
          filters: { sector: args.sector ?? null, country: args.country ?? null, exchange: args.exchange ?? null },
          cohortSize: board.total,
          scanned: rows.length,
          returned: Math.min(matches.length, args.limit),
          rows: matches.slice(0, args.limit).map((r) => {
            const { model: _model, label: _label, ...score } = interpretScore(args.model, r);
            return {
              ticker: r.ticker,
              company: r.company,
              sector: r.sector,
              country: r.country,
              exchange: r.exchange,
              currency: r.currency,
              marketCap: r.marketCap != null ? Math.round(r.marketCap) : null,
              ...score,
            };
          }),
          methodology: info.family === "forecast" ? FORECAST_CAVEAT : VALUATION_CAVEAT,
          warnings,
          webPage: "https://bull-run.org/stocks/undervalued",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `screen_valuation_model failed: ${msg}` }] };
      }
    },
  );
}
