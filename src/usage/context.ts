import { AsyncLocalStorage } from "node:async_hooks";

export interface McpUsageContext {
  sessionId?: string;
  operation?: string;
  toolName?: string;
}

const storage = new AsyncLocalStorage<McpUsageContext>();

export function runWithMcpUsage<T>(ctx: McpUsageContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

export function getMcpUsage(): McpUsageContext | undefined {
  return storage.getStore();
}
