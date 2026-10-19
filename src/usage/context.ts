import { AsyncLocalStorage } from "node:async_hooks";

export interface McpUsageContext {
  sessionId?: string;
  operation?: string;
  toolName?: string;
  invocationId?: string;
  /** "probe" for a known directory health-check client; see probes.ts. */
  clientClass?: string;
}

const storage = new AsyncLocalStorage<McpUsageContext>();

export function runWithMcpUsage<T>(ctx: McpUsageContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

export function getMcpUsage(): McpUsageContext | undefined {
  return storage.getStore();
}
