/**
 * Per-request authentication context, propagated with {@link AsyncLocalStorage}.
 *
 * The Streamable HTTP transport reuses one server/transport per session, so tool
 * callbacks cannot read the current HTTP request directly. The `/mcp` handler instead
 * stashes the validated caller here for the duration of each request; tools and the
 * {@link bullrunGet} client read it back via {@link getAuth} — notably to forward the
 * caller's bearer token to bullrun-api so calls are scoped to the right user.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** An authenticated caller derived from a validated OAuth access token. */
export interface AuthContext {
  /** Raw bearer token, forwarded verbatim to bullrun-api. */
  token: string;
  /** Token subject (the AS principal name; the Google `sub` for first-party logins). */
  sub?: string;
  /** Bullrun AppUser id resolved by the Authorization Server (the `userId` claim). */
  userId?: number;
  /** Granted OAuth scopes (e.g. read:market, read:portfolios, write:drafts). */
  scopes: string[];
}

const storage = new AsyncLocalStorage<AuthContext>();

/** Run `fn` with `ctx` as the current request's auth context (or no context if undefined). */
export function runWithAuth<T>(ctx: AuthContext | undefined, fn: () => T): T {
  return ctx ? storage.run(ctx, fn) : fn();
}

/** The current request's auth context, or `undefined` for an anonymous request. */
export function getAuth(): AuthContext | undefined {
  return storage.getStore();
}
