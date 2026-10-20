import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet, config } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { mapWithConcurrency, toolResult } from "./etfData.js";
import { resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

const ROLES = ["competitors", "suppliers", "customers", "partners"] as const;
type Role = typeof ROLES[number];
const TICKER = /^[A-Z0-9][A-Z0-9.^=_:-]{0,39}$/;
const MAX_RESULT_BYTES = 220 * 1024;
interface Node { id: string; name: string | null; ticker: string | null; role: string | null }
interface Metric { metricType?: string; value?: number | null; unit?: string; period?: string; measurementClass?: string; note?: string }
interface Evidence { sourceUrl?: string; title?: string; sourceType?: string; publishedAt?: string }
interface Edge {
  from: string; to: string; type: string; status?: string; confidence?: number | null;
  soleSource?: boolean | null; evidenceCount?: number; lastVerifiedAt?: string;
  metrics?: Metric[]; evidence?: Evidence[];
}
interface Network {
  status?: string; subject?: { name?: string; ticker?: string }; coverage?: Record<string, unknown>;
  nodes?: Node[]; edges?: Edge[]; caveats?: string[];
}
interface Relationship {
  id: string; subjectTicker: string; subjectNodeId: string; role: Role;
  counterparty: { nodeId: string; company: string | null; ticker: string | null };
  direction: { fromNodeId: string; toNodeId: string; type: string };
  status: string | null; verified: boolean; confidence: number | null; soleSource: boolean | null;
  lastVerifiedAt: string | null; evidenceCount: number | null;
  metrics: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>>;
  detailsOmitted: { metrics: number; evidence: number; invalidSourceUrls: number };
}
interface Company {
  ticker: string; status: "available" | "partial" | "unknown" | "unavailable" | "identity_mismatch";
  graphStatus: string | null; subject: { nodeId: string; company: string | null; ticker: string } | null;
  cachedCoverage: Record<string, unknown> | null; observedEdges: number | null;
  matchingRelationships: number | null; returnedRelationships: number; omittedRelationships: number | null;
  ignoredIndirectOrMalformedEdges: number; hiddenUnverifiedRelationships: number;
  countsByRole: Record<Role, number> | null; warnings: string[];
}

const inputSchema = {
  tickers: z.array(z.string().trim().min(1).max(40)).min(2).max(5)
    .describe("Two to five distinct Bullrun listing tickers, e.g. AAPL, BMW or 6324.T. " + TICKER_CONVENTION + " Company names are not accepted here."),
  roles: z.array(z.enum(ROLES)).min(1).max(4).default([...ROLES])
    .describe("Counterparty roles from EACH subject company's point of view; default all four. Suppliers and customers preserve the direction of SUPPLIES_TO."),
  verifiedOnly: z.boolean().default(false)
    .describe("Only VERIFIED edges when true. The default also includes SUGGESTED/NEEDS_REVIEW edges, explicitly labelled with their individual confidence and evidence."),
  limitPerCompany: z.number().int().min(1).max(50).default(25)
    .describe("Maximum direct relationships returned per input company. Shared counterparties are prioritized; totals and any truncation are reported."),
};

function text(value: unknown, max = 240): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function ticker(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return TICKER.test(normalized) ? normalized : null;
}
function nodeId(value: unknown): string | null {
  // IDs are company_entity IDs, not graph-local positions. Never truncate identity keys.
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() ? value : null;
}
function roleOf(edge: Edge, subjectId: string): Role | null {
  if (edge.from === edge.to || edge.from !== subjectId && edge.to !== subjectId) return null;
  if (edge.type === "COMPETES_WITH") return "competitors";
  if (edge.type === "PARTNERS_WITH") return "partners";
  if (edge.type === "SUPPLIES_TO") return edge.to === subjectId ? "suppliers" : "customers";
  return null;
}
function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? value : null; }
  catch { return null; }
}
function metricMeaning(type: unknown): string | null {
  return type === "CUSTOMER_REVENUE_PCT" || type === "SUPPLIER_REVENUE_FROM_CUSTOMER_PCT"
    ? "share of the supplier's revenue that comes from the customer; not the customer's purchasing spend" : null;
}

/** Connected components join ONLY stable entity IDs or exact listing tickers, never names. */
function identities(relationships: Relationship[]) {
  const parent = relationships.map((_, index) => index);
  function find(index: number): number {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  }
  const seen = new Map<string, number>();
  relationships.forEach((relationship, index) => {
    const keys = [`id:${relationship.counterparty.nodeId}`];
    if (relationship.counterparty.ticker) keys.push(`ticker:${relationship.counterparty.ticker}`);
    for (const key of keys) {
      const previous = seen.get(key);
      if (previous != null) parent[find(index)] = find(previous);
      else seen.set(key, index);
    }
  });
  const groups = new Map<number, Relationship[]>();
  relationships.forEach((relationship, index) => {
    const key = find(index);
    groups.set(key, [...(groups.get(key) ?? []), relationship]);
  });
  return [...groups.values()];
}
function sharedGroups(groups: Relationship[][], included?: Set<string>) {
  return groups.flatMap(group => {
    const rows = included ? group.filter(row => included.has(row.id)) : group;
    // Two listing tickers resolving to one subject entity are not two companies.
    if (new Set(rows.map(row => row.subjectNodeId)).size < 2) return [];
    const bySubject = new Map<string, Relationship[]>();
    rows.forEach(row => bySubject.set(row.subjectTicker, [...(bySubject.get(row.subjectTicker) ?? []), row]));
    return [{
      identity: {
        nodeIds: [...new Set(rows.map(row => row.counterparty.nodeId))],
        tickers: [...new Set(rows.map(row => row.counterparty.ticker).filter((value): value is string => value != null))],
        observedNames: [...new Set(rows.map(row => row.counterparty.company).filter((value): value is string => value != null))],
      },
      subjectEntityCount: new Set(rows.map(row => row.subjectNodeId)).size,
      subjects: [...bySubject].map(([subjectTicker, matches]) => ({ subjectTicker,
        subjectNodeId: matches[0].subjectNodeId, roles: [...new Set(matches.map(row => row.role))],
        relationshipIds: matches.map(row => row.id) })),
    }];
  });
}

export function registerCompareCompanyExposures(server: McpServer): void {
  server.registerTool("compare_company_exposures", {
    title: "Compare shared company exposures",
    annotations: { readOnlyHint: true },
    description: "Compare the cached company relationship graphs of two to five stock tickers. Finds shared suppliers, customers, competitors and partners, including cross-role overlaps, using stable company entity IDs or exact tickers only. Returns directed direct relationships with VERIFIED vs SUGGESTED/NEEDS_REVIEW status, confidence, sole-source flags, disclosed metrics with meaning/unit/period, and primary-source URLs/dates. Shared groups reference the evidence-bearing relationship rows by ID. Missing graphs or edges mean unknown coverage. One cached graph read per company (plus a ticker lookup when the typed ticker has no graph); never starts paid discovery, infers exposure weights or estimates portfolio losses. Read-only.",
    inputSchema,
    outputSchema: {
      tickers: z.array(z.string()), requestedRoles: z.array(z.enum(ROLES)), retrievedAt: z.string(),
      companies: z.array(z.record(z.string(), z.unknown())), relationships: z.array(z.record(z.string(), z.unknown())),
      sharedCounterparties: z.array(z.record(z.string(), z.unknown())), totals: z.record(z.string(), z.unknown()),
      methodology: z.record(z.string(), z.unknown()), warnings: z.array(z.string()),
    },
  }, async args => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text" as const, text: 'compare_company_exposures requires the "read:market" scope.' }] }; }
    const tickers = args.tickers.map(value => ticker(value));
    if (tickers.some(value => value == null) || new Set(tickers).size !== tickers.length) {
      return { isError: true, content: [{ type: "text" as const, text: "Provide two to five distinct valid exact listing tickers; duplicates after trimming and uppercasing are not accepted." }] };
    }
    const validTickers = tickers as string[];
    const roles = [...new Set(args.roles)];
    const timeout = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
      ? Math.min(8_000, config.requestTimeoutMs) : 8_000;
    const graph = (symbol: string) => bullrunGet<Network>(`/api/stocks/${encodeURIComponent(symbol)}/relationships`, undefined, timeout)
      .catch(() => null); // Never disclose upstream response bodies, addresses or credentials.
    const resolvedReads = await mapWithConcurrency(validTickers, 3, async input => {
      const network = await graph(input);
      if (!network || network.status !== "none" || network.nodes?.length) return { input, symbol: input, network, notes: [] as string[] };
      // No graph under the typed ticker. It may be a bare code or Yahoo symbol of a stored
      // listing (6324 is stored as 6324.T), so look the ticker up before calling it unknown.
      const resolution = await resolveStockTicker(input).catch(() => null);
      if (!resolution) return { input, symbol: input, network, notes: [] };
      if (!resolution.ticker) return { input, symbol: input, network, notes: [tickerNotFoundText(input, resolution)] };
      const symbol = ticker(resolution.ticker);
      if (!symbol || symbol === input) return { input, symbol: input, network, notes: [] };
      return { input, symbol, network: await graph(symbol), notes: resolution.note ? [resolution.note] : [] };
    });
    // Two inputs can name one listing (6324 and 6324.T); compare it once.
    const reads = resolvedReads.filter((read, index) => resolvedReads.findIndex(other => other.symbol === read.symbol) === index);
    const duplicateInputs = resolvedReads.filter(read => !reads.includes(read))
      .map(read => `${read.input} names the same listing as another input (${read.symbol}); it is compared once.`);
    const eligible: Relationship[] = [];
    const companies: Company[] = reads.map(({ symbol, network, notes }) => {
      const company: Company = { ticker: symbol, status: "unavailable", graphStatus: text(network?.status, 40), subject: null,
        cachedCoverage: null, observedEdges: null, matchingRelationships: null, returnedRelationships: 0,
        omittedRelationships: null, ignoredIndirectOrMalformedEdges: 0, hiddenUnverifiedRelationships: 0,
        countsByRole: null, warnings: [...notes] };
      if (!network || typeof network !== "object") { company.warnings.push("Cached graph could not be retrieved; retry later."); return company; }
      if (ticker(network.subject?.ticker) !== symbol) {
        company.status = "identity_mismatch";
        company.warnings.push("The returned graph subject did not exactly match the requested ticker; its relationships were rejected.");
        return company;
      }
      const nodes = Array.isArray(network.nodes) ? network.nodes : [];
      const selected = nodes.filter(node => node?.role === "SELECTED");
      const candidates = selected.length ? selected : nodes.filter(node => ticker(node?.ticker) === symbol);
      const subject = candidates.length === 1 && ticker(candidates[0]?.ticker) === symbol && nodeId(candidates[0]?.id) ? candidates[0] : null;
      if (network.status === "none" && !nodes.length) {
        company.status = "unknown"; company.warnings.push("No cached company graph exists; relationships are unknown, not absent."); return company;
      }
      const nodeMap = new Map<string, Node>();
      let ambiguousNodes = false;
      nodes.forEach(node => {
        const id = nodeId(node?.id);
        if (!id) return;
        const previous = nodeMap.get(id);
        if (previous && (ticker(previous.ticker) !== ticker(node.ticker) || previous.name !== node.name)) ambiguousNodes = true;
        nodeMap.set(id, node);
      });
      if (!subject || ambiguousNodes) {
        company.status = "identity_mismatch";
        company.warnings.push("An exact unambiguous subject node could not be established; this graph's relationships were rejected.");
        return company;
      }
      company.subject = { nodeId: subject.id, company: text(subject.name), ticker: symbol };
      company.cachedCoverage = network.coverage && typeof network.coverage === "object"
        ? Object.fromEntries(Object.entries(network.coverage).filter(([, value]) => finite(value) != null)) : null;
      company.status = network.status === "ready" ? "available" : "partial";
      company.countsByRole = { competitors: 0, suppliers: 0, customers: 0, partners: 0 };
      const edges = Array.isArray(network.edges) ? network.edges : [];
      company.observedEdges = edges.length;
      company.matchingRelationships = 0;
      company.warnings.push(...(Array.isArray(network.caveats) ? network.caveats : []).slice(0, 5).map(value => text(value, 400)).filter((value): value is string => value != null));
      if (network.status !== "ready") company.warnings.push("The cached graph is incomplete or still being analyzed.");
      edges.forEach((edge, edgeIndex) => {
        const role = edge && roleOf(edge, subject.id);
        const otherId = edge?.from === subject.id ? edge?.to : edge?.from;
        const other = nodeMap.get(otherId);
        if (!role || !other || !nodeId(other.id)) { company.ignoredIndirectOrMalformedEdges++; return; }
        if (!roles.includes(role)) return;
        if (args.verifiedOnly && edge.status !== "VERIFIED") { company.hiddenUnverifiedRelationships++; return; }
        company.countsByRole![role]++;
        company.matchingRelationships!++;
        const metrics = Array.isArray(edge.metrics) ? edge.metrics : [];
        const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
        let invalidUrls = 0;
        const sources = evidence.slice(0, 3).map(value => {
          const url = sourceUrl(value?.sourceUrl);
          if (value?.sourceUrl && !url) invalidUrls++;
          return { url, title: text(value?.title), sourceType: text(value?.sourceType, 80), publishedAt: text(value?.publishedAt, 60) };
        });
        eligible.push({ id: `${symbol}:${edgeIndex}`, subjectTicker: symbol, subjectNodeId: subject.id, role,
          counterparty: { nodeId: other.id, company: text(other.name), ticker: ticker(other.ticker) },
          direction: { fromNodeId: edge.from, toNodeId: edge.to, type: edge.type },
          status: text(edge.status, 40), verified: edge.status === "VERIFIED", confidence: finite(edge.confidence),
          soleSource: typeof edge.soleSource === "boolean" ? edge.soleSource : null,
          lastVerifiedAt: text(edge.lastVerifiedAt, 60), evidenceCount: finite(edge.evidenceCount),
          metrics: metrics.slice(0, 8).map(value => ({ metric: text(value?.metricType, 100), meaning: metricMeaning(value?.metricType),
            value: finite(value?.value), unit: text(value?.unit, 80), period: text(value?.period, 80),
            measurementClass: text(value?.measurementClass, 80), note: text(value?.note) })), evidence: sources,
          detailsOmitted: { metrics: Math.max(0, metrics.length - 8), evidence: Math.max(0, evidence.length - 3), invalidSourceUrls: invalidUrls },
        });
      });
      if (company.ignoredIndirectOrMalformedEdges) { company.status = "partial"; company.warnings.push("Some indirect, malformed or unsupported edges were excluded."); }
      return company;
    });
    const groups = identities(eligible);
    const allShared = sharedGroups(groups);
    const sharedIds = new Set(allShared.flatMap(group => group.subjects.flatMap(subject => subject.relationshipIds)));
    const relationships = companies.flatMap(company => eligible.filter(row => row.subjectTicker === company.ticker)
      .sort((a, b) => Number(sharedIds.has(b.id)) - Number(sharedIds.has(a.id))
        || Number(b.verified) - Number(a.verified) || (b.confidence ?? -1) - (a.confidence ?? -1))
      .slice(0, args.limitPerCompany));
    const warnings = ["Cached disclosures are incomplete: missing relationships and missing graphs mean unknown coverage. Shared counterparties identify connections, not quantified portfolio exposure or loss estimates.", ...duplicateInputs];
    const subjectIds = companies.flatMap(company => company.subject ? [company.subject.nodeId] : []);
    if (new Set(subjectIds).size < subjectIds.length) warnings.push("Some input listing tickers resolve to the same company entity; these listings are not counted as distinct companies in shared groups.");
    const payload = { tickers: reads.map(read => read.symbol), requestedRoles: roles, retrievedAt: new Date().toISOString(), companies, relationships,
      sharedCounterparties: allShared, totals: { matchingRelationships: eligible.length, returnedRelationships: 0,
        omittedRelationships: 0, sharedCounterpartiesInMatchingGraphs: allShared.length, returnedSharedCounterparties: 0,
        truncated: false, responseByteLimit: MAX_RESULT_BYTES },
      methodology: {
        matching: "Counterparties are joined only by stable company_entity node IDs or exact normalized ticker, never fuzzy company names. Node IDs, tickers and observed names are retained. Shared groups require at least two distinct subject entity IDs.",
        evidence: "Each shared group's relationshipIds reference full directed rows in relationships. Each edge keeps its own status, confidence, verification time, sole-source flag and disclosed metrics; confidences and exposures are not aggregated. Up to three source records and eight metrics per edge are returned; detailsOmitted reports extra records.",
        metricBasis: "A supplier's revenue share from a customer does not measure the customer's purchasing dependence. Units, periods and measurement classes remain as disclosed; no currency conversion or invented weights.",
        bounds: "One cached graph GET per company, three concurrent, each with an eight-second maximum timeout. Only a ticker with no graph under the symbol as typed adds a ticker lookup and, when it names another stored listing, one more graph read. Shared edges are prioritized before the per-company limit. The response byte budget can omit further edges; shared groups and returned counts then describe only returned evidence.",
      }, warnings };
    function updateCounts() {
      const included = new Set(relationships.map(row => row.id));
      payload.sharedCounterparties = sharedGroups(groups, included);
      companies.forEach(company => {
        company.returnedRelationships = relationships.filter(row => row.subjectTicker === company.ticker).length;
        company.omittedRelationships = company.matchingRelationships == null ? null : company.matchingRelationships - company.returnedRelationships;
      });
      payload.totals.returnedRelationships = relationships.length;
      payload.totals.omittedRelationships = eligible.length - relationships.length;
      payload.totals.returnedSharedCounterparties = payload.sharedCounterparties.length;
      payload.totals.truncated = payload.totals.omittedRelationships > 0 || eligible.some(row => Object.values(row.detailsOmitted).some(count => count > 0));
    }
    updateCounts();
    while (Buffer.byteLength(JSON.stringify(toolResult(payload)), "utf8") > MAX_RESULT_BYTES && relationships.length) {
      // Remove non-shared rows first; shared evidence remains inspectable for as long as possible.
      let remove = relationships.findLastIndex(row => !sharedIds.has(row.id));
      if (remove < 0) remove = relationships.length - 1;
      relationships.splice(remove, 1);
      updateCounts();
    }
    const result = toolResult(payload);
    return companies.some(company => company.status === "available" || company.status === "partial")
      ? result : { ...result, isError: true };
  });
}
