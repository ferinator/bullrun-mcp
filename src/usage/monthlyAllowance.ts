import { createHash, createHmac } from "node:crypto";
import { getAuth } from "../auth/context.js";
import { getGateway } from "../gateway/context.js";
import { getMcpUsage } from "./context.js";
import { allowanceMessage, parseQuotaNotice, type QuotaNotice } from "./allowance.js";
import { capacityMessage, parseCapacityNotice } from "./operation.js";
import type { McpOperationLease } from "./context.js";

const enabled = process.env.MCP_ALLOWANCE_ENABLED === "true";
const secret = process.env.BULLRUN_MCP_GATEWAY_SECRET ?? "";

export interface MonthlyReservation {
  operationId: string;
  allowed: boolean;
  exempt?: boolean;
  notice?: QuotaNotice;
  callerIp?: string;
  userId?: number;
  lease?: McpOperationLease;
}

/** One admitted call, free or Pro. Marketplace billing stays at its own gateway. */
export async function reserveMonthlyAllowance(operationId: string): Promise<MonthlyReservation | undefined> {
  if (!enabled || getGateway()) return undefined;
  const response = await control("reserve", operationId);
  const capacity = parseCapacityNotice(response.status, response.text);
  if (capacity) {
    const reads = getMcpUsage()?.reads;
    if (reads) reads.capacity = capacity;
    throw new Error(capacityMessage(capacity));
  }
  if (response.status === 429) {
    const notice = parseQuotaNotice(response.text);
    if (!notice || notice.pool !== "mcp_calls") throw new Error("Invalid monthly allowance response");
    return { operationId, allowed: false, notice };
  }
  const payload = JSON.parse(response.text);
  const expiresAt = Date.parse(payload.expiresAt);
  const toolName = getMcpUsage()?.toolName;
  if (!response.ok || payload.allowed !== true || payload.operationId !== operationId
      || typeof payload.principalKey !== "string" || !/^[a-zA-Z0-9:_-]{1,180}$/.test(payload.principalKey)
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10 * 60_000
      || !Number.isInteger(payload.maxRequests) || payload.maxRequests < 1 || payload.maxRequests > 4096
      || !toolName) throw new Error("Research allowance is unavailable");
  return { operationId, allowed: true, callerIp: getMcpUsage()?.clientIp, userId: getAuth()?.userId,
    lease: { operationId, principalKey: payload.principalKey, toolName, expiresAt,
      maxRequests: payload.maxRequests, attemptedRequests: 0 } };
}

export async function finishMonthlyAllowance(reservation: MonthlyReservation | undefined, success: boolean): Promise<void> {
  if (!reservation?.allowed || reservation.exempt) return;
  // Repeating the same operation is idempotent, including a lost first response.
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await control("finish", reservation.operationId, success, reservation);
      if (!response.ok || JSON.parse(response.text).settled !== true) throw new Error("Monthly allowance was not settled");
      return;
    } catch (error) { failure = error; }
  }
  // The transaction may have committed even when its response was lost. Check its durable
  // outcome before discarding a completed result or attempting the opposite settlement.
  try {
    const response = await control("status", reservation.operationId, undefined, reservation);
    const state = JSON.parse(response.text).state;
    if (response.ok && state === (success ? "success" : "released")) return;
  } catch { /* Preserve the original settlement failure. */ }
  throw failure;
}

async function control(action: "reserve" | "finish" | "status", operationId: string, success?: boolean,
  identity?: Pick<MonthlyReservation, "callerIp" | "userId">) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Monthly allowance signing is not configured");
  const auth = getAuth();
  const body = JSON.stringify({ operationId, callerIp: identity ? identity.callerIp : getMcpUsage()?.clientIp,
    userId: identity ? identity.userId : auth?.userId, success,
    ...(action === "reserve" ? { toolName: getMcpUsage()?.toolName } : {}) });
  const url = new URL(`/api/internal/mcp-allowance/${action}`, process.env.BULLRUN_API_BASE ?? "http://localhost:8085");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = ["mcp-allowance", "POST", url.pathname, timestamp, digest].join("\n");
  const response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(2000), headers: {
    "content-type": "application/json", "X-Bullrun-Client": "mcp",
    "X-Bullrun-Mcp-Allowance-Timestamp": timestamp,
    "X-Bullrun-Mcp-Allowance-Signature": createHmac("sha256", secret).update(canonical).digest("hex"),
    ...(action === "reserve" && auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
  } });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

export function monthlyLimitResult(notice: QuotaNotice) {
  return { isError: true, content: [{ type: "text", text: allowanceMessage(notice,
    { signedIn: getAuth() !== undefined, marketplace: false }) }] };
}

export function monthlyUnavailableResult() {
  return { isError: true, content: [{ type: "text", text:
    "Bullrun could not confirm your research allowance. Please retry shortly." }] };
}
