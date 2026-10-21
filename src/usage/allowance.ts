/**
 * Turns bullrun-api's "allowance ran out" 429 into one plain message for the caller. Running out
 * is the moment an anonymous user decides whether to connect a free account, so the message says
 * which allowance ran out, when reads come back and what raises the limit, and it stays distinct
 * from coverage answers ("no data stored") and from the per-minute pacing message.
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

const POOLS = new Set(["caller", "anonymous_total", "shared", "probe", "account", "pro", "installation"]);

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

function whenReadsReturn(resetAt: string | undefined): string {
  const at = resetAt ? new Date(resetAt) : undefined;
  if (!at || Number.isNaN(at.getTime())) return "as earlier reads age out";
  return `from ${at.toISOString().slice(0, 16).replace("T", " ")} UTC, as earlier reads age out`;
}

const reads = (limit: number) => `${limit.toLocaleString("en-US")} data reads`;

export function allowanceMessage(notice: QuotaNotice, caller: { signedIn: boolean; marketplace: boolean }): string {
  const month = notice.window === "30d";
  const period = month ? "this month's" : "today's";
  const span = month ? "30 days" : notice.window === "24h" ? "24 hours" : notice.window.replace(/h$/, " hours");
  const back = `More reads free up ${whenReadsReturn(notice.resetAt)}.`;
  const notCoverage = "This is a usage allowance, not a gap in Bullrun's data.";
  const upgradeAnonymous = `Connect a free Bullrun account at ${ACCOUNT_ENDPOINT} for 3x more, or go Pro to remove the daily and monthly caps: ${PRICING_URL}`;

  if (caller.marketplace || notice.pool === "installation") {
    return `This marketplace installation has used ${period} Bullrun research allowance (${reads(notice.limit)} in ${span}). ${back} ${notCoverage}`;
  }
  if (notice.pool === "pro") {
    return `This account has reached Bullrun Pro's fair-use limit (${reads(notice.limit)} in ${span}). ${back} ${notCoverage}`;
  }
  if (notice.pool === "account" || caller.signedIn) {
    return `You've used ${period} allowance for your free Bullrun account (${reads(notice.limit)} in ${span}). ${back} `
      + `Go Pro to remove the daily and monthly caps: ${PRICING_URL}. ${notCoverage}`;
  }
  if (notice.pool === "anonymous_total") {
    return `Bullrun's free capacity for connections without an account is used up for now, across all users. ${back} `
      + `A free Bullrun account at ${ACCOUNT_ENDPOINT} keeps working meanwhile, with 3x the anonymous allowance. ${notCoverage}`;
  }
  return `You've used ${period} free Bullrun allowance on this connection (${reads(notice.limit)} in ${span}). ${back} `
    + `${upgradeAnonymous}. ${notCoverage}`;
}

/** Short label for the mcp_tool_call analytics row, e.g. "caller:30d". */
export function quotaLabel(notice: QuotaNotice): string {
  return `${notice.pool}:${notice.window}`;
}
