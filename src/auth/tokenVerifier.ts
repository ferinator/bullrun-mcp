/**
 * Validates RS256 OAuth access tokens issued by the bullrun-api Authorization Server
 * (ADR-0001, D3). Verifies the signature against the AS JWKS plus issuer / audience /
 * expiry. The audience check passes only when the token is bound to THIS server's
 * resource id ({@link config.publicUrl}) — so we never accept, or forward, a token that
 * was minted for some other resource (no confused-deputy passthrough; Phase 3 / T3.2).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../bullrun.js";
import type { AuthContext } from "./context.js";

/** A token-validation failure, classified so the caller can shape the 401 challenge. */
export class TokenError extends Error {
  constructor(
    public readonly kind: "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

// Remote JWK set: caches keys and refetches (rate-limited) when an unknown `kid` appears,
// so AS key rotation is handled without a restart.
const jwks = createRemoteJWKSet(new URL(config.jwksUri));

/** Verify a bearer token and return the resolved caller, or throw {@link TokenError}. */
export async function verifyAccessToken(token: string): Promise<AuthContext> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.publicUrl,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TokenError("invalid", `Access token rejected: ${reason}`);
  }

  return {
    token,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    userId: parseUserId(payload.userId),
    scopes: parseScopes(payload.scope),
  };
}

/** The Authorization Server stamps `userId` as a number; tolerate a string too. */
function parseUserId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Scopes may arrive as a JSON array or a space-delimited string. */
function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  return [];
}
