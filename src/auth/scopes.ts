/**
 * Tool-level scope gating. Helpers throw a descriptive Error on failure; the tool's
 * existing try/catch turns that into an `isError` result the model can read and act on.
 */
import { getAuth } from "./context.js";

/**
 * Gate a tool that exposes public market data. With no auth context (authless mode, or a
 * request that carried no token) the call is allowed; when the caller IS authenticated,
 * the token must carry `scope`.
 */
export function requirePublicScope(scope: string): void {
  const auth = getAuth();
  if (!auth) return; // public / authless access is fine for market-data tools
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" scope, which the access token was not granted.`);
  }
}

/**
 * Gate a tool that reads the caller's own Bullrun data. A valid token is mandatory, it must
 * resolve to a Bullrun user, and it must carry `scope`.
 */
export function requireUserScope(scope: string): void {
  const auth = getAuth();
  if (!auth) {
    throw new Error(
      "Authentication required: connect this server with your Bullrun account (OAuth) to use this tool.",
    );
  }
  if (auth.userId == null) {
    throw new Error("The access token has no associated Bullrun user; re-authenticate and try again.");
  }
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" scope, which the access token was not granted.`);
  }
}
