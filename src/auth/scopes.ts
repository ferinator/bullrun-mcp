/**
 * Tool-level scope gating. Helpers throw a descriptive Error on failure; the tool's
 * existing try/catch turns that into an `isError` result the model can read and act on.
 */
import { getAuth } from "./context.js";

/** Where an anonymous or under-scoped client goes to sign in; /mcp never prompts for login. */
const ACCOUNT_ENDPOINT = "https://mcp.bull-run.org/account/mcp";

/**
 * Gate a tool that exposes public market data. With no auth context (authless mode, or a
 * request that carried no token) the call is allowed; when the caller IS authenticated,
 * the token must carry `scope`.
 */
export function requirePublicScope(scope: string): void {
  const auth = getAuth();
  if (!auth) return; // public / authless access is fine for market-data tools
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" scope, which the access token was not granted. Reconnect ${ACCOUNT_ENDPOINT} and approve the requested permissions.`);
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
      `Authentication required: this connection is anonymous. To use your research shortlist, portfolios or drafts, connect ${ACCOUNT_ENDPOINT} and sign in with Google; a free Bullrun account is enough. Public research tools keep working on this connection.`,
    );
  }
  if (auth.userId == null) {
    throw new Error("The access token has no associated Bullrun user; re-authenticate and try again.");
  }
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" scope, which the access token was not granted. Reconnect ${ACCOUNT_ENDPOINT} and approve the requested permissions.`);
  }
}
