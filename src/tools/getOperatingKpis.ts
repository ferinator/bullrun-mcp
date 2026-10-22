import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { errorText, identityPayload, resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface OperatingKpi {
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
  periodCode?: string | null;
  metricKey: string;
  source: string;
  metricLabel: string | null;
  metricCategory: string | null;
  metricValue: number | null;
  unit: string | null;
  sourceUrl: string | null;
  updatedAt: string | null;
}

function periodLabel(row: OperatingKpi): string {
  if (row.periodCode && row.periodCode !== "FY") return `FY${row.fiscalYear} ${row.periodCode}`;
  if (row.fiscalQuarter === 0) return `FY${row.fiscalYear}`;
  return `FY${row.fiscalYear} Q${row.fiscalQuarter}`;
}

function latestByMetric(rows: OperatingKpi[]): OperatingKpi[] {
  const seen = new Set<string>();
  const out: OperatingKpi[] = [];
  for (const row of rows) {
    const key = `${row.metricKey}:${row.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Bullrun ticker, e.g. \"CRWD\", \"SNOW\", \"V\". " + TICKER_CONVENTION),
  metricKey: z.string().optional()
    .describe("Optional metric key present in stored coverage. No particular business KPI is guaranteed to be available."),
  category: z.string().optional()
    .describe("Optional category filter such as SaaS, payments, marketplace, banking, or other domain labels."),
  limit: z.number().int().min(1).max(300).default(120)
    .describe("Maximum KPI rows to return."),
};

export function registerGetOperatingKpis(server: McpServer): void {
  server.registerTool(
    "get_operating_kpis",
    {
      title: "Get operating KPIs",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Read curated, source-linked operating KPI observations for one exact Bullrun ticker. Coverage is sparse and no automatic KPI feed is configured: do not assume ARR, retention, customer counts or payments metrics are available. Check get_company_data_coverage first. Returns stored fiscal periods, units and source links; company-economics observations are a separate dataset. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        if (!args.ticker.trim()) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) return { content: [{ type: "text", text: tickerNotFoundText(args.ticker, resolution) }] };
        const ticker = resolution.ticker.toUpperCase();
        const identity = resolution.stock;

        const enc = encodeURIComponent(ticker);
        const rows = await bullrunGet<OperatingKpi[]>(`/api/company-intelligence/${enc}/operating-kpis`, {
          metricKey: args.metricKey,
          category: args.category,
          limit: args.limit,
        });

        const kpis = rows ?? [];
        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(identity),
          coverage: {
            rows: kpis.length,
            feedStatus: "curated_only_no_automatic_feed",
            distinctMetrics: [...new Set(kpis.map((row) => row.metricKey))].sort(),
            categories: [...new Set(kpis.map((row) => row.metricCategory).filter(Boolean))].sort(),
          },
          latestByMetric: latestByMetric(kpis).map((row) => ({ ...row, period: periodLabel(row) })),
          kpis: kpis.map((row) => ({ ...row, period: periodLabel(row) })),
          warnings: kpis.length === 0
            ? ["No curated operating KPIs are stored for this ticker/filter. Missing coverage does not mean the company reports no KPIs. No automatic KPI collection runs on this read."]
            : ["Curated coverage is selective. Do not treat absent metrics as zero or infer complete KPI coverage."],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorText(err, "Operating KPIs",
          "Operating KPIs could not be loaded. Check the exact Bullrun ticker and market-data access, then retry later; unavailable data is not an empty dataset.") }] };
      }
    },
  );
}
