import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { round } from "./riskData.js";
import { resolveStockTicker, TICKER_CONVENTION, tickerNotFoundText } from "./stockIdentity.js";

interface NetworkNode { id: string; name: string; role: string; ticker: string | null }
interface NetworkMetric {
  metricType: string;
  value: number | null;
  unit: string | null;
  period: string | null;
  measurementClass: string | null;
  note: string | null;
}
interface NetworkEvidence {
  sourceUrl: string | null;
  title: string | null;
  excerpt: string | null;
  sourceType: string | null;
  publishedAt: string | null;
}
interface NetworkEdge {
  from: string;
  to: string;
  type: string;
  status: string;
  confidence: number | null;
  soleSource: boolean;
  evidenceCount: number;
  lastVerifiedAt: string | null;
  metrics: NetworkMetric[] | null;
  evidence: NetworkEvidence[] | null;
}
interface CompanyNetwork {
  status: string;
  subject: { name: string; ticker: string } | null;
  coverage: Record<string, number> | null;
  nodes: NetworkNode[] | null;
  edges: NetworkEdge[] | null;
  caveats: string[] | null;
}

const ROLES = ["competitors", "suppliers", "customers", "partners"] as const;
type Role = (typeof ROLES)[number];

/** The API filters by edge type; suppliers and customers are two directions of SUPPLIES_TO. */
const ROLE_TO_TYPE: Record<Role, string> = {
  competitors: "COMPETES_WITH",
  suppliers: "SUPPLIES_TO",
  customers: "SUPPLIES_TO",
  partners: "PARTNERS_WITH",
};

const METRIC_MEANING: Record<string, string> = {
  CUSTOMER_REVENUE_PCT: "share of the supplier's revenue that comes from the customer",
  SUPPLIER_REVENUE_FROM_CUSTOMER_PCT: "share of the supplier's revenue that comes from the customer",
};

/** Which role the counterparty plays for the subject, read off the edge direction. */
function roleOf(edge: NetworkEdge, subjectId: string): Role | null {
  switch (edge.type) {
    case "COMPETES_WITH": return "competitors";
    case "PARTNERS_WITH": return "partners";
    case "SUPPLIES_TO": return edge.to === subjectId ? "suppliers" : "customers";
    default: return null;
  }
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Bullrun ticker, e.g. \"AAPL\", \"SAP\", \"ASML\". " + TICKER_CONVENTION),
  roles: z.array(z.enum(ROLES)).min(1).optional()
    .describe("Which relationships to return, from this company's point of view. Default: all four."),
  verifiedOnly: z.boolean().default(false)
    .describe("true = only edges confirmed against a primary source (filing, company release). false also returns search-suggested edges, each labelled with its status and confidence."),
  evidence: z.enum(["none", "sources", "excerpts"]).default("sources")
    .describe("none = counts only; sources = source title/URL/type per edge; excerpts = also the quoted evidence text."),
  limitPerRole: z.number().int().min(1).max(100).default(25)
    .describe("Max counterparties per role, verified and highest-confidence first."),
};

export function registerGetCompanyRelationships(server: McpServer): void {
  server.registerTool(
    "get_company_relationships",
    {
      title: "Get company relationship network",
      annotations: { readOnlyHint: true },
      description:
        "Bullrun's company relationship graph for one stock: named competitors, suppliers, customers and partners, each with its Bullrun ticker when the counterparty is listed, verification status (VERIFIED against a primary filing/source vs search-SUGGESTED), confidence, sole-source flag, quantified dependence where disclosed (e.g. \"Cirrus Logic gets 91% of revenue from Apple\") and the evidence behind it. Use for supply-chain and second-order risk questions (\"who supplies X\", \"who depends on X\", \"who competes with X\", \"which listed companies are exposed if X stumbles\"), then call get_company_risk or get_stock_metrics on the counterparties' tickers. Returns only the cached graph and never starts a paid discovery run; a company with no graph yet reports status \"none\". A missing edge is not proof of no relationship. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        if (!args.ticker.trim()) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        const resolution = await resolveStockTicker(args.ticker);
        if (!resolution.ticker) {
          return { content: [{ type: "text" as const, text: tickerNotFoundText(args.ticker, resolution) }] };
        }
        const ticker = resolution.ticker;
        const roles = new Set<Role>(args.roles?.length ? args.roles : ROLES);
        const types = [...new Set([...roles].map((r) => ROLE_TO_TYPE[r]))].join(",");

        let network: CompanyNetwork;
        try {
          network = await bullrunGet<CompanyNetwork>(`/api/stocks/${encodeURIComponent(ticker)}/relationships`, { types });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/ 404 /.test(msg)) {
            return toolResult({
              ticker,
              status: "unavailable",
              message: "The company relationship graph is not available on this Bullrun deployment.",
            });
          }
          throw err;
        }

        const nodes = new Map((network.nodes ?? []).map((n) => [n.id, n]));
        const subject = (network.nodes ?? []).find((n) => n.role === "SELECTED")
          ?? (network.nodes ?? []).find((n) => n.ticker?.toUpperCase() === ticker);
        const grouped: Record<Role, Array<Record<string, unknown> & { _sort: number }>> = {
          competitors: [], suppliers: [], customers: [], partners: [],
        };
        let indirectEdges = 0;
        let hiddenUnverified = 0;

        for (const edge of network.edges ?? []) {
          if (!subject || (edge.from !== subject.id && edge.to !== subject.id)) {
            indirectEdges++;
            continue;
          }
          const role = roleOf(edge, subject.id);
          if (!role || !roles.has(role)) continue;
          if (args.verifiedOnly && edge.status !== "VERIFIED") {
            hiddenUnverified++;
            continue;
          }
          const other = nodes.get(edge.from === subject.id ? edge.to : edge.from);
          const evidence = args.evidence === "none" ? undefined : (edge.evidence ?? []).map((ev) => ({
            title: clip(ev.title, 200),
            url: ev.sourceUrl,
            sourceType: ev.sourceType,
            publishedAt: ev.publishedAt,
            ...(args.evidence === "excerpts" ? { excerpt: clip(ev.excerpt, 500) } : {}),
          }));
          grouped[role].push({
            company: other?.name ?? null,
            ticker: other?.ticker ?? null,
            status: edge.status,
            confidence: round(edge.confidence, 2),
            soleSource: edge.soleSource,
            ...(edge.metrics?.length
              ? {
                  quantified: edge.metrics.map((m) => ({
                    metric: m.metricType,
                    meaning: METRIC_MEANING[m.metricType] ?? null,
                    value: m.value,
                    unit: m.unit,
                    period: m.period,
                    measurementClass: m.measurementClass,
                    note: clip(m.note, 240),
                  })),
                }
              : {}),
            evidenceCount: edge.evidenceCount,
            lastVerifiedAt: edge.lastVerifiedAt,
            ...(evidence ? { evidence } : {}),
            _sort: (edge.status === "VERIFIED" ? 2 : 0) + (edge.metrics?.length ? 1 : 0) + (edge.confidence ?? 0),
          });
        }

        const relationships: Record<string, unknown> = {};
        const counts: Record<string, number> = {};
        for (const role of roles) {
          const rows = grouped[role].sort((a, b) => b._sort - a._sort);
          counts[role] = rows.length;
          relationships[role] = rows.slice(0, args.limitPerRole).map(({ _sort, ...rest }) => rest);
        }

        const status = network.status ?? "none";
        const warnings: string[] = [...(network.caveats ?? [])];
        if (status === "none" || !(network.edges ?? []).length) {
          warnings.push("No relationship graph has been built for this company yet; it can be requested from the Network section of the company's analysis page on bull-run.org. Absence of edges here says nothing about real-world relationships.");
        } else if (status === "analyzing") {
          warnings.push("A discovery run is in progress; the graph may be incomplete. Retry later for fuller coverage.");
        }
        if (hiddenUnverified) {
          warnings.push(`${hiddenUnverified} search-suggested relationship(s) were left out by verifiedOnly; call again with verifiedOnly=false to see them with their confidence.`);
        }

        return toolResult({
          ticker,
          subject: network.subject ?? null,
          status,
          coverage: network.coverage ?? null,
          counts,
          relationships,
          ...(indirectEdges ? { edgesNotTouchingSubject: indirectEdges } : {}),
          warnings,
          webPage: `https://bull-run.org/stocks/${encodeURIComponent(ticker)}/analysis#network`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_company_relationships failed: ${msg}` }] };
      }
    },
  );
}
