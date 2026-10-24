/**
 * Turns bullrun-api's "allowance ran out" 429 into one plain message for the caller: which
 * allowance ran out, when it starts coming back, and how a free first-party caller can subscribe to Pro.
 * Shared capacity, Pro fair-use and marketplace limits have their own next steps.
 * It stays distinct from coverage answers ("no data stored") and from the per-minute pacing message.
 */
export const ACCOUNT_SETUP_URL = "https://bull-run.org/mcp#mcp-connect";
export const PRICING_URL = "https://bull-run.org/pricing";
/** As the plans page shows them (gui/src/components/PricingPage.tsx). */
const PRO_PRICES = "CHF 5/month or CHF 50/year";
/** AppUser.TRIAL_DAYS: every new Bullrun account starts with this much Pro, no card. */
const TRIAL_DAYS = 14;

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "07:55 UTC on 24 Oct 2026 (in about 14 hours)": exact for the record, relative for a reader in any time zone. */
function resetTime(resetAt: string | undefined, now: Date): string | undefined {
  const at = resetAt ? new Date(resetAt) : undefined;
  if (!at || Number.isNaN(at.getTime())) return undefined;
  const minutes = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
  const hours = Math.round(minutes / 60);
  const wait = minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
  return `${at.toISOString().slice(11, 16)} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} (in about ${wait})`;
}

/** The windows roll: resetAt is when the oldest counted use expires, so the allowance refills from then on. */
function whenUsageReturns(resetAt: string | undefined, now: Date): string {
  const at = resetTime(resetAt, now);
  return at ? `Your allowance starts refilling at ${at}.` : "Your allowance refills gradually as earlier use expires.";
}

const reads = (limit: number) => `${limit.toLocaleString("en-US")} data reads`;

/** Tagged so the admin MCP funnel can count plans-page visits that started at a run-out message. */
function pricingLink(notice: QuotaNotice): string {
  const url = new URL(PRICING_URL);
  url.searchParams.set("utm_source", "mcp");
  url.searchParams.set("utm_medium", "assistant");
  url.searchParams.set("utm_campaign", "allowance");
  url.searchParams.set("utm_content", `${notice.pool}_${notice.window}`.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  return url.toString();
}

function proGuidance(signedIn: boolean, plans: string): string {
  return `[Get higher limits with Bullrun Pro](${plans}) — ${PRO_PRICES}. `
    + (signedIn
      ? "Upgrade the account already connected to your AI app. "
      : `New accounts get a ${TRIAL_DAYS}-day free trial, no card needed. `
        + `[Connect your account](${ACCOUNT_SETUP_URL}) in your AI app to use its limits. `)
    + "Pro usage limits apply.";
}

export function allowanceMessage(notice: QuotaNotice, caller: { signedIn: boolean; marketplace: boolean },
  now = new Date()): string {
  const month = notice.window === "30d";
  const span = month ? "30 days" : notice.window === "24h" ? "24 hours" : notice.window.replace(/h$/, " hours");
  const back = whenUsageReturns(notice.resetAt, now);
  const subscribe = (signedIn: boolean) => proGuidance(signedIn, pricingLink(notice));
  if (notice.pool === "mcp_calls") {
    const owner = caller.marketplace ? "Your marketplace installation" : caller.signedIn ? "Your Bullrun account" : "This network";
    return `${owner} has reached its free limit of ${notice.limit.toLocaleString("en-US")} successful tool calls per rolling 30 days. `
      + `${back} Failed calls don't count. `
      + (caller.marketplace ? "" : subscribe(caller.signedIn));
  }

  if (caller.marketplace || notice.pool === "installation") {
    return `Your marketplace installation has reached its research limit (${reads(notice.limit)} per rolling ${span}). ${back}`;
  }
  if (notice.pool === "pro") {
    return `You've reached your Bullrun Pro research limit (${reads(notice.limit)} per rolling ${span}). ${back}`;
  }
  if (notice.pool === "probe") {
    return `Bullrun's shared health-check limit has been reached (${reads(notice.limit)} per rolling ${span}). ${back}`;
  }
  if (notice.pool === "anonymous_total" || notice.pool === "shared") {
    return `Bullrun's shared anonymous research capacity is full for now. ${back} `
      + `[Connect a free account](${ACCOUNT_SETUP_URL}) for a separate allowance. No subscription needed.`;
  }
  const signedIn = notice.pool === "account" || caller.signedIn;
  const owner = signedIn ? "Your Bullrun account" : "This connection";
  return `${owner} has reached its free research limit (${reads(notice.limit)} per rolling ${span}). ${back} `
    + subscribe(signedIn);
}

/** Short label for the mcp_tool_call analytics row, e.g. "caller:30d". */
export function quotaLabel(notice: QuotaNotice): string {
  return `${notice.pool}:${notice.window}`;
}
