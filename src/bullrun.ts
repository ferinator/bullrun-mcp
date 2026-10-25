/**
 * Tiny read-only HTTP client for the bullrun-api REST service plus runtime config.
 * Every MCP tool fetches live data through {@link bullrunGet}. When the current request
 * is authenticated (an OAuth access token validated by the `/mcp` gate), the caller's
 * bearer token is forwarded to bullrun-api so per-user endpoints resolve the right user;
 * public endpoints simply ignore it. There is no caching.
 */
import { getAuth } from "./auth/context.js";
import { getMcpUsage, type McpWriteProgress, type McpWriteReceipt } from "./usage/context.js";
import { getGateway } from "./gateway/context.js";
import { gatewayHeaders } from "./gateway/mcprush.js";
import { clientIpHeaders } from "./usage/clientIp.js";
import { SCREEN_MAX_WAIT_MS, SCREEN_PATHS, screenGate } from "./usage/screenGate.js";
import { parseQuotaNotice } from "./usage/allowance.js";
import { operationHeaders, parseCapacityNotice, capacityMessage } from "./usage/operation.js";

/** Where each tool call is reported (usage/invocations.ts); a refused call must still be counted. */
export const MCP_TOOL_REPORT_PATH = "/api/analytics/mcp-tools";

const DEFAULT_BASE = "http://localhost:8085";
const DEFAULT_AUTH_SERVER = "https://bull-run.org";
const DEFAULT_PUBLIC_URL = "https://mcp.bull-run.org";
const DEFAULT_SCOPES = "read:market read:portfolios write:drafts read:shortlist write:shortlist";

/** Strip trailing slashes so URL joins are predictable. */
function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

const authServer = trimSlashes(process.env.MCP_AUTH_SERVER ?? DEFAULT_AUTH_SERVER);

export const config = {
  /** Base URL of bullrun-api, trailing slashes stripped. */
  apiBase: trimSlashes(process.env.BULLRUN_API_BASE ?? DEFAULT_BASE),
  /** Port the MCP HTTP server listens on. */
  port: Number(process.env.PORT ?? 8091),
  /** Per-request timeout for upstream API calls, in milliseconds. */
  requestTimeoutMs: Number(process.env.BULLRUN_API_TIMEOUT_MS ?? 20000),

  // ── OAuth protected-resource config (Phase 3, ADR-0001) ──────────────────────
  /** This server's resource identifier (RFC 9728): PRM `resource` + the audience we require. */
  publicUrl: trimSlashes(process.env.MCP_PUBLIC_URL ?? DEFAULT_PUBLIC_URL),
  /** Authorization Server advertised in PRM (`authorization_servers`). */
  authServer,
  /** Expected token issuer (`iss`); defaults to the authorization server. */
  issuer: trimSlashes(process.env.MCP_ISSUER ?? authServer),
  /** JWKS endpoint used to verify token signatures. In docker, the internal api URL. */
  jwksUri: process.env.MCP_JWKS_URI ?? `${authServer}/oauth2/jwks`,
  /** Scopes advertised in PRM `scopes_supported`. */
  scopes: (process.env.MCP_SCOPES ?? DEFAULT_SCOPES).split(/[\s,]+/).filter(Boolean),
  /** When true (default), unauthenticated `/mcp` requests get a 401 challenge. */
  requireAuth: (process.env.MCP_REQUIRE_AUTH ?? "true").toLowerCase() !== "false",
};

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * GET a JSON resource from bullrun-api. Blank/undefined/null query params are dropped so
 * callers can pass optional filters unconditionally. When the request is authenticated,
 * the caller's bearer token is forwarded. Throws a descriptive Error on transport failure
 * or non-2xx response. `timeoutMs` overrides the default upstream timeout for an endpoint
 * known to be slow.
 */
export async function bullrunGet<T>(path: string, params?: QueryParams, timeoutMs?: number): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.apiBase);
  skipAfterRunOut(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Bullrun-Client": "mcp",
    ...gatewayHeaders("GET", url),
    ...clientIpHeaders("GET", url),
    ...operationHeaders("GET", url),
  };
  const auth = getAuth();
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  addMcpUsageHeaders(headers);

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(upstreamTimeout(timeoutMs)),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach bullrun-api at ${config.apiBase} (${reason})`);
  }
  countRead(res);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    noteQuotaExhausted(res.status, body);
    const detail = body ? ` - ${body.slice(0, 300)}` : "";
    throw new Error(`bullrun-api ${res.status} ${res.statusText} for ${url.pathname}${url.search}${detail}`);
  }

  return (await res.json()) as T;
}

/**
 * Once this tool call has hit an MCP allowance, usage/invocations.ts answers with the allowance
 * message whatever the tool loads next, so later requests are wasted: metered ones are refused and
 * the rest are discarded. One get_etf_exposures call kept fanning out to 260 requests, 109 of them
 * refused. Requests already in flight still finish.
 */
function skipAfterRunOut(url: URL): void {
  const capacity = getMcpUsage()?.reads?.capacity;
  if (capacity && url.pathname !== MCP_TOOL_REPORT_PATH) throw new Error(capacityMessage(capacity));
  const exhausted = getMcpUsage()?.reads?.exhausted;
  if (exhausted && url.pathname !== MCP_TOOL_REPORT_PATH) {
    throw new Error(`Skipped bullrun-api request for ${url.pathname}: the ${exhausted.pool} ${exhausted.window} MCP allowance ran out earlier in this call`);
  }
}

function upstreamTimeout(timeoutMs?: number): number {
  const expiresAt = getMcpUsage()?.lease?.expiresAt;
  return Math.max(1, Math.min(timeoutMs ?? config.requestTimeoutMs, gatewayTimeLeft() ?? Infinity,
    expiresAt === undefined ? Infinity : expiresAt - Date.now()));
}

/** The gateway deadline includes time spent in the screen queue, not just the fetch. */
function gatewayTimeLeft(): number | undefined {
  const deadline = getGateway()?.deadline;
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Marketplace research deadline reached. Request fewer rows, modules or periods, or retry later.");
  }
  return remaining;
}

/**
 * POST a JSON body to bullrun-api and parse the JSON response. Like {@link bullrunGet}
 * it forwards the caller's bearer token (so per-user endpoints resolve the right user)
 * and throws a descriptive Error on transport failure or non-2xx response. Used by the
 * write tools (e.g. starting an AI portfolio draft job).
 */
export async function bullrunPost<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.apiBase);
  skipAfterRunOut(url);
  // Whole-universe screens queue for one of a few slots; see usage/screenGate.ts.
  return SCREEN_PATHS.has(url.pathname)
    ? screenGate.run(() => sendPost<T>(url, body, timeoutMs), Math.min(SCREEN_MAX_WAIT_MS, gatewayTimeLeft() ?? Infinity))
    : sendPost<T>(url, body, timeoutMs);
}

async function sendPost<T>(url: URL, body: unknown, timeoutMs?: number): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Bullrun-Client": "mcp",
    ...gatewayHeaders("POST", url),
    ...clientIpHeaders("POST", url),
    ...operationHeaders("POST", url, serialized ?? ""),
  };
  const auth = getAuth();
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  addMcpUsageHeaders(headers);

  const signal = AbortSignal.timeout(upstreamTimeout(timeoutMs));
  const writes = beginPotentialWrite(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: serialized,
      signal,
    });
  } catch (err) {
    if (writes) writes.uncertain = true;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach bullrun-api at ${config.apiBase} (${reason})`);
  }
  countRead(res);

  if (!res.ok) {
    if (writes && res.status >= 500) writes.uncertain = true;
    const text = await res.text().catch(() => "");
    noteQuotaExhausted(res.status, text);
    const detail = text ? ` - ${text.slice(0, 300)}` : "";
    throw new Error(`bullrun-api ${res.status} ${res.statusText} for ${url.pathname}${detail}`);
  }

  let result: T;
  try { result = (await res.json()) as T; }
  catch (error) {
    if (writes) writes.uncertain = true;
    throw error;
  }
  if (writes) rememberWriteReceipt(url, writes, result);
  return result;
}

function beginPotentialWrite(url: URL): McpWriteProgress | undefined {
  const path = url.pathname;
  if (SCREEN_PATHS.has(path) || path === "/api/stocks/identity-batch"
      || path === MCP_TOOL_REPORT_PATH || path.startsWith("/api/internal/mcp-allowance/")) return undefined;
  const usage = getMcpUsage();
  if (!usage) return undefined;
  const writes = usage.writes ??= { attempted: 0, acknowledged: 0, uncertain: false, receipts: [] };
  writes.attempted++;
  return writes;
}

function rememberWriteReceipt(url: URL, writes: McpWriteProgress, result: unknown): void {
  writes.acknowledged++;
  if (writes.receipts.length >= 20 || !result || typeof result !== "object") return;
  const value = result as Record<string, unknown>;
  const kind: McpWriteReceipt["kind"] = url.pathname.startsWith("/api/short-list/") ? "shortlist"
    : url.pathname === "/api/portfolios/ai-draft" ? "portfolio_draft_job"
    : url.pathname === "/api/portfolios/draft-basket" ? "portfolio_draft"
    : /^\/api\/portfolios\/[0-9]+\/position-drafts$/.test(url.pathname) ? "position_draft" : "account_change";
  const receipt: McpWriteReceipt = { kind };
  // Retain only validated, useful confirmation identifiers from the response. Never
  // retain the request body, URL, token, company names, positions or portfolio contents.
  if (typeof value.ticker === "string" && /^[A-Z0-9^][A-Z0-9.^=_&/@ -]{0,79}$/.test(value.ticker)) receipt.ticker = value.ticker;
  if (typeof value.jobId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value.jobId)) receipt.jobId = value.jobId;
  if (typeof value.draftId === "number" && Number.isSafeInteger(value.draftId) && value.draftId > 0) receipt.draftId = value.draftId;
  if (receipt.ticker === undefined && receipt.jobId === undefined && receipt.draftId === undefined) return;
  if (!writes.receipts.some(existing => JSON.stringify(existing) === JSON.stringify(receipt))) writes.receipts.push(receipt);
}

/** Per-tool-call read counts for the mcp_tool_call analytics row (usage/invocations.ts). */
function countRead(res: Response): void {
  const reads = getMcpUsage()?.reads;
  if (!reads) return;
  reads.apiCalls++;
  // bullrun-api names the pool when it charged this request, including on a 404 after the charge.
  if (res.headers.get("X-Bullrun-Quota-Category")) reads.meteredReads++;
}

/**
 * Remembers on the tool call that an MCP allowance ran out, so the call answers with the plain
 * allowance message instead of the tool's own "could not be loaded" wording (usage/invocations.ts).
 * The error is still thrown, so tools behave as before until then.
 */
function noteQuotaExhausted(status: number, body: string): void {
  const reads = getMcpUsage()?.reads;
  if (!reads) return;
  reads.capacity ??= parseCapacityNotice(status, body);
  if (status !== 429 || reads.exhausted) return;
  reads.exhausted = parseQuotaNotice(body);
}

function addMcpUsageHeaders(headers: Record<string, string>): void {
  const usage = getMcpUsage();
  if (usage?.sessionId) {
    headers["X-Bullrun-Mcp-Session"] = usage.sessionId;
  }
  if (usage?.toolName) {
    headers["X-Bullrun-Mcp-Tool"] = usage.toolName;
  }
  if (usage?.invocationId) {
    headers["X-Bullrun-Mcp-Invocation"] = usage.invocationId;
  }
  if (usage?.clientClass) {
    // Moves a directory probe's anonymous reads to the API's smaller probe pool.
    headers["X-Bullrun-Mcp-Client-Class"] = usage.clientClass;
  }
}
