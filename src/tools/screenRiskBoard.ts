import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, NOT_REQUESTED, settle } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import {
  BAND_SCALE,
  RISK_BANDS,
  RISK_MECHANISMS,
  RISK_METHOD_NOTE,
  compactBoardEntry,
  type RiskBoardEntry,
} from "./riskData.js";

interface RiskBoard {
  entries: RiskBoardEntry[] | null;
  total: number;
  offset: number;
  summary: {
    companies: number;
    asOfDate: string | null;
    bands: Array<{ band: string; label: string; meaning: string; companies: number; sharePct: number }>;
    mechanism: string;
    changes: Record<string, unknown> | null;
  } | null;
  mechanisms: Array<{ key: string; label: string; reads: string; companies: number }> | null;
}

interface BoardSlice { name: string; companies: number; meanScore: number; meanBand: string }

const SORTS = {
  market_cap: undefined,
  score_desc: "score",
  score_asc: "score-asc",
  worsened: "move",
  improved: "improved",
  coverage: "coverage",
  name: "name",
} as const;

const inputSchema = {
  mechanism: z.enum(["OVERALL", ...RISK_MECHANISMS]).default("OVERALL")
    .describe("Rank by the composite (OVERALL) or by one mechanism dial: MARKET (drawdown, volatility, liquidity), OPERATING (margin/cost pressure), CASH_CONVERSION (cash vs earnings, capex), LEVERAGE (debt, interest cover, liquidity; CET1 for banks), COMPETITIVE (R&D, margins vs peers, technology transition), CONCENTRATION (supplier, customer, geographic)."),
  bands: z.array(z.enum(RISK_BANDS)).optional()
    .describe("Keep only these bands, e.g. [\"STRETCHED\",\"ACUTE\"] for the most strained readings or [\"CONTAINED\"] for the calmest."),
  sector: z.string().optional().describe("Exact sector, case-insensitive (e.g. \"Technology\", \"Industrials\"). Set includeSlices=true to list the sectors the board covers."),
  country: z.string().optional().describe("Exact country, case-insensitive (e.g. \"United States\", \"Germany\")."),
  minDialsLit: z.number().int().min(0).max(6).default(0)
    .describe("Coverage floor: only companies with at least this many of the six dials measured. 4+ avoids thinly-measured composites."),
  sortBy: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default("market_cap")
    .describe("market_cap = largest companies first (default; a pure score sort surfaces micro-caps); score_desc = most strained first; score_asc = calmest first; worsened / improved = biggest move since the prior reading; coverage = most dials lit; name."),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(20000).default(0),
  includeSlices: z.boolean().default(false)
    .describe("Also return mean composite risk by sector and by country across the scored universe."),
};

export function registerScreenRiskBoard(server: McpServer): void {
  server.registerTool(
    "screen_risk_board",
    {
      title: "Screen the risk board",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Rank Bullrun's scored stock universe (~9,000 companies) by company risk: the composite risk score or any one mechanism dial (market expectation, operating pressure, cash conversion, leverage, competitive position, concentration), filtered by band, sector, country and dial coverage. Returns ticker, score, band and its meaning, direction and move since the prior reading, and the driving input per row, plus the universe band distribution and how many companies changed band at the last recompute. Use for \"which large caps have stretched leverage\", \"most concentrated supply chains in semiconductors\", \"calmest German industrials\", or \"how risky is tech vs utilities\" (includeSlices). Drill into a row with get_company_risk. A ranking of readings, not of companies to avoid. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const [board, slicesRead] = await Promise.all([
          bullrunGet<RiskBoard>("/api/company-intelligence/risk-board", {
            mechanism: args.mechanism === "OVERALL" ? undefined : args.mechanism,
            band: args.bands?.length ? args.bands.join(",") : undefined,
            sector: args.sector?.trim(),
            country: args.country?.trim(),
            minCoverage: args.minDialsLit || undefined,
            sort: SORTS[args.sortBy],
            limit: args.limit,
            offset: args.offset,
          }),
          args.includeSlices
            ? settle(bullrunGet<{ sectors: BoardSlice[]; countries: BoardSlice[] }>(
                "/api/company-intelligence/risk-board/slices", { minCompanies: 8, limit: 60 }))
            : Promise.resolve(NOT_REQUESTED),
        ]);
        const slices = slicesRead.data;

        const rows = (board.entries ?? []).map(compactBoardEntry);
        const warnings: string[] = [];
        // Requested slices that failed to load are named, not silently left out.
        if (slicesRead.failure) warnings.push(failureText("The sector and country slices", slicesRead.failure));
        if (!rows.length) {
          warnings.push("No scored companies match these filters. Sector and country must match exactly (includeSlices=true lists the covered values).");
        }
        if (args.mechanism !== "OVERALL") {
          warnings.push(`Rows carry the ${args.mechanism} dial's reading, not the composite.`);
        }

        return toolResult({
          mechanism: args.mechanism,
          filters: {
            bands: args.bands ?? [],
            sector: args.sector ?? null,
            country: args.country ?? null,
            minDialsLit: args.minDialsLit,
          },
          sortBy: args.sortBy,
          total: board.total,
          offset: args.offset,
          returned: rows.length,
          nextOffset: args.offset + rows.length < board.total ? args.offset + rows.length : null,
          universe: board.summary
            ? {
                companiesScored: board.summary.companies,
                asOfDate: board.summary.asOfDate,
                bandDistribution: board.summary.bands.map((b) => ({
                  band: b.band, meaning: b.meaning, companies: b.companies, sharePct: b.sharePct,
                })),
                changesAtLastRecompute: board.summary.changes,
              }
            : null,
          rows,
          ...(slices
            ? {
                slices: {
                  sectors: slices.sectors.map((s) => ({ name: s.name, companies: s.companies, meanScore: s.meanScore, meanBand: s.meanBand })),
                  countries: slices.countries.map((s) => ({ name: s.name, companies: s.companies, meanScore: s.meanScore, meanBand: s.meanBand })),
                },
              }
            : {}),
          mechanisms: (board.mechanisms ?? []).map((m) => ({ key: m.key, label: m.label, reads: m.reads, companiesScored: m.companies })),
          methodology: RISK_METHOD_NOTE,
          bandScale: BAND_SCALE,
          warnings,
          webPage: "https://bull-run.org/analysis",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `screen_risk_board failed: ${msg}` }] };
      }
    },
  );
}
