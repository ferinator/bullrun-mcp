import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet, bullrunPost } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";

interface ShortlistRow {
  id: number;
  ticker: string;
  company: string | null;
  exchange: string | null;
  currency: string | null;
  quoteType: string | null;
  addedAt: string;
  lastClose: number | null;
  lastTradeDate: string | null;
}

const tickerSchema = z.string().trim().min(1).max(80)
  .regex(/^[A-Za-z0-9^][A-Za-z0-9.^=_&/-]*$/, "Use an exact Bullrun listing ticker, not a company name or URL.");
const result = (payload: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
function message(error: unknown, saving = false): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Scope errors are locally constructed. Never forward upstream bodies or internal URLs.
  if (/^Authentication required:|^The access token has no associated Bullrun user|^This tool requires the /.test(detail)) return detail;
  const status = /bullrun-api (\d{3}) /.exec(detail)?.[1];
  if (status === "404" && saving) return "Unknown exact Bullrun listing ticker (HTTP 404); resolve it with search_stocks or search_etfs.";
  if (status === "401" || status === "403") return `Bullrun denied this account request (HTTP ${status}); reconnect with the required shortlist scope.`;
  if (status === "429") return "Bullrun request quota or rate limit reached (HTTP 429); retry later.";
  return `${saving ? "Save was not confirmed" : "Shortlist could not be loaded"}${status ? ` (HTTP ${status})` : ""}. ${saving ? "Check your shortlist or retry this ticker; repeated saves do not add duplicates." : "Retry shortly."}`;
}

export function registerResearchShortlist(server: McpServer): void {
  server.registerTool("list_research_shortlist", {
    title: "Read my research shortlist",
    description: "Read the signed-in user's saved Research Shortlist of stock and ETF listing tickers, with dated stored prices. Requires OAuth read:shortlist. Use after the user asks for their saved research queue. Read-only; does not evaluate a screen, schedule monitoring or send notifications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => {
    try {
      requireUserScope("read:shortlist");
      const items = await bullrunGet<ShortlistRow[]>("/api/short-list");
      return result({ count: items.length, items });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `list_research_shortlist failed: ${message(error)}` }] };
    }
  });

  server.registerTool("save_research_shortlist", {
    title: "Save research to my shortlist",
    description: "Add 1-20 exact Bullrun stock or ETF listing tickers to the signed-in user's Research Shortlist when the user asks to save them. Requires OAuth write:shortlist; reconnect if this scope was not granted. Resolve ambiguous names with search_stocks/search_etfs first. Existing entries are retained; repeated saves are idempotent. Each ticker is saved independently and failures are reported alongside successful saves, so retry only failed tickers. Does not create a portfolio, schedule monitoring or send notifications.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { tickers: z.array(tickerSchema).min(1).max(20).describe("Exact listing tickers chosen by the user, e.g. AAPL or EUNL.DE.") },
  }, async ({ tickers }) => {
    try {
      requireUserScope("write:shortlist");
      const requested = [...new Set(tickers.map(ticker => ticker.toUpperCase()))];
      const items: ShortlistRow[] = [];
      const failures: { ticker: string; message: string }[] = [];
      // Sequential writes keep the per-ticker outcome clear and avoid a burst of account mutations.
      for (const ticker of requested) {
        try {
          const item = await bullrunPost<ShortlistRow>(`/api/short-list/${encodeURIComponent(ticker)}`);
          if (!item || item.ticker?.toUpperCase() !== ticker) throw new Error("Upstream did not confirm the requested ticker; verify the shortlist before retrying.");
          items.push(item);
        } catch (error) {
          failures.push({ ticker, message: message(error, true) });
        }
      }
      const payload = { saved: items.length > 0, requested, savedCount: items.length, partial: failures.length > 0 && items.length > 0, items, failures };
      return { ...result(payload), ...(items.length === 0 ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `save_research_shortlist failed: ${message(error)}` }] };
    }
  });
}
