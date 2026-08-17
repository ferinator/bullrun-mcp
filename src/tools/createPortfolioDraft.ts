import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet, bullrunPost } from "../bullrun.js";
import { requireUserScope } from "../auth/scopes.js";

interface JobStarted {
  jobId: string;
  status: string;
}

interface AiDraftPosition {
  ticker: string;
  company: string | null;
  sector: string | null;
  country: string | null;
  instrumentType?: string | null;
  weightPct: number;
  allocationUsd: number;
  quantity: number;
  avgPrice: number | null;
  currency: string | null;
  rationale: string | null;
}

interface AiDraft {
  name: string;
  startingCash: number;
  cashPct: number;
  cashBalance: number;
  positions: AiDraftPosition[];
  notes: string[];
  model: string;
  fallback: boolean;
}

interface JobStatus {
  status: "running" | "done" | "error";
  draft?: AiDraft | null;
  draftId?: number | null;
  code?: string | null;
  message?: string | null;
}

const POLL_INTERVAL_MS = 3000;
/** The local LLM can take a while on a cold CPU-only box; cap the wait. */
const MAX_WAIT_MS = Number(process.env.MCP_DRAFT_MAX_WAIT_MS ?? "600000");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BriefOutcome =
  | { kind: "ok"; brief: string }
  | { kind: "unsupported" }
  | { kind: "declined" };

/**
 * Elicitation spike: when the tool is called with no brief, try to gather one with a
 * native client-rendered form (style / region / size as single-select fields).
 *
 * This is strictly capability-gated — `elicitInput` is a server->client request that
 * throws if the client never advertised the `elicitation` capability, so we check
 * `getClientCapabilities()` first and report `unsupported` (the caller then falls back
 * to gathering the brief conversationally). The flow NEVER depends on elicitation being
 * present; it is purely an enhancement for clients (e.g. Claude Code) that support it.
 */
async function gatherBriefViaElicitation(server: McpServer): Promise<BriefOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) return { kind: "unsupported" };

  const result = await server.server.elicitInput({
    message: "Let's quickly scope your new portfolio.",
    requestedSchema: {
      type: "object",
      properties: {
        style: {
          type: "string",
          title: "Investing style",
          enum: ["Dividend income", "Growth", "Defensive", "Broad-market", "Quality / moat", "Value"],
          default: "Broad-market",
        },
        region: {
          type: "string",
          title: "Region focus",
          enum: ["US", "Europe", "Global"],
          default: "Global",
        },
        size: {
          type: "string",
          title: "Approximate size",
          enum: ["~$10k", "~$25k", "~$50k", "~$100k"],
          default: "~$10k",
        },
      },
      required: [],
    },
  });

  if (result.action !== "accept" || !result.content) return { kind: "declined" };
  const style = String(result.content.style ?? "Broad-market");
  const region = String(result.content.region ?? "Global");
  const size = String(result.content.size ?? "~$10k");
  return { kind: "ok", brief: `A ${style.toLowerCase()} portfolio of ${region} equities, roughly ${size}.` };
}

export function registerCreatePortfolioDraft(server: McpServer): void {
  server.registerTool(
    "create_portfolio_draft",
    {
      title: "Create a portfolio draft",
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Use when the user wants you to BUILD or PROPOSE a brand-new portfolio for them — e.g. \"build me a portfolio\", \"put together a dividend portfolio\", \"draft a portfolio of AI stocks\", \"create a new portfolio for $10k\". Generates a REVIEWABLE paper-portfolio draft for the signed-in Bullrun user from a natural-language brief (e.g. \"a diversified European dividend portfolio\"). Requires OAuth with the write:drafts scope and a Bullrun Pro account. This is DRAFT-ONLY and never changes any live position: the draft is saved to the user's account and appears in the Bullrun Portfolio tab under \"Pending AI drafts\", where the user reviews it and explicitly accepts it to create a new portfolio (or discards it). To suggest additions to an EXISTING portfolio instead, use create_position_draft. Tickers are chosen only from Bullrun's priced stock/ETF universe; pass instrumentUniverse for stocks only, ETFs only, or a mix. If the brief is vague, first ask ONE quick round of up to three multiple-choice questions (investing style, region focus, and size), each with a default the user can accept with \"just pick for me\", then build; skip any dimension the user already specified and do not interrogate across multiple turns.",
      inputSchema: {
        prompt: z
          .string()
          .max(600)
          .optional()
          .describe(
            'What kind of portfolio to draft, e.g. "a defensive dividend portfolio of large EU stocks". Optional: if you omit it, the server collects a quick style/region/size brief from the user directly (a native form on clients that support elicitation; otherwise it asks you to gather those first).',
          ),
        startingCash: z
          .number()
          .min(100)
          .max(100_000_000)
          .optional()
          .describe("Starting cash in USD (default 10000)."),
        maxPositions: z
          .number()
          .int()
          .min(3)
          .max(20)
          .optional()
          .describe("Maximum number of holdings (3-20, default 10)."),
        instrumentUniverse: z
          .enum(["stocks", "etfs", "mix"])
          .optional()
          .describe("Candidate universe: stocks only, ETFs only, or a mix. Default mix unless the prompt says otherwise."),
      },
    },
    async ({ prompt, startingCash, maxPositions, instrumentUniverse }) => {
      try {
        requireUserScope("write:drafts");

        // Resolve the brief. If the caller gave one, use it. Otherwise try to elicit a
        // quick style/region/size brief via a native form; on clients without elicitation
        // hand control back to the model so it can scope conversationally and retry.
        let brief = prompt?.trim();
        if (!brief) {
          const scoped = await gatherBriefViaElicitation(server);
          if (scoped.kind === "unsupported") {
            return {
              content: [{
                type: "text",
                text:
                  "No portfolio brief was provided. Ask the user for investing style (income/dividends, growth, defensive, broad-market, quality, or value), region focus (US, Europe, or global), and size (cash and/or number of holdings) in ONE quick round with sensible defaults, then call create_portfolio_draft again with a one-sentence prompt summarizing their answers.",
              }],
            };
          }
          if (scoped.kind === "declined") {
            return { content: [{ type: "text", text: "Portfolio draft canceled — no brief was provided." }] };
          }
          brief = scoped.brief;
        }

        // Start the async draft job with persist=true so bullrun-api stores the
        // finished draft for GUI review. This tool only ever calls the draft +
        // poll endpoints — there is NO path to any position-mutating endpoint, so
        // it provably cannot change the user's live holdings.
        const started = await bullrunPost<JobStarted>("/api/portfolios/ai-draft", {
          prompt: brief,
          startingCash: startingCash ?? null,
          maxPositions: maxPositions ?? null,
          instrumentUniverse: instrumentUniverse ?? null,
          persist: true,
        });

        const deadline = Date.now() + MAX_WAIT_MS;
        let status: JobStatus | null = null;
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          status = await bullrunGet<JobStatus>(
            `/api/portfolios/ai-draft/${encodeURIComponent(started.jobId)}`,
          );
          if (status.status === "done" || status.status === "error") break;
        }

        if (!status || status.status === "running") {
          return {
            isError: true,
            content: [{
              type: "text",
              text:
                "create_portfolio_draft timed out waiting for the draft. The job may still finish and save a pending draft in Bullrun; check the Portfolio tab under \"Pending AI drafts\" before retrying.",
            }],
          };
        }
        if (status.status === "error") {
          return {
            isError: true,
            content: [{ type: "text", text: `create_portfolio_draft failed: ${status.message ?? status.code ?? "unknown error"}` }],
          };
        }
        const draft = status.draft;
        if (!draft) {
          return {
            isError: true,
            content: [{ type: "text", text: "create_portfolio_draft returned an empty draft. Please try again." }],
          };
        }

        const payload = {
          saved: true,
          draftId: status.draftId ?? null,
          message:
            'Saved as a pending draft in your Bullrun account. Open the Portfolio tab and review it under "Pending AI drafts" to accept it (creates a new portfolio) or discard it. This created a draft only and did not change any live positions.',
          name: draft.name,
          startingCashUsd: draft.startingCash,
          cashPct: draft.cashPct,
          model: draft.model,
          fallback: draft.fallback,
          notes: draft.notes,
          positions: draft.positions.map((p) => ({
            ticker: p.ticker,
            company: p.company,
            sector: p.sector,
            country: p.country,
            instrumentType: p.instrumentType ?? null,
            weightPct: p.weightPct,
            rationale: p.rationale,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `create_portfolio_draft failed: ${msg}` }] };
      }
    },
  );
}
