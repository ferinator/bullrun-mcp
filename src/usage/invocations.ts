import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunPost } from "../bullrun.js";
import { getMcpUsage, runWithMcpUsage } from "./context.js";

export interface ToolInvocation {
  invocationId: string;
  toolName: string;
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  outcome: "success" | "error" | "throw";
  durationMs: number;
}

type Reporter = (event: ToolInvocation) => Promise<unknown>;
const report: Reporter = event => bullrunPost("/api/analytics/mcp-tools", event, 750);

/** Counts executed callbacks once, including local failures and tools with no API calls. */
export async function recordMcpToolInvocation<T>(
  toolName: string,
  callback: () => Promise<T>,
  reporter: Reporter = report,
  client?: { name: string; version: string },
): Promise<T> {
  const usage = { ...getMcpUsage(), toolName, invocationId: randomUUID() };
  return runWithMcpUsage(usage, async () => {
    const started = Date.now();
    let outcome: ToolInvocation["outcome"] = "throw";
    try {
      const result = await callback();
      outcome = result && typeof result === "object" && "isError" in result && result.isError === true
        ? "error" : "success";
      return result;
    } finally {
      // Reporting is best-effort, bounded by a short fetch timeout, and cannot change
      // the tool result or mask its exception. No arguments or result text are sent.
      try {
        await reporter({
          invocationId: usage.invocationId, toolName, sessionId: usage.sessionId,
          clientName: client?.name, clientVersion: client?.version,
          outcome, durationMs: Math.max(0, Date.now() - started),
        });
      } catch { /* analytics must never interrupt a tool */ }
    }
  });
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
