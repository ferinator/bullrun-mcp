import { createHash, createHmac } from "node:crypto";
import { getMcpUsage, type McpCapacityNotice } from "./context.js";

const secret = process.env.BULLRUN_MCP_GATEWAY_SECRET ?? "";
const REPORT_PATH = "/api/analytics/mcp-tools";

/** Sign the exact request, including its body, under an API-admitted tool operation. */
export function operationHeaders(method: string, url: URL, body = ""): Record<string, string> {
  const usage = getMcpUsage();
  const lease = usage?.lease;
  if (!lease || url.pathname === REPORT_PATH) return {};
  if (Date.now() >= lease.expiresAt || lease.attemptedRequests >= lease.maxRequests) {
    const notice = { reason: Date.now() >= lease.expiresAt ? "operation_expired" : "operation_work_limit", retryAfterSeconds: 1 };
    if (usage.reads) usage.reads.capacity ??= notice;
    throw new Error(capacityMessage(notice));
  }
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Research operation signing is unavailable");
  lease.attemptedRequests++;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = ["mcp-operation", method, url.pathname + url.search, timestamp,
    lease.operationId, lease.principalKey, lease.toolName, digest].join("\n");
  return {
    "X-Bullrun-Mcp-Operation-Id": lease.operationId,
    "X-Bullrun-Mcp-Operation-Principal": lease.principalKey,
    "X-Bullrun-Mcp-Operation-Tool": lease.toolName,
    "X-Bullrun-Mcp-Operation-Timestamp": timestamp,
    "X-Bullrun-Mcp-Operation-Signature": createHmac("sha256", secret).update(canonical).digest("hex"),
  };
}

export function parseCapacityNotice(status: number, body: string): McpCapacityNotice | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (status === 413 && value.error === "mcp_operation_body_too_large") return { reason: "operation_work_limit", retryAfterSeconds: 1 };
    if (status === 403 && value.error === "invalid_mcp_operation") return { reason: "operation_unavailable", retryAfterSeconds: 1 };
    if (status !== 429 || value.error !== "mcp_capacity_exceeded") return undefined;
    return { reason: typeof value.reason === "string" ? value.reason : "busy",
      retryAfterSeconds: typeof value.retryAfterSeconds === "number" && Number.isFinite(value.retryAfterSeconds)
        ? Math.max(1, Math.min(86400, Math.ceil(value.retryAfterSeconds))) : 5 };
  } catch { return undefined; }
}

export function capacityMessage(notice: McpCapacityNotice): string {
  if (notice.reason === "operation_unavailable") {
    return "Bullrun could not validate this research request. Please try again. No tool-call unit was used.";
  }
  if (notice.reason === "operation_work_limit") {
    return "This research request is too large. Try fewer results or a narrower request. No tool-call unit was used.";
  }
  if (notice.reason === "operation_expired") {
    return "This research request expired. Please try a smaller request. No tool-call unit was used.";
  }
  const seconds = notice.retryAfterSeconds;
  const wait = seconds < 90 ? `${seconds} second${seconds === 1 ? "" : "s"}` : `${Math.ceil(seconds / 60)} minutes`;
  return `Bullrun is busy or requests are arriving too quickly. Retry in about ${wait}. No tool-call unit was used.`;
}
