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
  /** API-admitted, principal-bound tool operation; internal reads do not spend customer units. */
  lease?: McpOperationLease;
  /** Private request-local write progress. Never report it to analytics or a shared cache. */
  writes?: McpWriteProgress;
}

export interface McpWriteReceipt {
  kind: "shortlist" | "portfolio_draft_job" | "portfolio_draft" | "position_draft" | "account_change";
  ticker?: string;
  jobId?: string;
  draftId?: number;
}

export interface McpWriteProgress {
  attempted: number;
  acknowledged: number;
  uncertain: boolean;
  /** At most 20 compact response identifiers; no request arguments or personal payloads. */
  receipts: McpWriteReceipt[];
}

export interface McpOperationLease {
  operationId: string;
  principalKey: string;
  toolName: string;
  expiresAt: number;
  maxRequests: number;
  attemptedRequests: number;
}

export interface McpCapacityNotice {
  reason: string;
  retryAfterSeconds: number;
}

export interface McpReadCount {
  /** Every bullrun-api request that got an HTTP response. */
  apiCalls: number;
  /** The subset bullrun-api charged to a quota (it names the pool in X-Bullrun-Quota-Category). */
  meteredReads: number;
  /** Set by the first read the API refused because an MCP allowance ran out (usage/allowance.ts). */
  exhausted?: QuotaNotice;
  /** Resource/attempt protection is separate from the customer's successful-call allowance. */
  capacity?: McpCapacityNotice;
  /** Bullrun was busy: a screen found no free slot (screenGate.ts) or bullrun-api answered 503 server_busy. */
  busy?: boolean;
  /** A bullrun-api request got no usable answer: unreachable, timed out, past its deadline, another 5xx or bad JSON. */
  upstreamFailed?: boolean;
}

const storage = new AsyncLocalStorage<McpUsageContext>();

export function runWithMcpUsage<T>(ctx: McpUsageContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

export function getMcpUsage(): McpUsageContext | undefined {
  return storage.getStore();
}
