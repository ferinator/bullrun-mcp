/**
 * Tool-level scope gating. Helpers throw a descriptive Error on failure; the tool's
 * existing try/catch turns that into an `isError` result the model can read and act on.
 */
import { getAuth } from "./context.js";

/** Browser-friendly instructions; the MCP account endpoint itself returns an OAuth challenge. */
const ACCOUNT_SETUP_URL = "https://bull-run.org/mcp#mcp-connect";
export const CONNECT_ACCOUNT_MESSAGE = "Connect a free Bullrun account to use this feature. "
  + `[Follow the setup guide](${ACCOUNT_SETUP_URL}), choose \"My Bullrun account\" and sign in with Google.`;

/**
 * Gate a tool that exposes public market data. With no auth context (authless mode, or a
 * request that carried no token) the call is allowed; when the caller IS authenticated,
 * the token must carry `scope`.
 */
export function requirePublicScope(scope: string): void {
  const auth = getAuth();
  if (!auth) return; // public / authless access is fine for market-data tools
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" permission. [Reconnect your Bullrun account](${ACCOUNT_SETUP_URL}) and approve access.`);
  }
}

/**
 * Gate a tool that reads the caller's own Bullrun data. A valid token is mandatory, it must
 * resolve to a Bullrun user, and it must carry `scope`.
 */
export function requireUserScope(scope: string): void {
  const auth = getAuth();
  if (!auth) {
    throw new Error(`Authentication required: ${CONNECT_ACCOUNT_MESSAGE}`);
  }
  if (auth.userId == null) {
    throw new Error(`Reconnect your Bullrun account and try again. [Connection guide](${ACCOUNT_SETUP_URL}).`);
  }
  if (!auth.scopes.includes(scope)) {
    throw new Error(`This tool requires the "${scope}" permission. [Reconnect your Bullrun account](${ACCOUNT_SETUP_URL}) and approve access.`);
  }
}
