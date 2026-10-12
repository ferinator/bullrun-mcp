/**
 * Unit test for the RS256 access-token verifier (Phase 3 / T3.2). Generates a throwaway
 * RS256 keypair, serves it as a local JWKS, mints tokens, and asserts the verifier accepts
 * a correctly-bound token and rejects wrong-audience / wrong-issuer / expired / wrong-key
 * tokens. No bullrun-api and no network needed.
 *
 *   npm run build && node scripts/test-auth.mjs
 */
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const ISSUER = "https://bull-run.org";
const API_AUD = "https://bull-run.org";
const RESOURCE = "https://mcp.bull-run.org";
const KID = "test-key";

// 1) A keypair published in the JWKS, plus a second one that is NOT (the wrong-key case).
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const { privateKey: foreignKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };

// 2) Serve the JWKS over loopback.
const server = http.createServer((req, res) => {
  if (req.url === "/jwks") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// 3) Point the verifier's config at the stub BEFORE importing it (config reads env at load).
process.env.MCP_JWKS_URI = `http://127.0.0.1:${port}/jwks`;
process.env.MCP_ISSUER = ISSUER;
process.env.MCP_PUBLIC_URL = RESOURCE;
const { verifyAccessToken } = await import("../dist/auth/tokenVerifier.js");

const now = Math.floor(Date.now() / 1000);
const mint = (claims = {}) =>
  new SignJWT({ role: "USER", scope: "read:market read:portfolios", userId: 42, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("google-sub-1")
    .setIssuedAt();

const validToken = await mint().setIssuer(ISSUER).setAudience([API_AUD, RESOURCE]).setExpirationTime("5m").sign(privateKey);
const wrongAud = await mint().setIssuer(ISSUER).setAudience([API_AUD]).setExpirationTime("5m").sign(privateKey); // not bound to MCP
const wrongIss = await mint().setIssuer("https://evil.example").setAudience([API_AUD, RESOURCE]).setExpirationTime("5m").sign(privateKey);
const expired = await mint().setIssuer(ISSUER).setAudience([API_AUD, RESOURCE]).setExpirationTime(now - 10).sign(privateKey);
const wrongKey = await mint().setIssuer(ISSUER).setAudience([API_AUD, RESOURCE]).setExpirationTime("5m").sign(foreignKey);

let failures = 0;
async function expectOk(name, token, check) {
  try {
    const ctx = await verifyAccessToken(token);
    if (check) check(ctx);
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: expected accept, got ${err?.message ?? err}`);
  }
}
async function expectReject(name, token) {
  try {
    await verifyAccessToken(token);
    failures++;
    console.log(`FAIL  ${name}: expected reject, but it was accepted`);
  } catch {
    console.log(`PASS  ${name} (rejected)`);
  }
}

await expectOk("valid token -> accepted, userId + scopes parsed", validToken, (ctx) => {
  if (ctx.userId !== 42) throw new Error(`userId=${ctx.userId}`);
  if (!ctx.scopes.includes("read:portfolios")) throw new Error(`scopes=${ctx.scopes}`);
});
await expectReject("wrong audience (API-only, not bound to MCP resource)", wrongAud);
await expectReject("wrong issuer", wrongIss);
await expectReject("expired", expired);
await expectReject("signed by a key not in the JWKS", wrongKey);

server.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
