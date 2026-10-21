import { AsyncLocalStorage } from "node:async_hooks";
import type { QuotaNotice } from "./allowance.js";

export interface McpUsageContext {
  sessionId?: string;
  operation?: string;
  toolName?: string;
  invocationId?: string;
  /** "probe" for a known directory health-check client; see probes.ts. */
  clientClass?: string;
  /** The caller's address as Cloudflare reported it; signed onto every API request (clientIp.ts). */
  clientIp?: string;
  /** Backend requests made by one tool call, counted by bullrunGet/bullrunPost. */
  reads?: McpReadCount;
}

export interface McpReadCount {
  /** Every bullrun-api request that got an HTTP response. */
  apiCalls: number;
  /** The subset bullrun-api charged to a quota (it names the pool in X-Bullrun-Quota-Category). */
  meteredReads: number;
  /** Set by the first read the API refused because an MCP allowance ran out (usage/allowance.ts). */
  exhausted?: QuotaNotice;
}

const storage = new AsyncLocalStorage<McpUsageContext>();

export function runWithMcpUsage<T>(ctx: McpUsageContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

export function getMcpUsage(): McpUsageContext | undefined {
  return storage.getStore();
}
