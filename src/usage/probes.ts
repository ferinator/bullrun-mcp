/**
 * MCP directory health-check probes, recognised by the clientInfo name they send in
 * `initialize`. Their tool calls are tagged `X-Bullrun-Mcp-Client-Class: probe` so
 * bullrun-api charges them to a separate, smaller anonymous pool instead of the one real
 * users share. The name is self-reported, so this only ever buys a caller less quota.
 */
export const PROBE_CLIENT_CLASS = "probe";

/** Seen on prod, lower-cased: one row per directory/crawler that polls the public endpoint. */
const KNOWN_PROBE_CLIENTS = new Set([
  "agentstatus-probe",
  "brickbluebot",
  "rokmcp-probe",
  "agent-finder-probe",
  "agent-collector",
]);

/**
 * Names that describe themselves as a probe or a health check, e.g. "uptime-probe" or
 * "FaceabotProbe". A plain substring: a false match only costs a client the smaller pool.
 */
const PROBE_NAME = /probe|health-?check/i;

export function isProbeClient(name: string | undefined): boolean {
  if (!name) return false;
  return KNOWN_PROBE_CLIENTS.has(name.trim().toLowerCase()) || PROBE_NAME.test(name);
}
