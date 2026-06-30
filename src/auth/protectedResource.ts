/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for this MCP server, plus the
 * `WWW-Authenticate` challenge that points clients at it (Phase 3 / T3.1). Serving the
 * metadata and answering unauthenticated requests with the challenge is what lets a
 * remote MCP client (Claude) auto-discover the Authorization Server and start OAuth.
 */
import { config } from "../bullrun.js";

/** The canonical PRM document path, relative to the resource origin. */
export const PRM_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728 Protected Resource Metadata describing this server. */
export function protectedResourceMetadata() {
  return {
    resource: config.publicUrl,
    authorization_servers: [config.authServer],
    scopes_supported: config.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Bullrun MCP",
    resource_documentation: config.publicUrl,
  };
}

/** Absolute URL of the PRM document (advertised in the `WWW-Authenticate` challenge). */
export function resourceMetadataUrl(): string {
  return `${config.publicUrl}${PRM_PATH}`;
}

/**
 * Build the `WWW-Authenticate: Bearer ...` header (RFC 9728 §5.1 / RFC 6750). `error` is
 * included only when a token was supplied but rejected — a *missing* token is not an error
 * code, just an invitation to authenticate.
 */
export function wwwAuthenticate(error?: { code: string; description: string }): string {
  let value = `Bearer resource_metadata="${resourceMetadataUrl()}"`;
  if (error) {
    // Quotes are illegal inside a quoted-string value; soften any in the description.
    value += `, error="${error.code}", error_description="${error.description.replace(/"/g, "'")}"`;
  }
  return value;
}
