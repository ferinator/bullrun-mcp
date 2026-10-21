import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { getMcpUsage } from "./context.js";
import { getGateway } from "../gateway/context.js";

/**
 * Per-caller metering for anonymous MCP traffic. Every MCP caller reaches bullrun-api from this
 * container's one Docker address, so on its own the API can only meter anonymous callers as a
 * single pool that a few dozen users would exhaust for everyone. The caller's address comes from
 * the header Cloudflare sets (this container is reachable only through cloudflared; its host
 * port is bound to 127.0.0.1), and each API request carries it with an HMAC over method, target,
 * timestamp and address. The API trusts the address only when that signature verifies, and the
 * public nginx clears these headers, so a visitor cannot pick their own budget.
 *
 * The key is the internal gateway secret also used for mcprush metering; the canonical string
 * starts with its own label so neither signature can stand in for the other.
 */
const CLIENT_IP_HEADER = (process.env.MCP_CLIENT_IP_HEADER ?? "cf-connecting-ip").toLowerCase();
const secret = process.env.BULLRUN_MCP_GATEWAY_SECRET ?? "";
const CANONICAL_LABEL = "mcp-client-ip";

/** Without a secret the API cannot verify anything, so nothing is sent and it keeps the shared pool. */
export const clientIpSigningEnabled = Buffer.byteLength(secret, "utf8") >= 32;

/** The caller's address from the trusted header, or undefined when it is absent or not a bare IP. */
export function clientIpFromRequest(req: Request): string | undefined {
  const raw = req.headers[CLIENT_IP_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  // Bare addresses only: no zone ids, ports or lists.
  if (!value || value.length > 45 || !/^[0-9A-Fa-f.:]+$/.test(value) || isIP(value) === 0) return undefined;
  return value.toLowerCase();
}

/** Signed caller-address headers for one API request; empty for marketplace or unknown callers. */
export function clientIpHeaders(method: string, url: URL): Record<string, string> {
  const ip = getMcpUsage()?.clientIp;
  // A marketplace call is metered by its signed installation, never by the gateway's address.
  if (!ip || !clientIpSigningEnabled || getGateway()) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = [CANONICAL_LABEL, method, url.pathname + url.search, timestamp, ip].join("\n");
  return {
    "X-Bullrun-Mcp-Client-Ip": ip,
    "X-Bullrun-Mcp-Client-Ip-Timestamp": timestamp,
    "X-Bullrun-Mcp-Client-Ip-Signature": createHmac("sha256", secret).update(canonical).digest("hex"),
  };
}
