import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { getMcpUsage, runWithMcpUsage, type McpReadCount } from "./context.js";
import { isProbeClient, PROBE_CLIENT_CLASS } from "./probes.js";
import { heavyToolCallerKey, heavyToolLimitedResult, heavyToolLimiter, type HeavyToolLimiter } from "./heavyTools.js";
import { allowanceMessage, quotaLabel } from "./allowance.js";
import { getAuth } from "../auth/context.js";
import { getGateway } from "../gateway/context.js";

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
}

type Reporter = (event: ToolInvocation) => Promise<unknown>;
const report: Reporter = event => bullrunPost("/api/analytics/mcp-tools", event, 750);

/** Counts executed callbacks once, including local failures and tools with no API calls. */
export async function recordMcpToolInvocation<T>(
  toolName: string,
  callback: () => Promise<T>,
  reporter: Reporter = report,
  client?: { name: string; version: string },
  limiter: HeavyToolLimiter = heavyToolLimiter,
): Promise<T> {
  const reads: McpReadCount = { apiCalls: 0, meteredReads: 0 };
  const usage = { ...getMcpUsage(), toolName, invocationId: randomUUID(),
    clientClass: isProbeClient(client?.name) ? PROBE_CLIENT_CLASS : undefined, reads };
  return runWithMcpUsage(usage, async () => {
    const started = Date.now();
    let outcome: ToolInvocation["outcome"] = "throw";
    let rateLimited: boolean | undefined;
    try {
      const retryAfter = limiter.take(toolName, heavyToolCallerKey());
      if (retryAfter > 0) {
        outcome = "error";
        rateLimited = true;
        return heavyToolLimitedResult(toolName, limiter.perMinute, retryAfter) as T;
      }
      let result: T;
      try {
        result = await callback();
      } catch (err) {
        if (!reads.exhausted) throw err;
        outcome = "error";
        return allowanceResult(reads) as T;
      }
      // Once an allowance has run out, every later read fails too: one plain answer saying what
      // ran out and when it comes back beats a result full of "could not be loaded" fields.
      if (reads.exhausted) {
        outcome = "error";
        return allowanceResult(reads) as T;
      }
      outcome = result && typeof result === "object" && "isError" in result && result.isError === true
        ? "error" : "success";
      return result;
    } finally {
      // Reporting is best-effort, bounded by a short fetch timeout, and cannot change
      // the tool result or mask its exception. No arguments or result text are sent.
      // The counts are copied first: the report is itself a bullrun-api request.
      const { apiCalls, meteredReads } = reads;
      try {
        await reporter({
          invocationId: usage.invocationId, toolName, sessionId: usage.sessionId,
          clientName: client?.name, clientVersion: client?.version,
          outcome, durationMs: Math.max(0, Date.now() - started), apiCalls, meteredReads, rateLimited,
          quotaExhausted: reads.exhausted ? quotaLabel(reads.exhausted) : undefined,
        });
      } catch { /* analytics must never interrupt a tool */ }
    }
  });
}

function allowanceResult(reads: McpReadCount) {
  const text = allowanceMessage(reads.exhausted!, { signedIn: getAuth() !== undefined, marketplace: getGateway() !== undefined });
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Install before tool registration; retain the SDK's generic registration signature. */
export function instrumentMcpTools(server: McpServer): void {
  const register = server.registerTool;
  server.registerTool = ((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      args[args.length - 1] = (...callbackArgs: unknown[]) => recordMcpToolInvocation(
        String(args[0]),
        async () => Reflect.apply(callback, undefined, callbackArgs),
        report,
        server.server.getClientVersion(),
      );
    }
    return Reflect.apply(register, server, args);
  }) as typeof server.registerTool;
}
