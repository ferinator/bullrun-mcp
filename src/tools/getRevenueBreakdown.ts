import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { identityPayload, resolveStockTicker, safe, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface RevenueBreakdown {
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
  dimension: "SEGMENT" | "GEOGRAPHY" | "PRODUCT" | "CUSTOMER" | "OTHER";
  segmentName: string;
  source: string;
  revenue: number | null;
  sourceCurrency: string | null;
  sourceUrl: string | null;
  updatedAt: string | null;
}

function periodLabel(row: RevenueBreakdown): string {
  if (row.fiscalQuarter === 0) return `FY${row.fiscalYear}`;
  return `FY${row.fiscalYear} Q${row.fiscalQuarter}`;
}

function round2(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function addPercentages(rows: RevenueBreakdown[]): Record<string, unknown>[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.revenue == null) continue;
    const key = `${row.fiscalYear}:${row.fiscalQuarter}:${row.dimension}:${row.source}`;
    totals.set(key, (totals.get(key) ?? 0) + row.revenue);
  }

  return rows.map((row) => {
    const key = `${row.fiscalYear}:${row.fiscalQuarter}:${row.dimension}:${row.source}`;
    const total = totals.get(key) ?? null;
    return {
      ...row,
      period: periodLabel(row),
      revenuePctOfDimension: row.revenue != null && total != null && total !== 0
        ? round2((row.revenue / total) * 100)
        : null,
    };
  });
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("The Bullrun ticker, e.g. \"SPGI\", \"MSFT\", \"V\". " + TICKER_CONVENTION),
  dimension: z.enum(["segment", "geography", "product", "customer", "other", "all"]).default("all")
    .describe("Breakdown dimension to return, or all dimensions."),
  limit: z.number().int().min(1).max(300).default(160)
    .describe("Maximum breakdown rows to return."),
};

export function registerGetRevenueBreakdown(server: McpServer): void {
  server.registerTool(
    "get_revenue_breakdown",
    {
      title: "Get revenue breakdown",
      annotations: { readOnlyHint: true },
      description:
        "Fetch segment, geography, product, customer, or other revenue breakdown rows for one exact Bullrun ticker. Use this to separate cyclical businesses from recurring segments or inspect geographic exposure instead of relying on blended revenue. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) {
          return { content: [{ type: "text" as const, text: tickerNotFoundText(args.ticker, resolution) }] };
        }
        const ticker = resolution.ticker;
        if (!ticker) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };

        const enc = encodeURIComponent(ticker);
        const dimension = args.dimension === "all" ? undefined : args.dimension.toUpperCase();
        const [identity, rows] = await Promise.all([
          Promise.resolve(resolution.stock),
          safe(bullrunGet<RevenueBreakdown[]>(`/api/company-intelligence/${enc}/revenue-breakdown`, {
            dimension,
            limit: args.limit,
          })),
        ]);

        const breakdown = rows ?? [];
        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(identity),
          coverage: {
            rows: breakdown.length,
            dimensions: [...new Set(breakdown.map((row) => row.dimension))].sort(),
            sourceCurrencies: [...new Set(breakdown.map((row) => row.sourceCurrency).filter(Boolean))].sort(),
          },
          breakdown: addPercentages(breakdown),
          warnings: breakdown.length === 0
            ? ["No revenue breakdown rows found for this ticker. Populate revenue_breakdown from segment/geography filings to answer this class of question."]
            : [],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_revenue_breakdown failed: ${msg}` }] };
      }
    },
  );
}
