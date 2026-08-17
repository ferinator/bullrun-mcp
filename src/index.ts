import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcpServer.js";
import { config } from "./bullrun.js";
import { runWithAuth } from "./auth/context.js";
import { runWithMcpUsage, type McpUsageContext } from "./usage/context.js";
import { verifyAccessToken } from "./auth/tokenVerifier.js";
import { protectedResourceMetadata, wwwAuthenticate, PRM_PATH } from "./auth/protectedResource.js";

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
    },
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

/**
 * Auth gate for `/mcp`-style requests (Phase 3 / T3.2). When a bearer token is present it is
 * validated and the caller is run inside an AsyncLocalStorage context so tools forward it to
 * bullrun-api. `alwaysRequire` forces the challenge on a missing token regardless of
 * MCP_REQUIRE_AUTH (used by the dedicated login path); otherwise behaviour by mode:
 *   - requireAuth (default): a missing OR invalid token -> 401 + WWW-Authenticate (the
 *     discovery trigger that makes an MCP client start the OAuth flow).
 *   - authless (MCP_REQUIRE_AUTH=false): no token -> proceed anonymously; but a token that
 *     IS supplied must still be valid (never silently downgrade a presented credential).
 */
function authGate(alwaysRequire: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

    if (!bearer) {
      if (alwaysRequire || config.requireAuth) {
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
app.use("/mcp", authGate(false));
app.use(AUTH_MCP_PATH, authGate(true));

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
 * later request (POST tool calls, GET SSE stream, DELETE teardown). Sessions are dropped
 * on transport close.
 *
 * Note: the session map is unbounded; for a public deployment a TTL sweep would be a
 * sensible hardening follow-up.
 */
const transports: Record<string, StreamableHTTPServerTransport> = {};

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID provided" },
        id: null,
      });
      return;
    }
    // New initialization request — create a fresh transport + server.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport as StreamableHTTPServerTransport;
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) delete transports[transport.sessionId];
    };
    const server = createMcpServer();
    await server.connect(transport);
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

// GET (SSE stream) and DELETE (session teardown) both require an existing session.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
app.get(AUTH_MCP_PATH, handleSessionRequest);
app.delete(AUTH_MCP_PATH, handleSessionRequest);

app.listen(config.port, () => {
  console.log(`bullrun-mcp listening on :${config.port} (MCP at /mcp, health at GET /health)`);
  console.log(`Proxying bullrun-api at ${config.apiBase}`);
  console.log(
    config.requireAuth
      ? `OAuth protected resource: ${config.publicUrl} (AS: ${config.authServer}); unauthenticated /mcp -> 401`
      : `Authless mode (MCP_REQUIRE_AUTH=false): /mcp open; tokens still validated if presented`,
  );
  console.log(`Login-required endpoint at ${AUTH_MCP_PATH} -> always 401-challenges anonymous callers into OAuth login`);
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
  if (!sessionId && !operation && !toolName) return undefined;
  return { sessionId, operation, toolName };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstSetValue(values: Set<string>): string | undefined {
  for (const value of values) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
