/**
 * Session-lifecycle test for the MCP server's Streamable HTTP session map. Boots the real
 * compiled server (dist/index.js) in authless mode with a tiny idle TTL and session cap,
 * plus a stub AS JWKS so the always-authenticated AUTH_MCP_PATH can be reached, and asserts:
 *   - a request carrying an unknown Mcp-Session-Id gets 404 + JSON-RPC -32001 (the spec's
 *     "re-initialize" signal) for POST, GET and DELETE on both /mcp and /account/mcp,
 *   - a non-initialize POST, GET or DELETE with no session id still gets 400,
 *   - a session kept busy outlives the TTL; an idle one is closed by the sweep (-> 404),
 *   - an open GET SSE stream keeps its session alive until the stream closes,
 *   - DELETE still tears a session down,
 *   - past MCP_MAX_SESSIONS the least recently active session is evicted,
 *   - a real SDK client (which holds a GET SSE stream) survives the sweep, sees the 404
 *     once its session is gone, and /health reports the open count.
 *
 *   npm run build && node scripts/test-sessions.mjs
 */
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ISSUER = "https://bull-run.org";
const RESOURCE = "https://mcp.bull-run.org";
const KID = "test-key";
const TTL_MS = 400;
const MAX_SESSIONS = 3;
const UNKNOWN_SESSION = "00000000-0000-0000-0000-000000000000";

// ── stub AS JWKS (only needed to get past the auth gate on /account/mcp) ─────
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
const jwksServer = http.createServer((req, res) => {
  if (req.url === "/oauth2/jwks") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  } else res.writeHead(404).end();
});
await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
const jwksPort = jwksServer.address().port;

// ── boot the real compiled MCP server ────────────────────────────────────────
const mcpPort = 8233;
process.env.PORT = String(mcpPort);
process.env.MCP_REQUIRE_AUTH = "false";
process.env.MCP_PUBLIC_URL = RESOURCE;
process.env.MCP_AUTH_SERVER = ISSUER;
process.env.MCP_ISSUER = ISSUER;
process.env.MCP_JWKS_URI = `http://127.0.0.1:${jwksPort}/oauth2/jwks`;
process.env.BULLRUN_API_BASE = "http://127.0.0.1:9"; // no tool here reaches the API
process.env.MCP_SESSION_IDLE_TTL_MS = String(TTL_MS);
process.env.MCP_SESSION_SWEEP_INTERVAL_MS = "50";
process.env.MCP_MAX_SESSIONS = String(MAX_SESSIONS);
await import("../dist/index.js");
await new Promise((r) => setTimeout(r, 400)); // allow listen()

const base = `http://127.0.0.1:${mcpPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = await new SignJWT({ role: "USER", scope: "read:market read:portfolios", userId: 42 })
  .setProtectedHeader({ alg: "RS256", kid: KID })
  .setSubject("google-42")
  .setIssuedAt()
  .setIssuer(ISSUER)
  .setAudience([ISSUER, RESOURCE])
  .setExpirationTime("5m")
  .sign(privateKey);

let failures = 0;
const ok = (cond, name, extra = "") => {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${extra}`);
  }
};

/** Raw MCP request; returns { status, sessionId, text, json }. */
async function request(method, path, { sessionId, auth = false, body, signal } = {}) {
  const headers = { accept: "application/json, text/event-stream" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (auth) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return res;
}

async function read(res) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text, json };
}

const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list" };

async function initialize(path = "/mcp", auth = false) {
  const init = await read(
    await request("POST", path, {
      auth,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sessions", version: "0" } },
      },
    }),
  );
  if (init.sessionId) {
    await read(
      await request("POST", path, {
        sessionId: init.sessionId,
        auth,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
    );
  }
  return init;
}

const listTools = async (sessionId, path = "/mcp", auth = false) =>
  read(await request("POST", path, { sessionId, auth, body: toolsList }));

const openSessions = async () => (await (await fetch(`${base}/health`)).json()).sessions?.open;

const isSessionNotFound = (r) => r.status === 404 && r.json?.error?.code === -32001 && r.json?.id === null;

// 1) unknown session id -> 404 on every method and both paths
for (const [path, auth] of [["/mcp", false], ["/account/mcp", true]]) {
  const post = await read(await request("POST", path, { sessionId: UNKNOWN_SESSION, auth, body: toolsList }));
  ok(isSessionNotFound(post), `POST ${path} unknown session -> 404 -32001`, `status=${post.status} body=${post.text}`);
  const get = await read(await request("GET", path, { sessionId: UNKNOWN_SESSION, auth }));
  ok(isSessionNotFound(get), `GET ${path} unknown session -> 404 -32001`, `status=${get.status} body=${get.text}`);
  const del = await read(await request("DELETE", path, { sessionId: UNKNOWN_SESSION, auth }));
  ok(isSessionNotFound(del), `DELETE ${path} unknown session -> 404 -32001`, `status=${del.status} body=${del.text}`);
}
const unknownInit = await read(
  await request("POST", "/mcp", {
    sessionId: UNKNOWN_SESSION,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sessions", version: "0" } },
    },
  }),
);
ok(isSessionNotFound(unknownInit), "initialize carrying an unknown session id -> 404", `status=${unknownInit.status}`);

// 2) the auth gate still runs first on the login path
const unauthUnknown = await read(await request("POST", "/account/mcp", { sessionId: UNKNOWN_SESSION, body: toolsList }));
ok(unauthUnknown.status === 401, "POST /account/mcp unknown session, no token -> 401 (auth before session lookup)", `status=${unauthUnknown.status}`);

// 3) no session id at all -> 400
const noSessionPost = await read(await request("POST", "/mcp", { body: toolsList }));
ok(noSessionPost.status === 400 && noSessionPost.json?.error?.code === -32000, "POST /mcp tools/list without session -> 400", `status=${noSessionPost.status}`);
const noSessionGet = await read(await request("GET", "/mcp"));
ok(noSessionGet.status === 400, "GET /mcp without session -> 400", `status=${noSessionGet.status}`);
const noSessionDelete = await read(await request("DELETE", "/mcp"));
ok(noSessionDelete.status === 400, "DELETE /mcp without session -> 400", `status=${noSessionDelete.status}`);

// 4) a fresh session works on both paths and is counted in /health
const s1 = await initialize();
const s1Tools = await listTools(s1.sessionId);
ok(s1.status === 200 && !!s1.sessionId && s1Tools.status === 200 && s1Tools.text.includes("screen_stocks"), "initialize + tools/list on /mcp -> 200", `init=${s1.status} list=${s1Tools.status}`);
const sAuth = await initialize("/account/mcp", true);
const sAuthTools = await listTools(sAuth.sessionId, "/account/mcp", true);
ok(sAuth.status === 200 && sAuthTools.status === 200, "initialize + tools/list on /account/mcp -> 200", `init=${sAuth.status} list=${sAuthTools.status}`);
ok((await openSessions()) === 2, "/health sessions.open counts live sessions", `open=${await openSessions()}`);

// 5) activity keeps a session alive past the TTL; the idle one is swept
let keptAlive = true;
for (let i = 0; i < 8; i++) {
  await sleep(TTL_MS / 4);
  if ((await listTools(s1.sessionId)).status !== 200) keptAlive = false;
}
ok(keptAlive, `busy session survives ${2 * TTL_MS}ms with a ${TTL_MS}ms TTL`);
const sAuthAfter = await listTools(sAuth.sessionId, "/account/mcp", true);
ok(isSessionNotFound(sAuthAfter), "session idle past the TTL is closed -> 404", `status=${sAuthAfter.status}`);
await sleep(TTL_MS * 2);
const s1After = await listTools(s1.sessionId);
ok(isSessionNotFound(s1After), "busy session is closed once it goes idle -> 404", `status=${s1After.status}`);
ok((await openSessions()) === 0, "/health sessions.open drops to 0 after the sweep", `open=${await openSessions()}`);

// 6) an open GET SSE stream keeps its session alive until the stream ends
const s2 = await initialize();
const streamAbort = new AbortController();
const stream = await request("GET", "/mcp", { sessionId: s2.sessionId, signal: streamAbort.signal });
ok(stream.status === 200 && stream.headers.get("content-type")?.includes("text/event-stream"), "GET /mcp opens the SSE stream", `status=${stream.status}`);
await sleep(TTL_MS * 2);
ok((await openSessions()) === 1, "session with an open SSE stream is not swept", `open=${await openSessions()}`);
streamAbort.abort();
await stream.body?.cancel().catch(() => {});
await sleep(TTL_MS * 2);
const s2After = await listTools(s2.sessionId);
ok(isSessionNotFound(s2After), "session is swept once its SSE stream closes -> 404", `status=${s2After.status}`);

// 7) DELETE still tears a session down
const s3 = await initialize();
const del = await read(await request("DELETE", "/mcp", { sessionId: s3.sessionId }));
const s3After = await listTools(s3.sessionId);
ok(del.status === 200 && isSessionNotFound(s3After) && (await openSessions()) === 0, "DELETE closes the session -> later requests 404", `delete=${del.status} after=${s3After.status}`);

// 8) past the cap the least recently active session is evicted
const capped = [];
for (let i = 0; i <= MAX_SESSIONS; i++) {
  capped.push((await initialize()).sessionId);
  await sleep(10);
}
const oldest = await listTools(capped[0]);
const newest = await listTools(capped[MAX_SESSIONS]);
ok(
  isSessionNotFound(oldest) && newest.status === 200 && (await openSessions()) === MAX_SESSIONS,
  `opening session ${MAX_SESSIONS + 1} evicts the oldest idle one`,
  `oldest=${oldest.status} newest=${newest.status} open=${await openSessions()}`,
);
await sleep(TTL_MS * 2);

// 9) a real SDK client holds a GET SSE stream open, so it survives the sweep; once its
// session is gone (as after a restart) it gets the 404, and a fresh client reconnects
const clientTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
const client = new Client({ name: "sessions", version: "0" });
await client.connect(clientTransport);
await sleep(TTL_MS * 2);
const survived = await client.listTools().then(() => true, () => false);
ok(survived, "SDK client with its SSE stream open survives the idle sweep");
await read(await request("DELETE", "/mcp", { sessionId: clientTransport.sessionId }));
let clientError;
try {
  await client.listTools();
} catch (err) {
  clientError = err;
}
ok(clientError?.code === 404, "SDK client sees 404 once its session is gone", `error=${clientError?.code} ${clientError?.message ?? ""}`);
await client.close().catch(() => {});
const fresh = new Client({ name: "sessions", version: "0" });
await fresh.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const freshTools = await fresh.listTools();
ok(freshTools.tools.length > 0, "a fresh SDK client re-initializes and lists tools");
await fresh.close();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
jwksServer.close();
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
