import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bullrunPost, MCP_TOOL_REPORT_PATH } from "../bullrun.js";
import { getMcpUsage, runWithMcpUsage, type McpReadCount, type McpUsageContext, type McpWriteProgress } from "./context.js";
import { capacityMessage } from "./operation.js";
import { isProbeClient, PROBE_CLIENT_CLASS } from "./probes.js";
import { heavyToolCallerKey, heavyToolLimitedResult, heavyToolLimiter, type HeavyToolLimiter } from "./heavyTools.js";
import { allowanceMessage, quotaLabel } from "./allowance.js";
import { getAuth } from "../auth/context.js";
import { getGateway } from "../gateway/context.js";
import { reserveMonthlyAllowance, finishMonthlyAllowance, monthlyLimitResult, monthlyUnavailableResult,
  type MonthlyReservation } from "./monthlyAllowance.js";

export interface ToolInvocation {
  invocationId: string;
  toolName: string;
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  outcome: "success" | "error" | "throw";
  durationMs: number;
  /** bullrun-api requests this call made, and how many of them a quota was charged for. */
  apiCalls: number;
  meteredReads: number;
  /** Set when the per-minute heavy-tool limit refused the call before it ran. */
  rateLimited?: boolean;
  /** Which MCP allowance ran out during the call, e.g. "caller:30d". */
  quotaExhausted?: string;
  capacityLimited?: boolean;
  /** Why a call that did not succeed failed; absent on success. */
  failure?: ToolFailure;
}

/**
 * limit: an allowance, the per-minute pacing or a busy server turned the call away.
 * caller: the call could not be answered as asked (sign-in needed, missing or invalid arguments,
 * unknown ticker, nothing found). tool: our fault, a crash or a backend that failed or did not answer.
 */
export type ToolFailure = "limit" | "caller" | "tool";

type Reporter = (event: ToolInvocation) => Promise<unknown>;
const report: Reporter = event => bullrunPost(MCP_TOOL_REPORT_PATH, event, 750);

/** Counts executed callbacks once, including local failures and tools with no API calls. */
export async function recordMcpToolInvocation<T>(
  toolName: string,
  callback: () => Promise<T>,
  reporter: Reporter = report,
  client?: { name: string; version: string },
  limiter: HeavyToolLimiter = heavyToolLimiter,
): Promise<T> {
  const reads: McpReadCount = { apiCalls: 0, meteredReads: 0 };
  const writes: McpWriteProgress = { attempted: 0, acknowledged: 0, uncertain: false, receipts: [] };
  const usage: McpUsageContext & { invocationId: string } = { ...getMcpUsage(), toolName, invocationId: randomUUID(),
    lease: undefined,
    clientClass: isProbeClient(client?.name) ? PROBE_CLIENT_CLASS : undefined, reads, writes };
  return runWithMcpUsage(usage, async () => {
    const started = Date.now();
    let outcome: ToolInvocation["outcome"] = "throw";
    let rateLimited: boolean | undefined;
    let monthly: MonthlyReservation | undefined;
    let settled = false;
    let callbackSucceeded = false;
    // The allowance service, a settlement or the tool itself failed on our side.
    let fault = false;
    try {
      const retryAfter = limiter.take(toolName, heavyToolCallerKey());
      if (retryAfter > 0) {
        outcome = "error";
        rateLimited = true;
        return heavyToolLimitedResult(toolName, limiter.perMinute, retryAfter) as T;
      }
      try {
        monthly = await reserveMonthlyAllowance(usage.invocationId);
      } catch {
        outcome = "error";
        fault = true;
        return (reads.capacity ? capacityResult(reads) : monthlyUnavailableResult()) as T;
      }
      if (monthly && !monthly.allowed) {
        outcome = "error";
        reads.exhausted = monthly.notice;
        return monthlyLimitResult(monthly.notice!) as T;
      }
      usage.lease = monthly?.lease;
      let result: T;
      try {
        result = await callback();
      } catch (err) {
        // An exception that escaped the tool is ours, unless a limit explains it (failureKind checks those first).
        fault = true;
        if (writes.attempted) {
          outcome = "error";
          return interruptedWriteResult(writes) as T;
        }
        if (reads.capacity) {
          outcome = "error";
          return capacityResult(reads) as T;
        }
        if (!reads.exhausted) throw err;
        outcome = "error";
        return allowanceResult(reads) as T;
      }
      // Once an allowance has run out, every later read fails too: one plain answer saying what
      // ran out and when it comes back beats a result full of "could not be loaded" fields.
      if (reads.capacity) {
        outcome = "error";
        return (writes.attempted ? interruptedWriteResult(writes, result) : capacityResult(reads)) as T;
      }
      if (reads.exhausted) {
        outcome = "error";
        return (writes.attempted ? interruptedWriteResult(writes, result) : allowanceResult(reads)) as T;
      }
      outcome = result && typeof result === "object" && "isError" in result && result.isError === true
        ? "error" : "success";
      if (writes.uncertain || (writes.attempted && outcome === "error")) {
        outcome = "error";
        result = interruptedWriteResult(writes, result) as T;
      }
      callbackSucceeded = outcome === "success";
      try {
        await finishMonthlyAllowance(monthly, outcome === "success");
        settled = true;
      } catch {
        outcome = "error";
        fault = true;
        return (callbackSucceeded ? uncertainSettlementResult(result)
          : writes.attempted ? result : monthlyUnavailableResult()) as T;
      }
      return result;
    } finally {
      if (!settled && !callbackSucceeded) {
        try { await finishMonthlyAllowance(monthly, false); }
        catch { /* Abandoned reservations expire; a failed call never becomes a success row. */ }
      }
      // Reporting is best-effort, bounded by a short fetch timeout, and cannot change
      // the tool result or mask its exception. No arguments or result text are sent.
      // The counts are copied first: the report is itself a bullrun-api request.
      const { apiCalls, meteredReads } = reads;
      // The completion report is outside research work and must still arrive after a refusal.
      usage.lease = undefined;
      try {
        await reporter({
          invocationId: usage.invocationId, toolName, sessionId: usage.sessionId,
          clientName: client?.name, clientVersion: client?.version,
          outcome, durationMs: Math.max(0, Date.now() - started), apiCalls, meteredReads, rateLimited,
          quotaExhausted: reads.exhausted ? quotaLabel(reads.exhausted) : undefined,
          capacityLimited: reads.capacity ? true : undefined,
          failure: outcome === "success" ? undefined : failureKind(outcome, reads, rateLimited, fault),
        });
      } catch { /* analytics must never interrupt a tool */ }
    }
  });
}

/** Limits come first, then our faults; whatever is left is the caller's request. */
function failureKind(outcome: ToolInvocation["outcome"], reads: McpReadCount, rateLimited: boolean | undefined,
  fault: boolean): ToolFailure {
  if (rateLimited || reads.exhausted || reads.capacity || reads.busy) return "limit";
  if (outcome === "throw" || fault || reads.upstreamFailed) return "tool";
  return "caller";
}

function capacityResult(reads: McpReadCount) {
  return { isError: true, content: [{ type: "text" as const, text: capacityMessage(reads.capacity!) }] };
}

function allowanceResult(reads: McpReadCount) {
  const text = allowanceMessage(reads.exhausted!, { signedIn: getAuth() !== undefined, marketplace: getGateway() !== undefined });
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Keep partial write results and bounded acknowledgements when later work is interrupted. */
function interruptedWriteResult(writes: McpWriteProgress, result?: unknown) {
  const parsed = result === undefined ? undefined : CallToolResultSchema.safeParse(result);
  const payload = parsed?.success ? parsed.data : { content: [] };
  // Plain tool error strings can contain upstream URLs/bodies. Keep returned structured
  // outcomes and successful partial results, and replace unstructured errors with safe guidance.
  const content = "isError" in payload && payload.isError && !("structuredContent" in payload && payload.structuredContent)
    ? [] : payload.content;
  const warning = "This request did not finish. Changes may already exist in your Bullrun account. "
    + "Review your saved items or pending drafts before retrying, and retry only changes confirmed missing. "
    + "Do not automatically retry this operation. No tool-call unit was used.";
  const receipts = writes.receipts.map(receipt => ({ ...receipt }));
  return {
    ...payload,
    isError: true,
    ...("structuredContent" in payload && payload.structuredContent ? {} : { structuredContent: { writeReceipts: receipts } }),
    content: [
      { type: "text" as const, text: warning },
      ...content,
      ...(receipts.length ? [{ type: "text" as const, text: `Confirmed write receipts: ${JSON.stringify(receipts)}` }] : []),
    ],
  };
}

/** Preserve known write outcomes when neither settlement nor its status can be confirmed. */
function uncertainSettlementResult(result: unknown) {
  const completed = CallToolResultSchema.safeParse(result);
  const payload = completed.success ? completed.data : {
    content: [{ type: "text" as const, text: JSON.stringify(result) ?? String(result) }],
  };
  return { ...payload, isError: true, content: [...payload.content, { type: "text" as const, text:
    "This tool completed, but Bullrun could not confirm its tool-call usage accounting. The completed result is included above. "
      + "A saved draft or shortlist change may already exist; review it before repeating a write. Do not automatically retry this operation." }] };
}

/** registerTool accepts either a raw Zod shape or a schema; this project uses Zod 3. */
function toolOutputSchema(schema: unknown): z.ZodTypeAny | undefined {
  if (schema === undefined) return undefined;
  if (schema instanceof z.ZodType) return schema;
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)
      && Object.values(schema).every(field => field instanceof z.ZodType)) {
    return z.object(schema as z.ZodRawShape);
  }
  throw new TypeError("Tool outputSchema must be a Zod schema or raw Zod shape.");
}

/** The SDK validates after the callback returns; quota settlement must validate first. */
async function validateToolResult(toolName: string, result: unknown, outputSchema: z.ZodTypeAny | undefined): Promise<void> {
  const envelope = await CallToolResultSchema.safeParseAsync(result);
  if (!envelope.success) {
    throw new Error(`Invalid MCP tool result for ${toolName}: ${envelope.error.message}`);
  }
  // Match the SDK: an error result needs a valid envelope, but no structured success payload.
  if (envelope.data.isError || !outputSchema) return;
  if (!envelope.data.structuredContent) {
    throw new Error(`Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
  }
  const output = await outputSchema.safeParseAsync(envelope.data.structuredContent);
  if (!output.success) {
    throw new Error(`Output validation error: Invalid structured content for tool ${toolName}: ${output.error.message}`);
  }
}

/** Install before tool registration; retain the SDK's generic registration signature. */
export function instrumentMcpTools(server: McpServer): void {
  const register = server.registerTool;
  server.registerTool = ((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const config = args[1];
      const outputSchema = toolOutputSchema(config !== null && typeof config === "object" && "outputSchema" in config
        ? config.outputSchema : undefined);
      args[args.length - 1] = (...callbackArgs: unknown[]) => recordMcpToolInvocation(
        String(args[0]),
        async () => {
          const result: unknown = await Reflect.apply(callback, undefined, callbackArgs);
          await validateToolResult(String(args[0]), result, outputSchema);
          return result;
        },
        report,
        server.server.getClientVersion(),
      );
    }
    return Reflect.apply(register, server, args);
  }) as typeof server.registerTool;
}
