import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { toolResult, type EtfHolding, type EtfProfile } from "./etfData.js";

interface HoldingsCursor {
  v: 1;
  ticker: string;
  asOfDate: string | null;
  offset: number;
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Exact Bullrun ETF listing ticker, including its exchange suffix when present."),
  cursor: z.string().optional()
    .describe("Opaque nextCursor returned by a previous get_etf_holdings call for the same ticker."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum holdings to return on this page, 1-100."),
};

const outputSchema = {
  ticker: z.string(),
  asOfDate: z.string().nullable(),
  returned: z.number().int().nonnegative(),
  totalRowsAvailable: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  coverage: z.record(z.string(), z.unknown()),
  holdings: z.array(z.record(z.string(), z.unknown())),
};

function encodeCursor(cursor: HoldingsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, ticker: string): HoldingsCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HoldingsCursor>;
    if (decoded.v !== 1 || decoded.ticker !== ticker ||
        !Number.isInteger(decoded.offset) || (decoded.offset ?? -1) < 0 ||
        (decoded.asOfDate !== null && typeof decoded.asOfDate !== "string")) {
      throw new Error("cursor fields do not match");
    }
    return decoded as HoldingsCursor;
  } catch {
    throw new Error("Invalid holdings cursor. Use the unmodified nextCursor from the previous page for this ticker.");
  }
}

export function registerGetEtfHoldings(server: McpServer): void {
  server.registerTool(
    "get_etf_holdings",
    {
      title: "Get ETF holdings",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Return the latest stored ETF holdings snapshot with opaque cursor pagination. The response reports the provider's stated holdings count, stored row count, covered weight, and whether the stored rows appear complete. Treat isComplete=false or null as partial look-through data. Historical as-of selection will be added when the upstream API exposes it. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const cursor = args.cursor ? decodeCursor(args.cursor, ticker) : null;
        const enc = encodeURIComponent(ticker);
        const [rowsResult, profile] = await Promise.all([
          bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`),
          safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
        ]);
        const rows = rowsResult ?? [];
        const asOfDate = rows[0]?.asOfDate ?? null;
        if (cursor && cursor.asOfDate !== asOfDate) {
          throw new Error("The holdings snapshot changed between pages. Restart pagination without a cursor.");
        }

        const offset = cursor?.offset ?? 0;
        if (offset > rows.length) {
          throw new Error("The holdings cursor is beyond the available result set. Restart pagination without a cursor.");
        }
        const page = rows.slice(offset, offset + args.limit);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < rows.length
          ? encodeCursor({ v: 1, ticker, asOfDate, offset: nextOffset })
          : null;
        const coveredWeightPct = Number(rows.reduce(
          (sum, row) => sum + (typeof row.weightPct === "number" ? row.weightPct : 0),
          0,
        ).toFixed(8));
        const reportedHoldingsCount = profile?.holdingsCount ?? null;
        const isComplete = reportedHoldingsCount == null
          ? null
          : rows.length >= reportedHoldingsCount && coveredWeightPct >= 98;

        return toolResult({
          ticker,
          asOfDate,
          returned: page.length,
          totalRowsAvailable: rows.length,
          nextCursor,
          coverage: {
            reportedHoldingsCount,
            storedRows: rows.length,
            coveredWeightPct,
            isComplete,
            note: isComplete === true
              ? "Stored rows meet or exceed the provider-reported holdings count."
              : "Stored rows may be a top-holdings subset; do not treat them as complete fund look-through.",
            source: profile?.source ?? page[0]?.source ?? null,
            sourceUpdatedAt: profile?.sourceUpdatedAt ?? null,
          },
          holdings: page.map((row) => ({
            holdingKey: row.holdingKey,
            symbol: row.holdingSymbol,
            name: row.holdingName,
            weightPct: row.weightPct,
            shares: row.shares,
            marketValue: row.marketValue,
            currency: row.currency,
            source: row.source ?? null,
            updatedAt: row.updatedAt,
          })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_holdings failed: ${msg}` }] };
      }
    },
  );
}
