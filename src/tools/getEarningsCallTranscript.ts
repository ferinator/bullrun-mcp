import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { errorText, identityPayload, resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface TranscriptChunk {
  ticker: string;
  fiscalYear: number;
  fiscalQuarter: number;
  sequenceNo: number;
  source: string;
  eventDate: string | null;
  speakerName: string | null;
  speakerRole: string | null;
  section: "PREPARED_REMARKS" | "Q_AND_A" | "OPERATOR" | "OTHER" | null;
  transcriptText: string;
  sourceUrl: string | null;
  updatedAt: string | null;
}

function periodLabel(row: TranscriptChunk): string {
  return `FY${row.fiscalYear} Q${row.fiscalQuarter}`;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}...`, truncated: true };
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Bullrun ticker, e.g. \"CRWD\", \"SPGI\", \"V\". " + TICKER_CONVENTION),
  fiscalYear: z.number().int().min(1900).max(2200).optional()
    .describe("Optional fiscal year filter."),
  fiscalQuarter: z.number().int().min(1).max(4).optional()
    .describe("Optional fiscal quarter filter."),
  search: z.string().optional()
    .describe("Optional case-insensitive text/speaker search across transcript chunks."),
  maxChunks: z.number().int().min(1).max(200).default(80)
    .describe("Maximum speaker-tagged transcript chunks to return."),
  maxCharsPerChunk: z.number().int().min(200).max(4000).default(1600)
    .describe("Maximum characters per transcript chunk in the MCP response."),
};

export function registerGetEarningsCallTranscript(server: McpServer): void {
  server.registerTool(
    "get_earnings_call_transcript",
    {
      title: "Get earnings call transcript",
      annotations: { readOnlyHint: true },
      description:
        "Read cached earnings-call paragraphs for one exact Bullrun ticker, optionally filtered by fiscal period or search text. A best-effort free background import collects at most the two latest retained calls from DefeatBeta for supported US listings, with a 24-hour stored-data cooldown; the first read may be empty. Coverage and source publication lag vary. Speaker names and paragraph order are retained; roles and prepared/Q&A section labels may be unavailable. This is a read-only research operation.",
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
        const rows = await bullrunGet<TranscriptChunk[]>(`/api/company-intelligence/${enc}/earnings-call-transcripts`, {
          fiscalYear: args.fiscalYear,
          fiscalQuarter: args.fiscalQuarter,
          q: args.search,
          limit: args.maxChunks,
        });

        const chunks = rows ?? [];
        let truncatedChunks = 0;
        const mapped = chunks.map((row) => {
          const trimmed = truncate(row.transcriptText, args.maxCharsPerChunk);
          if (trimmed.truncated) truncatedChunks += 1;
          return {
            period: periodLabel(row),
            fiscalYear: row.fiscalYear,
            fiscalQuarter: row.fiscalQuarter,
            eventDate: row.eventDate,
            sequenceNo: row.sequenceNo,
            speakerName: row.speakerName,
            speakerRole: row.speakerRole,
            section: row.section,
            text: trimmed.text,
            source: row.source,
            sourceUrl: row.sourceUrl,
          };
        });

        const payload = {
          ticker,
          ...(resolution.note ? { tickerResolution: resolution.note } : {}),
          identity: identityPayload(identity),
          coverage: {
            chunks: chunks.length,
            refreshPolicy: "cached read; best-effort background import of at most two retained US calls; completion is not awaited",
            requestedFiscalYear: args.fiscalYear ?? null,
            requestedFiscalQuarter: args.fiscalQuarter ?? null,
            search: args.search ?? null,
            truncatedChunks,
          },
          chunks: mapped,
          warnings: [
            ...(chunks.length === 0 ? ["No matching transcript paragraphs are currently stored. A supported US listing may be importing in the background; other listings or older requested periods may have no source coverage. This response does not confirm refresh completion."] : []),
            ...(chunks.length >= args.maxChunks ? ["The paragraph limit was reached; the returned transcript may be partial. Narrow the fiscal period or search, or increase maxChunks."] : []),
            ...(truncatedChunks > 0 ? [`${truncatedChunks} transcript chunks were truncated by maxCharsPerChunk; increase it for fuller text.`] : []),
            "Speaker roles and prepared-remarks/Q&A labels are not supplied by the configured DefeatBeta feed; OTHER is an unspecified section.",
          ],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorText(err, "Earnings-call transcripts",
          "Earnings-call transcripts could not be loaded. Check the exact Bullrun ticker and market-data access, then retry later; no refresh completion can be confirmed.") }] };
      }
    },
  );
}
