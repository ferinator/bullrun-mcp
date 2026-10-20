/**
 * DEV ONLY — mint an RS256 access token that bullrun-api + bullrun-mcp will accept,
 * WITHOUT running the interactive Google/OAuth browser flow. For local testing of the
 * per-user tools (list_portfolios, get_portfolio_context, create_portfolio_draft).
 *
 * It is harmless to commit: it can only mint a *valid* token if you possess the AS's
 * RSA private key. In prod that key is secret (BULLRUN_OAUTH_JWK_PATH on a private
 * volume), so this script cannot forge tokens against prod. Locally you point both the
 * API and this script at the same dev key file.
 *
 * Setup (once):
 *   # generate a dev key + run the API against it
 *   JWK_PATH=.dev-oauth-jwk.json node mcp/bullrun-mcp/scripts/dev-mint-token.mjs   # writes the key, prints a token
 *   # then start bullrun-api with  BULLRUN_OAUTH_JWK_PATH=<abs path to .dev-oauth-jwk.json>
 *
 * Mint a token:
 *   JWK_PATH=.dev-oauth-jwk.json USER_ID=1 TOKEN_TTL=720h node mcp/bullrun-mcp/scripts/dev-mint-token.mjs
 *
 * Env:
 *   JWK_PATH     (required) path to the JWK JSON file (created on first run if missing)
 *   USER_ID      bullrun app_user id to impersonate            (default 1)
 *   TOKEN_TTL    jose expiry, e.g. "1h", "720h", "30d"         (default 1h)
 *   TOKEN_ISS    issuer; must match BULLRUN_OAUTH_ISSUER + MCP_ISSUER (default http://localhost:8085)
 *   TOKEN_AUD    comma list; must contain the API audience AND the MCP resource id
 *                (default https://bull-run.org,https://mcp.bull-run.org)
 *   TOKEN_SCOPE  space list (default "read:market read:portfolios write:drafts read:shortlist write:shortlist")
 *   JWK_KID      key id (default bullrun-oauth — must match BULLRUN_OAUTH_JWK_KID)
 */
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const keyPath = process.env.JWK_PATH;
if (!keyPath) {
  console.error("JWK_PATH is required (path to the JWK JSON file, shared with the API).");
  process.exit(1);
}
const userId = Number(process.env.USER_ID ?? "1");
const issuer = process.env.TOKEN_ISS ?? "http://localhost:8085";
const audiences = (process.env.TOKEN_AUD ?? "https://bull-run.org,https://mcp.bull-run.org")
  .split(",").map((s) => s.trim()).filter(Boolean);
const scope = process.env.TOKEN_SCOPE ?? "read:market read:portfolios write:drafts read:shortlist write:shortlist";
const kid = process.env.JWK_KID ?? "bullrun-oauth";

let jwk;
if (existsSync(keyPath)) {
  jwk = JSON.parse(readFileSync(keyPath, "utf8"));
} else {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  jwk = await exportJWK(privateKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  mkdirSync(dirname(keyPath) || ".", { recursive: true });
  writeFileSync(keyPath, JSON.stringify(jwk));
  console.error(`generated new RS256 JWK -> ${keyPath} (kid=${jwk.kid}); point BULLRUN_OAUTH_JWK_PATH at it`);
}

const key = await importJWK(jwk, "RS256");
const token = await new SignJWT({ userId, role: "USER", scope })
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? kid })
  .setIssuer(issuer)
  .setAudience(audiences)
  .setSubject(String(userId))
  .setIssuedAt()
  .setExpirationTime(process.env.TOKEN_TTL ?? "1h")
  .sign(key);

console.log(token);
