/**
 * Turns bullrun-api's "allowance ran out" 429 into one plain message for the caller: which
 * allowance ran out, when it comes back, and how a free first-party caller can subscribe to Pro.
 * Shared capacity, Pro fair-use and marketplace limits have their own next steps.
 * It stays distinct from coverage answers ("no data stored") and from the per-minute pacing message.
 */
export const ACCOUNT_ENDPOINT = "https://mcp.bull-run.org/account/mcp";
export const PRICING_URL = "https://bull-run.org/pricing";

/** The body of an MCP 429 from RateLimitFilter: which pool and window ran out, its size, when reads free up. */
export interface QuotaNotice {
  pool: string;
  window: string;
  limit: number;
  resetAt?: string;
}

const POOLS = new Set(["caller", "anonymous_total", "shared", "probe", "account", "pro", "installation", "mcp_calls"]);

/** The notice in a 429 body, or undefined for any other 429 (e.g. the website's own quotas or nginx). */
export function parseQuotaNotice(body: string): QuotaNotice | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed?.error !== "quota_exceeded" || typeof parsed.pool !== "string" || !POOLS.has(parsed.pool)) return undefined;
    return {
      pool: parsed.pool,
      window: typeof parsed.window === "string" ? parsed.window : "24h",
      limit: typeof parsed.limit === "number" ? parsed.limit : 0,
      resetAt: typeof parsed.resetAt === "string" ? parsed.resetAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function whenUsageReturns(resetAt: string | undefined, unit: "reads" | "calls"): string {
  const at = resetAt ? new Date(resetAt) : undefined;
  if (!at || Number.isNaN(at.getTime())) return `as earlier ${unit} age out`;
  return `from ${at.toISOString().slice(0, 16).replace("T", " ")} UTC, as earlier ${unit} age out`;
}

const reads = (limit: number) => `${limit.toLocaleString("en-US")} data reads`;

const MANUAL_RESEARCH = "The website remains available for free manual screening and research.";

function proGuidance(signedIn: boolean): string {
  return `Bullrun Pro subscriptions with higher MCP limits are available at ${PRICING_URL}. `
    + (signedIn
      ? "Subscribe using the Bullrun account connected to this MCP session. "
      : `After subscribing, connect that Bullrun account at ${ACCOUNT_ENDPOINT} to use Pro limits. `)
    + "Pro remains subject to fair-use and pacing limits.";
}

export function allowanceMessage(notice: QuotaNotice, caller: { signedIn: boolean; marketplace: boolean }): string {
  const month = notice.window === "30d";
  const period = month ? "this month's" : "today's";
  const span = month ? "30 days" : notice.window === "24h" ? "24 hours" : notice.window.replace(/h$/, " hours");
  const back = `More reads free up ${whenUsageReturns(notice.resetAt, "reads")}.`;
  if (notice.pool === "mcp_calls") {
    const owner = caller.marketplace ? "marketplace installation" : caller.signedIn ? "Bullrun account" : "network";
    return `This ${owner} has used its free MCP allowance of ${notice.limit.toLocaleString("en-US")} successful tool calls per rolling 30 days. `
      + `More calls become available ${whenUsageReturns(notice.resetAt, "calls")}. Failed calls do not count toward this allowance. `
      + (caller.marketplace ? "" : `${proGuidance(caller.signedIn)} ${MANUAL_RESEARCH} `)
      + "This is a usage allowance, not a coverage answer.";
  }
  const notCoverage = "This is a usage allowance, not a gap in Bullrun's data.";

  if (caller.marketplace || notice.pool === "installation") {
    return `This marketplace installation has used ${period} Bullrun research allowance (${reads(notice.limit)} in ${span}). ${back} ${notCoverage}`;
  }
  if (notice.pool === "pro") {
    return `This account has reached Bullrun Pro's fair-use limit (${reads(notice.limit)} in ${span}). ${back} ${notCoverage}`;
  }
  if (notice.pool === "probe") {
    return `Bullrun's shared MCP health-check allowance is used up for now (${reads(notice.limit)} in ${span}). ${back} ${notCoverage}`;
  }
  if (notice.pool === "anonymous_total" || notice.pool === "shared") {
    return `Bullrun's free capacity for connections without an account is used up for now, across all users. ${back} `
      + `Connect a free Bullrun account at ${ACCOUNT_ENDPOINT} to use its separate allowance instead of this shared capacity. `
      + `No subscription is required for that option. ${MANUAL_RESEARCH} ${notCoverage}`;
  }
  if (notice.pool === "account" || caller.signedIn) {
    return `You've used ${period} allowance for your free Bullrun account (${reads(notice.limit)} in ${span}). ${back} `
      + `${proGuidance(true)} ${MANUAL_RESEARCH} ${notCoverage}`;
  }
  return `You've used ${period} free Bullrun allowance on this connection (${reads(notice.limit)} in ${span}). ${back} `
    + `${proGuidance(false)} ${MANUAL_RESEARCH} ${notCoverage}`;
}

/** Short label for the mcp_tool_call analytics row, e.g. "caller:30d". */
export function quotaLabel(notice: QuotaNotice): string {
  return `${notice.pool}:${notice.window}`;
}
