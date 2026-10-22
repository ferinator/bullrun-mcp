import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { calculatePortfolioLookThroughFit, EXACT_FIT_TICKER, type PortfolioRiskPayload } from "./portfolioFitData.js";

/** Compatibility registration; modern catalogs use get_portfolio_analytics. */
export function registerAnalyzePortfolioFit(server: McpServer): void {
  server.registerTool("analyze_portfolio_fit", {
    title: "Analyze portfolio fit (legacy)",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: "Legacy candidate-fit compatibility tool. Prefer get_portfolio_analytics with candidateTicker and includeLookThrough=true. Combines price-history candidate fit with stored ETF constituents and direct holdings; coverage denominators remain separate and partial snapshots make duplicates a lower bound. Requires OAuth read:portfolios. Read-only.",
    inputSchema: {
      portfolioId: z.number().int().positive().describe("Portfolio id returned by list_portfolios."),
      candidateTicker: z.string().min(1).describe("Exact Bullrun stock or ETF listing ticker to test."),
      candidateWeightPct: z.number().min(0.1).max(50).default(5),
      days: z.number().int().min(30).max(1825).default(370),
      includeLookThrough: z.boolean().default(true),
    },
    outputSchema: {
      portfolioId: z.number().int(), candidateTicker: z.string(), candidateWeightPct: z.number(),
      priceRiskFit: z.record(z.string(), z.unknown()).nullable(),
      lookThroughFit: z.record(z.string(), z.unknown()).nullable(),
      coverage: z.record(z.string(), z.unknown()), warnings: z.array(z.string()),
    },
  }, async args => {
    try {
      requireUserScope("read:portfolios");
      const candidateTicker = args.candidateTicker.trim().toUpperCase();
      if (!EXACT_FIT_TICKER.test(candidateTicker)) {
        return { isError: true, content: [{ type: "text", text: "candidateTicker must be an exact Bullrun stock or ETF listing ticker." }] };
      }
      const [riskPayload, lookThrough] = await Promise.all([
        bullrunGet<PortfolioRiskPayload>(`/api/portfolios/${args.portfolioId}/risk`, {
          days: args.days, candidateTicker, candidateWeightPct: args.candidateWeightPct,
        }),
        calculatePortfolioLookThroughFit({
          portfolioId: args.portfolioId, candidateTicker, candidateWeightPct: args.candidateWeightPct,
          includeLookThrough: args.includeLookThrough,
        }),
      ]);
      const warnings = [...(riskPayload.notes ?? []), ...(lookThrough?.warnings ?? [])];
      if (!riskPayload.candidateFit) warnings.push("Price-history candidate fit is unavailable, usually because aligned return coverage is insufficient.");
      return toolResult({
        portfolioId: args.portfolioId, candidateTicker, candidateWeightPct: args.candidateWeightPct,
        priceRiskFit: riskPayload.candidateFit ?? null,
        lookThroughFit: lookThrough?.lookThroughFit ?? null,
        coverage: { risk: riskPayload.coverage ?? null, ...(lookThrough?.coverage ?? {}) },
        warnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `analyze_portfolio_fit failed: ${msg}` }] };
    }
  });
}
