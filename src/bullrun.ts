/**
 * Tiny read-only HTTP client for the bullrun-api REST service plus runtime config.
 * Every MCP tool fetches live data through {@link bullrunGet}. When the current request
 * is authenticated (an OAuth access token validated by the `/mcp` gate), the caller's
 * bearer token is forwarded to bullrun-api so per-user endpoints resolve the right user;
 * public endpoints simply ignore it. There is no caching.
 */
import { getAuth } from "./auth/context.js";

const DEFAULT_BASE = "https://bull-run.org";
const DEFAULT_AUTH_SERVER = "https://bull-run.org";
const DEFAULT_PUBLIC_URL = "https://mcp.bull-run.org";
const DEFAULT_SCOPES = "read:market read:portfolios write:drafts";

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
 * or non-2xx response.
 */
export async function bullrunGet<T>(path: string, params?: QueryParams): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.apiBase);
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
  };
  const auth = getAuth();
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach bullrun-api at ${config.apiBase} (${reason})`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? ` - ${body.slice(0, 300)}` : "";
    throw new Error(`bullrun-api ${res.status} ${res.statusText} for ${url.pathname}${url.search}${detail}`);
  }

  return (await res.json()) as T;
}

/**
 * POST a JSON body to bullrun-api and parse the JSON response. Like {@link bullrunGet}
 * it forwards the caller's bearer token (so per-user endpoints resolve the right user)
 * and throws a descriptive Error on transport failure or non-2xx response. Used by the
 * write tools (e.g. starting an AI portfolio draft job).
 */
export async function bullrunPost<T>(path: string, body?: unknown): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.apiBase);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Bullrun-Client": "mcp",
  };
  const auth = getAuth();
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach bullrun-api at ${config.apiBase} (${reason})`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text ? ` - ${text.slice(0, 300)}` : "";
    throw new Error(`bullrun-api ${res.status} ${res.statusText} for ${url.pathname}${detail}`);
  }

  return (await res.json()) as T;
}
