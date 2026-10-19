import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";

interface Coverage {
  ticker: string;
  companyName: string | null;
  checkedAt: string;
  datasets: Array<Record<string, unknown>>;
  graph: Record<string, unknown> | null;
  caveats: string[];
}

export function registerGetCompanyDataCoverage(server: McpServer): void {
  server.registerTool("get_company_data_coverage", {
    title: "Get company data availability and freshness",
    annotations: { readOnlyHint: true },
    description: "A cheap stored-data manifest for one exact company: available datasets, latest reporting periods, actual ingestion/computation timestamps where stored, and cached relationship graph status. Call before deeper research when coverage or freshness is uncertain. This reads indexed metadata, not every research endpoint, and never starts enrichment. Availability is not completeness or accuracy. A null stored timestamp means freshness is unknown; a reporting period is not an ingestion date. Read-only.",
    inputSchema: { ticker: z.string().trim().min(1).max(32).describe("Exact native Bullrun company ticker, e.g. AAPL or SAP.") },
  }, async ({ ticker: rawTicker }) => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text", text: 'get_company_data_coverage requires the "read:market" scope.' }] }; }
    try {
      const ticker = rawTicker.trim().toUpperCase();
      const data = await bullrunGet<Coverage>(`/api/stocks/${encodeURIComponent(ticker)}/data-coverage`, undefined, 8_000);
      if (typeof data.ticker !== "string" || data.ticker.toUpperCase() !== ticker || !Array.isArray(data.datasets)) {
        return { isError: true, content: [{ type: "text", text: "Coverage lookup returned an unexpected company identity or data shape." }] };
      }
      return toolResult({
        ticker, companyName: data.companyName ?? null, checkedAt: data.checkedAt ?? null,
        datasets: data.datasets, graph: data.graph ?? null,
        warnings: [
          ...(Array.isArray(data.caveats) ? data.caveats : []),
          "checkedAt is the time this manifest was read, not the time its datasets were collected. Read latestStoredAt together with storedAtMeaning. A null absolute timestamp means UTC freshness is unknown; latestStoredLocalAt may preserve a local clock reading whose timezone was not recorded.",
          "Stored rows do not guarantee complete company, geographic or period coverage. Missing data is unknown, not a zero measurement.",
        ],
      });
    } catch {
      return { isError: true, content: [{ type: "text", text: "Company data coverage could not be loaded. Check the exact ticker and retry; no enrichment or paid discovery was started." }] };
    }
  });
}
