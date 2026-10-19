import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { roundMetric } from "./etfAnalytics.js";
import { toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";
import { aggregateHoldings, HoldingMatcher, identify, type MatchBasis } from "./holdingIdentity.js";

interface PortfolioPosition {
  symbol: string | null;
  ticker: string | null;
  name: string | null;
  marketValueUsd: number | null;
}

interface PortfolioDetail {
  positions?: PortfolioPosition[];
}

interface PortfolioRiskPayload {
  coverage?: Record<string, unknown>;
  candidateFit?: Record<string, unknown> | null;
  notes?: string[];
}

const inputSchema = {
  portfolioId: z.number().int().positive().describe("Portfolio id returned by list_portfolios."),
  candidateTicker: z.string().min(1).describe("Exact Bullrun ETF listing ticker to test."),
  candidateWeightPct: z.number().min(0.1).max(50).default(5),
  days: z.number().int().min(30).max(1825).default(370),
  includeLookThrough: z.boolean().default(true),
};

const outputSchema = {
  portfolioId: z.number().int(),
  candidateTicker: z.string(),
  candidateWeightPct: z.number(),
  priceRiskFit: z.record(z.string(), z.unknown()).nullable(),
  lookThroughFit: z.record(z.string(), z.unknown()).nullable(),
  coverage: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

interface Underlying {
  weightPct: number;
  sources: string[];
}

export function registerAnalyzePortfolioFit(server: McpServer): void {
  server.registerTool(
    "analyze_portfolio_fit",
    {
      title: "Analyze ETF portfolio fit",
      annotations: { readOnlyHint: true },
      description:
        "Analyze an ETF candidate against one signed-in user's portfolio. Combines Bullrun's price-history candidate fit (correlation, beta and pro-forma volatility) with latest-holdings look-through that identifies direct and ETF-contained duplicate underlying positions. Coverage is explicit and partial provider holdings make duplicate exposure a lower bound. Requires OAuth read:portfolios. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requireUserScope("read:portfolios");
        const candidateTicker = args.candidateTicker.trim().toUpperCase();
        const [detail, riskPayload, candidateHoldingsResult, candidateProfile] = await Promise.all([
          bullrunGet<PortfolioDetail>(`/api/portfolios/${args.portfolioId}`),
          bullrunGet<PortfolioRiskPayload>(`/api/portfolios/${args.portfolioId}/risk`, {
            days: args.days,
            candidateTicker,
            candidateWeightPct: args.candidateWeightPct,
          }),
          args.includeLookThrough
            ? safe(bullrunGet<EtfHolding[]>(`/api/etfs/${encodeURIComponent(candidateTicker)}/holdings`))
            : Promise.resolve(null),
          safe(bullrunGet<EtfProfile>(`/api/etfs/${encodeURIComponent(candidateTicker)}/profile`)),
        ]);

        const positions = detail.positions ?? [];
        const pricedValue = positions.reduce((sum, position) => sum + Math.max(0, position.marketValueUsd ?? 0), 0);
        // Underlyings are matched as securities, not symbols (see holdingIdentity):
        // ROP is Roche in one fund's file and Roper Technologies in another's.
        const portfolioUnderlyings = new HoldingMatcher<Underlying>();
        const addUnderlying = (identity: ReturnType<typeof identify>, weightPct: number, source: string) => {
          const hit = portfolioUnderlyings.find(identity);
          if (hit) {
            hit.entry.payload.weightPct += weightPct;
            if (!hit.entry.payload.sources.includes(source)) hit.entry.payload.sources.push(source);
            portfolioUnderlyings.learn(hit.entry, identity);
          } else {
            portfolioUnderlyings.add(identity, { weightPct, sources: [source] });
          }
        };
        let positionsWithLookThrough = 0;
        let portfolioLookThroughSourceWeightPct = 0;

        if (args.includeLookThrough && pricedValue > 0) {
          await Promise.all(positions.map(async (position) => {
            const ticker = (position.ticker ?? position.symbol)?.trim().toUpperCase();
            const value = Math.max(0, position.marketValueUsd ?? 0);
            if (!ticker || value <= 0) return;
            const positionWeightPct = value / pricedValue * 100;
            const holdings = await safe(bullrunGet<EtfHolding[]>(`/api/etfs/${encodeURIComponent(ticker)}/holdings`));
            if (holdings?.length) {
              positionsWithLookThrough++;
              portfolioLookThroughSourceWeightPct += positionWeightPct;
              for (const entry of aggregateHoldings(holdings).matcher.entries) {
                addUnderlying(entry.identity, positionWeightPct * entry.payload.weightPct / 100, ticker);
              }
            } else {
              addUnderlying(identify({ holdingSymbol: ticker, holdingName: position.name }), positionWeightPct, ticker);
            }
          }));
        }

        const candidateHoldings = candidateHoldingsResult ?? [];
        const duplicateRows = aggregateHoldings(candidateHoldings).matcher.entries
          .map((entry) => {
            const hit = portfolioUnderlyings.find(entry.identity);
            if (!hit) return null;
            const candidateHoldingWeightPct = entry.payload.weightPct;
            return {
              symbol: entry.payload.symbol,
              name: entry.payload.name,
              matchedOn: hit.basis as MatchBasis,
              candidateHoldingWeightPct: roundMetric(candidateHoldingWeightPct, 4) ?? 0,
              existingPortfolioLookThroughWeightPct: roundMetric(hit.entry.payload.weightPct, 4),
              candidateAllocationDuplicateWeightPct: roundMetric(candidateHoldingWeightPct * args.candidateWeightPct / 100, 4),
              existingSources: hit.entry.payload.sources,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row != null)
          .sort((a, b) => b.candidateAllocationDuplicateWeightPct! - a.candidateAllocationDuplicateWeightPct!);
        const candidateCoveredWeightPct = candidateHoldings.reduce((sum, holding) => sum + (holding.weightPct ?? 0), 0);
        const reportedCandidateHoldings = candidateProfile?.holdingsCount ?? null;
        const candidateHoldingsComplete = reportedCandidateHoldings == null
          ? null
          : candidateHoldings.length >= reportedCandidateHoldings && candidateCoveredWeightPct >= 98;
        const warnings = [...(riskPayload.notes ?? [])];
        if (args.includeLookThrough && candidateHoldingsComplete !== true) {
          warnings.push("Candidate holdings are partial or completeness is unknown; duplicate exposure is a lower bound.");
        }
        if (args.includeLookThrough && positionsWithLookThrough > 0) {
          warnings.push("Portfolio ETF look-through uses each fund's latest stored, potentially partial snapshot; snapshot dates can differ.");
        }
        const pricedPositionCount = positions.filter((position) => (position.marketValueUsd ?? 0) > 0).length;
        if (pricedPositionCount < positions.length) warnings.push("Unpriced portfolio positions are excluded from look-through weights, which are renormalized over priced positions.");
        if (!riskPayload.candidateFit) warnings.push("Price-history candidate fit is unavailable, usually because aligned return coverage is insufficient.");

        return toolResult({
          portfolioId: args.portfolioId,
          candidateTicker,
          candidateWeightPct: args.candidateWeightPct,
          priceRiskFit: riskPayload.candidateFit ?? null,
          lookThroughFit: args.includeLookThrough
            ? {
                duplicateUnderlyingCount: duplicateRows.length,
                candidateHoldingsWeightAlreadyPresentPct: roundMetric(duplicateRows.reduce((sum, row) => sum + row.candidateHoldingWeightPct, 0)),
                proposedPortfolioWeightInDuplicateUnderlyingsPct: roundMetric(duplicateRows.reduce((sum, row) => sum + (row.candidateAllocationDuplicateWeightPct ?? 0), 0)),
                topDuplicateUnderlyings: duplicateRows.slice(0, 25),
              }
            : null,
          coverage: {
            risk: riskPayload.coverage ?? null,
            portfolioPositions: positions.length,
            pricedPortfolioPositions: pricedPositionCount,
            portfolioEtfPositionsWithLookThrough: positionsWithLookThrough,
            portfolioEtfPositionWeightWithLookThroughPct: roundMetric(portfolioLookThroughSourceWeightPct),
            candidateStoredHoldingRows: candidateHoldings.length,
            candidateReportedHoldingsCount: reportedCandidateHoldings,
            candidateCoveredWeightPct: roundMetric(candidateCoveredWeightPct),
            candidateHoldingsComplete,
          },
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `analyze_portfolio_fit failed: ${msg}` }] };
      }
    },
  );
}
