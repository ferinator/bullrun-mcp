import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";

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
    .describe("The ticker exactly as listed on Bullrun, e.g. \"CRWD\", \"SPGI\", \"V\"."),
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
        "Fetch speaker-tagged earnings-call transcript chunks for one exact Bullrun ticker, optionally filtered by fiscal period or search text. Use this for management guidance language, analyst Q&A, and qualitative judgment that is not visible in financial statements. Read-only.",
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
          safe(bullrunGet<TranscriptChunk[]>(`/api/company-intelligence/${enc}/earnings-call-transcripts`, {
            fiscalYear: args.fiscalYear,
            fiscalQuarter: args.fiscalQuarter,
            q: args.search,
            limit: args.maxChunks,
          })),
        ]);

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
          identity: identityPayload(identity),
          coverage: {
            chunks: chunks.length,
            requestedFiscalYear: args.fiscalYear ?? null,
            requestedFiscalQuarter: args.fiscalQuarter ?? null,
            search: args.search ?? null,
            truncatedChunks,
          },
          chunks: mapped,
          warnings: chunks.length === 0
            ? ["No transcript chunks found for this ticker/period/search. Populate earnings_call_transcript to answer call-language questions."]
            : truncatedChunks > 0
              ? [`${truncatedChunks} transcript chunks were truncated by maxCharsPerChunk; increase it for fuller text.`]
              : [],
        };

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_earnings_call_transcript failed: ${msg}` }] };
      }
    },
  );
}
