import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGateway, runWithGateway } from "./context.js";
import { runWithAuth } from "../auth/context.js";

export const MCPRUSH_PATH = "/mcprush/mcp";
const token = process.env.MCPRUSH_TOKEN ?? "";
const internalSecret = process.env.BULLRUN_MCP_GATEWAY_SECRET ?? "";
const expectedListing = process.env.MCPRUSH_LISTING_ID ?? "";
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Remains unavailable until BOTH independent credentials have been configured. */
export const mcprushEnabled = token.length > 0 && Buffer.byteLength(internalSecret, "utf8") >= 32;

function reject(res: Response, id: unknown, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: -32001, message } });
}

export function mcprushGate(req: Request, res: Response, next: NextFunction): void {
  if (!mcprushEnabled) {
    reject(res, req.body?.id, 503, "Marketplace connection is not configured.");
    return;
  }
  const presented = req.headers["x-mcprush-token"];
  // Comparing fixed-length hashes avoids exposing token length in timing comparisons.
  if (typeof presented !== "string" || !timingSafeEqual(
    createHash("sha256").update(presented).digest(), createHash("sha256").update(token).digest(),
  )) {
    reject(res, req.body?.id, 401, "A valid mcprush gateway token is required.");
    return;
  }
  const presentedListing = req.headers["x-mcprush-listing"];
  const installationId = req.headers["x-mcprush-install"];
  const discoveryOnly = ["server/discover", "initialize", "notifications/initialized", "tools/list", "ping"].includes(req.body?.method);
  // Studio Verify omits both identity headers. Only token-authenticated discovery
  // may use the configured listing; a supplied identity is never repaired.
  const listingId = presentedListing === undefined && installationId === undefined &&
    discoveryOnly && validId(expectedListing) ? expectedListing : presentedListing;
  if (!validId(listingId) || (expectedListing && listingId !== expectedListing) ||
      (installationId !== undefined && !validId(installationId))) {
    reject(res, req.body?.id, 400, "Invalid marketplace listing or installation.");
    return;
  }
  if (Array.isArray(req.body)) {
    reject(res, null, 400, "Marketplace requests must contain one JSON-RPC request.");
    return;
  }
  // Verify/release probes have no installation and only need protocol discovery.
  if (!installationId && !discoveryOnly) {
    reject(res, req.body?.id, 400, "An installation is required to call research tools.");
    return;
  }
  // Buyer Authorization/X-Env values never become a Bullrun user credential.
  // The gateway cuts a call after 30s without a byte, and this JSON route sends
  // nothing until the result is ready. Finishing first returns a clean tool error,
  // which is never billed and doesn't count toward the endpoint's failure circuit.
  runWithAuth(undefined, () => runWithGateway({ listingId, installationId, deadline: Date.now() + 27_000 }, next));
}

/** Bind every marketplace session to its authenticated listing and installation. */
export function gatewaySessionOwner(): string | undefined {
  const gateway = getGateway();
  return gateway ? JSON.stringify([gateway.listingId, gateway.installationId ?? null]) : undefined;
}

/** Research GETs and the two read-only screener POSTs; never account or draft writes. */
export function gatewayHeaders(method: string, url: URL): Record<string, string> {
  const gateway = getGateway();
  if (!gateway?.installationId || (method !== "GET" && !(method === "POST" &&
      ["/api/screener/filter", "/api/etfs/screener"].includes(url.pathname)))) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = [method, url.pathname + url.search, timestamp, gateway.listingId, gateway.installationId].join("\n");
  return {
    "X-Bullrun-Mcp-Gateway-Timestamp": timestamp,
    "X-Bullrun-Mcp-Gateway-Listing": gateway.listingId,
    "X-Bullrun-Mcp-Gateway-Installation": gateway.installationId,
    "X-Bullrun-Mcp-Gateway-Signature": createHmac("sha256", internalSecret).update(canonical).digest("hex"),
  };
}

/** Keep a normal MCP error below the gateway response cap; oversized results aren't billable. */
export function boundMarketplaceResults(server: McpServer): void {
  const register = server.registerTool;
  server.registerTool = ((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      args[args.length - 1] = async (...callbackArgs: unknown[]) => {
        const result = await Reflect.apply(callback, undefined, callbackArgs);
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > 240 * 1024) {
          return { isError: true, content: [{ type: "text", text:
            "Research result exceeds the marketplace response limit. Request fewer rows, modules, periods or transcript chunks." }] };
        }
        return result;
      };
    }
    return Reflect.apply(register, server, args);
  }) as typeof server.registerTool;
}
