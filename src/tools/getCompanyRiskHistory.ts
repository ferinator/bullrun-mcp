import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { RISK_METHOD_NOTE } from "./riskData.js";
import { errorText, resolveStockTicker, storedRead, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value != null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const MAX_RESPONSE_BYTES = 200 * 1024;

export function registerGetCompanyRiskHistory(server: McpServer): void {
  server.registerTool("get_company_risk_history", {
    title: "Get company risk history and changes",
    annotations: { readOnlyHint: true },
    description: "Stored historical company risk category readings and their observed input changes. Shows dates, computation times, formula versions, score changes, changing input coverage and measurement bases. Use for 'how has X's risk changed?' and 'which inputs changed?'. These are retained category scores, not a complete daily series or proof of causation. Missing history is unknown, never a zero risk score. Read-only; does not run risk computation or paid discovery.",
    inputSchema: {
      ticker: z.string().trim().min(1).max(32).describe("Bullrun company ticker, e.g. AAPL, SAP or 6324.T. " + TICKER_CONVENTION),
      limit: z.number().int().min(1).max(30).default(6).describe("Latest stored run dates to return, oldest first. Retention and gaps vary. Full detail supports at most six dates."),
      detail: z.enum(["summary", "full"]).default("summary").describe("Summary keeps scores, explanations and up to three changed inputs per category; full includes stored input terms and all returned term changes."),
    },
  }, async ({ ticker: rawTicker, limit, detail }) => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text", text: 'get_company_risk_history requires the "read:market" scope.' }] }; }
    try {
      let ticker = rawTicker.trim().toUpperCase();
      if (detail === "full" && limit > 6) return { isError: true, content: [{ type: "text", text: "Full risk history supports at most six stored dates. Reduce limit or use summary detail." }] };
      let note: string | null = null;
      const read = (symbol: string) => storedRead(
        bullrunGet<Row>(`/api/stocks/${encodeURIComponent(symbol)}/risk-history`, { limit }, 8_000), "Company risk history");
      let data = await read(ticker);
      if (!data) {
        // The endpoint matches stored tickers exactly. Only a miss pays for resolving a bare
        // code (6324 -> 6324.T), a Yahoo suffix or a retired ticker.
        const resolution = await resolveStockTicker(ticker);
        const resolved = resolution.ticker?.toUpperCase();
        if (!resolved) return { isError: true, content: [{ type: "text", text: tickerNotFoundText(rawTicker, resolution) }] };
        if (resolved !== ticker) data = await read(resolved);
        if (!data) return { isError: true, content: [{ type: "text", text: `Bullrun lists ${resolved}, but returned no risk history for it; retry later.` }] };
        ticker = resolved;
        note = resolution.note;
      }
      if (typeof data.ticker !== "string" || data.ticker.toUpperCase() !== ticker || !Array.isArray(data.history)) {
        return { isError: true, content: [{ type: "text", text: "Risk history returned an unexpected company identity or data shape." }] };
      }
      const history = rows(data.history).slice(0, limit).map(run => ({
        ...run,
        dials: rows(run.dials).map(reading => {
          const { terms, change, ...rest } = reading;
          const observed = record(change);
          const changes = rows(observed.termChanges);
          return {
            ...rest,
            ...(detail === "full" ? { terms: Array.isArray(terms) ? terms : [] } : {}),
            change: change == null ? null : { ...observed,
              termChanges: detail === "full" ? changes : changes.slice(0, 3),
              returnedTermChanges: detail === "full" ? changes.length : Math.min(changes.length, 3),
              omittedTermChanges: detail === "full" ? 0 : Math.max(0, changes.length - 3),
            },
          };
        }),
      }));
      const payload = {
        ticker, ...(note ? { tickerResolution: note } : {}),
        companyName: data.companyName ?? null, requestedDates: limit, returnedDates: history.length,
        detail, status: history.length ? "available" : "not_stored", history,
        omittedDatesForResponseBudget: 0,
        methodNote: RISK_METHOD_NOTE,
        warnings: [
          ...(Array.isArray(data.caveats) ? data.caveats : []),
          "The dials array contains stored risk category readings. Dates may be sparse or pruned; a missing date is not an unchanged score.",
          "Observed score and input changes are descriptive. Formula, coverage, peer-group or weight-profile changes can change the measurement basis; they do not establish a business event or causal loss.",
          ...(history.length ? [] : ["No retained risk history is stored for this exact ticker."]),
        ],
      };
      while (Buffer.byteLength(JSON.stringify(toolResult(payload)), "utf8") > MAX_RESPONSE_BYTES && history.length > 1) {
        history.shift(); // Keep the latest complete stored dates in chronological order.
        payload.returnedDates = history.length;
        payload.omittedDatesForResponseBudget++;
        if (payload.omittedDatesForResponseBudget === 1) payload.warnings.push("The response size budget omitted older dates. A change's previousAsOfDate may refer to an omitted date; request fewer dates or summary detail for a smaller result.");
      }
      if (Buffer.byteLength(JSON.stringify(toolResult(payload)), "utf8") > MAX_RESPONSE_BYTES) {
        return { isError: true, content: [{ type: "text", text: "Stored risk history exceeds the response size limit even for one date. Use summary detail or inspect the company's focused risk profile." }] };
      }
      const result = toolResult(payload);
      return history.length ? result : { ...result, isError: true };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: errorText(err, "Company risk history",
        "Company risk history could not be loaded. Check the exact ticker and retry; retained history may be unavailable.") }] };
    }
  });
}
