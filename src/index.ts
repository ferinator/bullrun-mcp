import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcpServer.js";
import { config } from "./bullrun.js";
import { runWithAuth } from "./auth/context.js";
import { runWithMcpUsage, type McpUsageContext } from "./usage/context.js";
import { clientIpFromRequest } from "./usage/clientIp.js";
import { verifyAccessToken } from "./auth/tokenVerifier.js";
import { protectedResourceMetadata, wwwAuthenticate, PRM_PATH } from "./auth/protectedResource.js";
import { MCPRUSH_PATH, gatewaySessionOwner, mcprushEnabled, mcprushGate } from "./gateway/mcprush.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    // Read-only market data plus per-user portfolio tools. Permissive CORS lets
    // browser-based clients (e.g. the MCP Inspector) connect directly; WWW-Authenticate
    // is exposed so they can read the OAuth challenge.
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    allowedHeaders: ["Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Accept", "Authorization"],
  }),
);

/**
 * The always-authenticated MCP endpoint. `/mcp` itself is governed by MCP_REQUIRE_AUTH (open
 * in authless/public mode), but this sibling path ALWAYS answers an unauthenticated request
 * with a 401 challenge — so an OAuth client like a Claude custom connector reliably starts the
 * sign-in flow even while the server stays anonymous for public MCP directories. Both paths
 * share this server's resource id / audience (config.publicUrl), so a token minted while
 * connecting to one validates on the other.
 */
const AUTH_MCP_PATH = process.env.MCP_AUTH_PATH ?? "/account/mcp";
// Opt-in compatibility catalog for clients using the four v0.7 tool names.
const LEGACY_MCP_PATH = "/legacy/mcp";
const LEGACY_AUTH_MCP_PATH = "/account/legacy/mcp";
/**
 * Public research catalog for directories that list no-authentication connectors: only the
 * tools that work without sign-in (no portfolio, draft, shortlist or capability tools, no
 * prompts), so every listed tool succeeds for an anonymous caller. Open regardless of
 * MCP_REQUIRE_AUTH; a presented token is still validated.
 */
const RESEARCH_MCP_PATH = "/research/mcp";
type Catalog = "full" | "legacy" | "research";

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "bullrun-mcp",
    apiBase: config.apiBase,
    auth: {
      required: config.requireAuth,
      resource: config.publicUrl,
      authorizationServers: [config.authServer],
      // Always-authenticated endpoint: 401-challenges anonymous callers into OAuth login
      // even when `required` is false (authless mode).
      loginEndpoint: AUTH_MCP_PATH,
      legacyEndpoint: LEGACY_MCP_PATH,
      legacyLoginEndpoint: LEGACY_AUTH_MCP_PATH,
      researchEndpoint: RESEARCH_MCP_PATH,
    },
    sessions: { open: sessions.size, max: MAX_SESSIONS, idleTtlSeconds: Math.round(SESSION_IDLE_TTL_MS / 1000) },
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * RFC 9728 Protected Resource Metadata (Phase 3 / T3.1). Published at the canonical
 * well-known path; the `/mcp`-suffixed variant is served too because some clients append
 * the resource's path component to the well-known prefix. Both are public (no auth).
 */
function serveProtectedResourceMetadata(_req: Request, res: Response): void {
  res.json(protectedResourceMetadata());
}
app.get(PRM_PATH, serveProtectedResourceMetadata);
app.get(`${PRM_PATH}/mcp`, serveProtectedResourceMetadata);

/**
 * Glama directory ownership verification. Glama claims a connector by fetching this file
 * from the connector's domain and matching the maintainer email to the Glama account.
 * Public (no auth), like the other well-known endpoints.
 * NOTE: this email MUST match the email on the Glama account doing the claim.
 */
const GLAMA_MAINTAINER_EMAIL = "kunticferenc@gmail.com";
app.get("/.well-known/glama.json", (_req: Request, res: Response) => {
  res.json({
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    maintainers: [{ email: GLAMA_MAINTAINER_EMAIL }],
  });
});

/** Public, optional mcprush domain-ownership proof; independent of gateway credentials. */
const MCPRUSH_DOMAIN_CLAIM = process.env.MCPRUSH_DOMAIN_CLAIM ?? "";
app.get("/.well-known/mcprush.com-claim.txt", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  // The negative lookahead makes the end strict, including against trailing newlines.
  if (!/^mcprush\.com-[A-Za-z0-9_-]{8,128}(?![\s\S])/.test(MCPRUSH_DOMAIN_CLAIM)) {
    res.status(404).type("text/plain").send("Not found\n");
    return;
  }
  res.type("text/plain").send(MCPRUSH_DOMAIN_CLAIM);
});

/**
 * Auth gate for `/mcp`-style requests (Phase 3 / T3.2). When a bearer token is present it is
 * validated and the caller is run inside an AsyncLocalStorage context so tools forward it to
 * bullrun-api. "required" forces the challenge on a missing token regardless of
 * MCP_REQUIRE_AUTH (used by the dedicated login path), "optional" never challenges a missing
 * token (the public research path); "configured" behaves by mode:
 *   - requireAuth (default): a missing OR invalid token -> 401 + WWW-Authenticate (the
 *     discovery trigger that makes an MCP client start the OAuth flow).
 *   - authless (MCP_REQUIRE_AUTH=false): no token -> proceed anonymously; but a token that
 *     IS supplied must still be valid (never silently downgrade a presented credential).
 */
function authGate(policy: "configured" | "required" | "optional") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

    if (!bearer) {
      if (policy === "required" || (policy === "configured" && config.requireAuth)) {
        respondChallenge(res);
        return;
      }
      next(); // authless mode — proceed as an anonymous caller
      return;
    }

    let auth;
    try {
      auth = await verifyAccessToken(bearer);
    } catch (err) {
      const description = err instanceof Error ? err.message : "Access token could not be validated.";
      respondChallenge(res, { code: "invalid_token", description });
      return;
    }
    // Run the rest of the request (transport + tool callbacks) inside the auth context.
    runWithAuth(auth, () => next());
  };
}
// `/mcp`: auth governed by MCP_REQUIRE_AUTH (open in authless mode for public + directory use).
// `AUTH_MCP_PATH`: always requires a valid token, so an unauthenticated client gets the 401
// that drives a Claude connector into the OAuth sign-in flow.
app.use("/mcp", authGate("configured"));
app.use(AUTH_MCP_PATH, authGate("required"));
app.use(LEGACY_MCP_PATH, authGate("configured"));
app.use(LEGACY_AUTH_MCP_PATH, authGate("required"));
app.use(RESEARCH_MCP_PATH, authGate("optional"));
app.use(MCPRUSH_PATH, mcprushGate);

/** Emit a 401 with the RFC 9728 challenge pointing at our Protected Resource Metadata. */
function respondChallenge(res: Response, error?: { code: string; description: string }): void {
  res.setHeader("WWW-Authenticate", wwwAuthenticate(error));
  res.status(401).json({
    error: error?.code ?? "unauthorized",
    error_description: error?.description ?? "Authorization required to access this MCP server.",
  });
}

/**
 * Streamable HTTP with session management. An `initialize` POST spins up a transport +
 * server, returns a generated `Mcp-Session-Id`, and the client echoes that id on every
 * later request (POST tool calls, GET SSE stream, DELETE teardown).
 *
 * Each session holds its own McpServer (~0.6 MiB), and most clients never send DELETE
 * (directory health probes, Claude connectors), so sessions are also closed after
 * MCP_SESSION_IDLE_TTL_MS without a request, and the oldest idle one is evicted once
 * MCP_MAX_SESSIONS are open. A request for a session we no longer know gets 404, which per
 * the Streamable HTTP spec tells the client to re-initialize — the same answer clients get
 * after a restart wipes this in-memory map.
 */
const SESSION_IDLE_TTL_MS = envPositiveInt("MCP_SESSION_IDLE_TTL_MS", 30 * 60_000);
const SESSION_SWEEP_INTERVAL_MS = envPositiveInt(
  "MCP_SESSION_SWEEP_INTERVAL_MS",
  Math.min(5 * 60_000, SESSION_IDLE_TTL_MS),
);
const MAX_SESSIONS = envPositiveInt("MCP_MAX_SESSIONS", 500);

interface Session {
  transport: StreamableHTTPServerTransport;
  /** Marketplace transports cannot be reused by public routes or another installation. */
  gatewayOwner?: string;
  /** Full, compatibility and research sessions cannot be reused across catalogs. */
  catalog: Catalog;
  lastActivity: number;
  /** Requests still being answered, including an open GET SSE stream; never evicted while > 0. */
  inFlight: number;
}
const sessions = new Map<string, Session>();

/** Count a request against its session until the response finishes or the client goes away. */
function trackActivity(session: Session, res: Response): void {
  session.lastActivity = Date.now();
  session.inFlight++;
  res.once("close", () => {
    session.inFlight--;
    session.lastActivity = Date.now();
  });
}

/** Forget a session and close its transport, which releases the McpServer behind it. */
function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.transport.close().catch((err) => console.error(`Error closing MCP session ${sessionId}:`, err));
}

function sweepIdleSessions(): void {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  let closed = 0;
  for (const [sessionId, session] of sessions) {
    if (session.inFlight === 0 && session.lastActivity < cutoff) {
      closeSession(sessionId);
      closed++;
    }
  }
  if (closed > 0) console.log(`Closed ${closed} idle MCP session(s); ${sessions.size} open`);
}
setInterval(sweepIdleSessions, SESSION_SWEEP_INTERVAL_MS).unref();

/** Make room for a new session by closing the least recently active idle one. */
function evictForNewSession(): void {
  if (sessions.size < MAX_SESSIONS) return;
  let oldest: [string, Session] | undefined;
  for (const entry of sessions) {
    if (entry[1].inFlight === 0 && (!oldest || entry[1].lastActivity < oldest[1].lastActivity)) oldest = entry;
  }
  // Every session busy: let this one through over the cap rather than refuse a client.
  if (oldest) closeSession(oldest[0]);
}

function respondSessionNotFound(res: Response): void {
  res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
}

function respondMissingSession(res: Response): void {
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: no valid session ID provided" },
    id: null,
  });
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const gatewayOwner = gatewaySessionOwner();
  const catalog = catalogFor(req);
  let transport: StreamableHTTPServerTransport;

  if (session) {
    if (session.gatewayOwner !== gatewayOwner || session.catalog !== catalog) {
      respondSessionNotFound(res);
      return;
    }
    trackActivity(session, res);
    transport = session.transport;
  } else if (sessionId) {
    respondSessionNotFound(res);
    return;
  } else if (!isInitializeRequest(req.body)) {
    respondMissingSession(res);
    return;
  } else {
    // New initialization request — create a fresh transport + server.
    evictForNewSession();
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: gatewayOwner !== undefined,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport: created, gatewayOwner, catalog, lastActivity: Date.now(), inFlight: 0 });
      },
    });
    // Set before connect(): the server wraps this handler rather than replacing it. The
    // identity check means a sweep that already removed the session is a no-op here.
    created.onclose = () => {
      const sid = created.sessionId;
      if (sid && sessions.get(sid)?.transport === created) sessions.delete(sid);
    };
    const server = createMcpServer({ researchOnly: catalog === "research", marketplace: gatewayOwner !== undefined,
      legacyTools: catalog === "legacy" });
    await server.connect(created);
    transport = created;
  }

  try {
    await runWithMcpUsage(mcpUsageFromRequest(req), () => transport.handleRequest(req, res, req.body));
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
// Bind the shared POST handler to both the public and the login-required paths. The auth
// context is set per-request by the gate above; session state is keyed by Mcp-Session-Id,
// not by path, so a session started on either endpoint resolves the same transport.
app.post("/mcp", handleMcpPost);
app.post(AUTH_MCP_PATH, handleMcpPost);
app.post(LEGACY_MCP_PATH, handleMcpPost);
app.post(LEGACY_AUTH_MCP_PATH, handleMcpPost);
app.post(RESEARCH_MCP_PATH, handleMcpPost);
app.post(MCPRUSH_PATH, handleMcpPost);
app.all(MCPRUSH_PATH, (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "Marketplace transport accepts POST requests." });
});

// GET (SSE stream) and DELETE (session teardown) both require an existing session.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  if (!sessionId) {
    respondMissingSession(res);
    return;
  }
  const session = sessions.get(sessionId);
  if (!session || session.gatewayOwner !== gatewaySessionOwner() || session.catalog !== catalogFor(req)) {
    respondSessionNotFound(res);
    return;
  }
  trackActivity(session, res);
  await session.transport.handleRequest(req, res);
}
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
app.get(AUTH_MCP_PATH, handleSessionRequest);
app.delete(AUTH_MCP_PATH, handleSessionRequest);
app.get(LEGACY_MCP_PATH, handleSessionRequest);
app.delete(LEGACY_MCP_PATH, handleSessionRequest);
app.get(LEGACY_AUTH_MCP_PATH, handleSessionRequest);
app.delete(LEGACY_AUTH_MCP_PATH, handleSessionRequest);
app.get(RESEARCH_MCP_PATH, handleSessionRequest);
app.delete(RESEARCH_MCP_PATH, handleSessionRequest);

app.listen(config.port, () => {
  console.log(`bullrun-mcp listening on :${config.port} (MCP at /mcp, health at GET /health)`);
  console.log(`Proxying bullrun-api at ${config.apiBase}`);
  console.log(
    config.requireAuth
      ? `OAuth protected resource: ${config.publicUrl} (AS: ${config.authServer}); unauthenticated /mcp -> 401`
      : `Authless mode (MCP_REQUIRE_AUTH=false): /mcp open; tokens still validated if presented`,
  );
  console.log(`Login-required endpoint at ${AUTH_MCP_PATH} -> always 401-challenges anonymous callers into OAuth login`);
  console.log(`Public research endpoint at ${RESEARCH_MCP_PATH} -> research tools only, never requires sign-in`);
  console.log(`Marketplace research endpoint at ${MCPRUSH_PATH}: ${mcprushEnabled ? "configured" : "disabled until credentials are configured"}`);
});

function mcpUsageFromRequest(req: Request): McpUsageContext | undefined {
  const sessionId = firstHeader(req.headers["mcp-session-id"]);
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const methods = new Set<string>();
  const tools = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method) methods.add(method);
    if (method === "tools/call" && isRecord(message.params)) {
      const name = message.params.name;
      if (typeof name === "string" && name) tools.add(name);
    }
  }

  const operation = methods.size === 0 ? undefined : methods.size === 1 ? firstSetValue(methods) : "batch";
  const toolName = tools.size === 0 ? undefined : tools.size === 1 ? firstSetValue(tools) : "batch";
  // Signed onto each API request so anonymous reads are metered per caller, not as one pool.
  const clientIp = clientIpFromRequest(req);
  if (!sessionId && !operation && !toolName && !clientIp) return undefined;
  return { sessionId, operation, toolName, clientIp };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function catalogFor(req: Request): Catalog {
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  if (path === LEGACY_MCP_PATH || path === LEGACY_AUTH_MCP_PATH) return "legacy";
  return path === RESEARCH_MCP_PATH ? "research" : "full";
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function firstSetValue(values: Set<string>): string | undefined {
  for (const value of values) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
