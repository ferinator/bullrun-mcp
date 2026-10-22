import { getAuth } from "../auth/context.js";
import { getGateway } from "../gateway/context.js";
import { getMcpUsage } from "./context.js";

/**
 * Per-minute limit on the tools that cost the API the most per call: the two screens scan the
 * whole universe (several seconds each on prod) and get_etf_exposures can fan out into ~150
 * lookups. The daily quota bounds a caller's total; this stops one caller firing a burst of them
 * in parallel. Counted per caller and per tool, in this process (one MCP container).
 */
export const HEAVY_TOOLS = new Set([
  "screen_stocks",
  "screen_etfs",
  "get_etf_exposures",
  // The legacy catalog's equivalents: the same screener POST, and an ETF list with per-row reads.
  "screen_stock_presets",
  "query_etfs",
]);

const WINDOW_MS = 60_000;
const DEFAULT_PER_MINUTE = 6;
/** Bounds memory if a crawler cycles through many addresses; old windows are dropped first. */
const MAX_TRACKED_CALLERS = 20_000;

export interface HeavyToolLimiter {
  /** Records the call and returns 0, or returns the seconds to wait when the caller is over the limit. */
  take(toolName: string, callerKey: string, now?: number): number;
  readonly perMinute: number;
}

export function createHeavyToolLimiter(perMinute: number): HeavyToolLimiter {
  const calls = new Map<string, number[]>();
  return {
    perMinute,
    take(toolName, callerKey, now = Date.now()) {
      if (!HEAVY_TOOLS.has(toolName)) return 0;
      const key = `${callerKey}\n${toolName}`;
      const recent = (calls.get(key) ?? []).filter(at => at > now - WINDOW_MS);
      if (recent.length >= perMinute) {
        calls.set(key, recent);
        return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
      }
      recent.push(now);
      // Re-inserting keeps the Map in least-recently-used order for the eviction below.
      calls.delete(key);
      calls.set(key, recent);
      while (calls.size > MAX_TRACKED_CALLERS) {
        const oldest = calls.keys().next().value;
        if (oldest === undefined) break;
        calls.delete(oldest);
      }
      return 0;
    },
  };
}

function envPerMinute(): number {
  const value = Number(process.env.MCP_HEAVY_TOOL_PER_MINUTE);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PER_MINUTE;
}

export const heavyToolLimiter = createHeavyToolLimiter(envPerMinute());

/**
 * Who the per-minute limit counts against: the marketplace installation, the signed-in user, the
 * caller's address, or (when none is known, e.g. stdio or local runs) one shared bucket.
 */
export function heavyToolCallerKey(): string {
  const gateway = getGateway();
  if (gateway) return `gateway:${gateway.listingId}:${gateway.installationId ?? ""}`;
  const auth = getAuth();
  if (auth?.userId !== undefined) return `user:${auth.userId}`;
  if (auth?.sub) return `sub:${auth.sub}`;
  const ip = getMcpUsage()?.clientIp;
  return ip ? `ip:${ip}` : "anonymous";
}

export function heavyToolLimitedResult(toolName: string, perMinute: number, retryAfterSeconds: number) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: `${toolName} is limited to ${perMinute} calls per minute per caller across connections, and that limit was reached. `
        + `Retry in about ${retryAfterSeconds} s. This is a pacing limit, not a quota or a coverage answer; `
        + "narrow the request or reuse the previous result in the meantime.",
    }],
  };
}
