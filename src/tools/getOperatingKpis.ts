import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";

interface OperatingKpi {
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
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
    .describe("The ticker exactly as listed on Bullrun, e.g. \"CRWD\", \"SNOW\", \"V\"."),
  metricKey: z.string().optional()
    .describe("Optional exact metric key to filter, e.g. ARR, NRR, RPO, BILLINGS, PAYMENT_VOLUME."),
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
      annotations: { readOnlyHint: true },
      description:
        "Fetch period-specific operating KPIs and unit-economics metrics for one exact Bullrun ticker: ARR, net revenue retention, RPO, billings, customer counts, payments volume, cross-border volume, processed transactions, or other domain-specific metrics when populated. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        if (!ticker) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };

        const enc = encodeURIComponent(ticker);
        const [identity, rows] = await Promise.all([
          findExactStock(ticker),
          safe(bullrunGet<OperatingKpi[]>(`/api/company-intelligence/${enc}/operating-kpis`, {
            metricKey: args.metricKey,
            category: args.category,
            limit: args.limit,
          })),
        ]);

        const kpis = rows ?? [];
        const payload = {
          ticker,
          identity: identityPayload(identity),
          coverage: {
            rows: kpis.length,
            distinctMetrics: [...new Set(kpis.map((row) => row.metricKey))].sort(),
            categories: [...new Set(kpis.map((row) => row.metricCategory).filter(Boolean))].sort(),
          },
          latestByMetric: latestByMetric(kpis).map((row) => ({ ...row, period: periodLabel(row) })),
          kpis: kpis.map((row) => ({ ...row, period: periodLabel(row) })),
          warnings: kpis.length === 0
            ? ["No operating KPI rows found for this ticker. Add crawler/parser output to operating_kpi to make this tool useful."]
            : [],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_operating_kpis failed: ${msg}` }] };
      }
    },
  );
}
