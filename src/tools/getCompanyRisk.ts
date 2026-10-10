import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import {
  BAND_SCALE,
  RISK_METHOD_NOTE,
  compactDial,
  compactReading,
  round,
  type RiskDialCluster,
} from "./riskData.js";

const MODULES = ["dials", "risk_factors", "supplier_exposure", "events", "headline"] as const;
type Module = (typeof MODULES)[number];
const DEFAULT_MODULES: Module[] = ["dials", "risk_factors", "supplier_exposure"];

interface RiskPreview {
  dials: RiskDialCluster | null;
  headline: { headline: string; url: string | null; publisher: string | null; publishedAt: string | null } | null;
}

interface RiskProfileRow {
  riskLabel: string | null;
  riskClass: string | null;
  mechanism: string | null;
  direction: string | null;
  severity: string | null;
  currentExposure: string | null;
  trigger: string | null;
  mitigation: string | null;
  thesisWorse: string | null;
  sourceQuality: string | null;
  status: string | null;
  confidence: number | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  asOfDate: string | null;
}

interface SupplierExposure {
  ticker: string;
  currency: string | null;
  suppliers: Array<{
    supplier: string;
    ticker: string | null;
    disclosedPct: number | null;
    period: string | null;
    soleSource: boolean;
    spendInSubjectCcy: number | null;
    shareOfIdentifiedPct: number | null;
  }> | null;
  identifiedSpend: number | null;
  costOfRevenue: number | null;
  costOfRevenueYear: number | null;
  coveragePctOfCogs: number | null;
  hhiOfIdentified: number | null;
  top1SharePct: number | null;
  soleSourceCount: number | null;
  unpricedSuppliers: Array<Record<string, unknown>> | null;
}

interface CompanyEvent {
  eventType: string | null;
  headline: string | null;
  summary: string | null;
  severity: string | null;
  impact: string | null;
  status: string | null;
  confidence: number | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  discoveredAt: string | null;
}

const SEVERITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, WATCH: 1, LOW: 2, INFO: 3 };

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function bySeverityThenConfidence<T extends { severity: string | null; confidence: number | null }>(a: T, b: T): number {
  const s = (SEVERITY_RANK[a.severity ?? ""] ?? 9) - (SEVERITY_RANK[b.severity ?? ""] ?? 9);
  return s !== 0 ? s : (b.confidence ?? 0) - (a.confidence ?? 0);
}

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Exact Bullrun ticker, native local-exchange symbol (e.g. \"AAPL\", \"ASML\", \"NESN\", \"005930\"); no Yahoo-style suffixes."),
  include: z.array(z.enum(MODULES)).min(1).optional()
    .describe("Modules to return. dials = composite + six mechanism dials (market expectation, operating pressure, cash conversion, leverage, competitive position, concentration); risk_factors = filing-derived risk factors (10-K/annual report) with severity and mechanism; supplier_exposure = identified supplier spend concentration; events = recent restructuring/legal/supply/recall events; headline = latest news headline beside the dials. Default: dials, risk_factors, supplier_exposure."),
  detail: z.enum(["summary", "full"]).default("summary")
    .describe("summary = scores, bands, drivers and explanations; full = also every per-input term behind each category score."),
  maxRiskFactors: z.number().int().min(1).max(50).default(10)
    .describe("Max filing risk factors to return, most severe first."),
  maxEvents: z.number().int().min(1).max(40).default(10)
    .describe("Max recent company events to return, most severe first."),
};

export function registerGetCompanyRisk(server: McpServer): void {
  server.registerTool(
    "get_company_risk",
    {
      title: "Get company risk profile",
      annotations: { readOnlyHint: true },
      description:
        "Bullrun's company risk read for one stock: a 0-100 composite risk score and six mechanism dials (market expectation, operating pressure, cash conversion, leverage & coverage, competitive position, concentration) with band (Contained/Normal/Elevated/Stretched/Acute), direction vs the prior reading, the driving input and a plain-English explanation; plus filing-derived risk factors (severity, mechanism, source filing), identified supplier concentration (share of cost base covered, HHI, sole-source count, top supplier share) and recent material events. Use for \"how risky is X\", \"what are the main risks for X\", \"is X's supply chain concentrated\", or before adding a stock to a portfolio. Pair with get_company_relationships for the named competitors/suppliers/customers behind the concentration dial. Bands describe measured strain, never a buy/sell view. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        if (!ticker) return { isError: true, content: [{ type: "text", text: "ticker is required" }] };
        const enc = encodeURIComponent(ticker);
        const include = new Set<Module>(args.include?.length ? args.include : DEFAULT_MODULES);
        const withTerms = args.detail === "full";
        const base = `/api/company-intelligence/${enc}`;

        const [identity, preview, factors, suppliers, events] = await Promise.all([
          findExactStock(ticker),
          include.has("dials") || include.has("headline")
            ? safe(bullrunGet<RiskPreview>(`${base}/risk-preview`))
            : Promise.resolve(null),
          include.has("risk_factors")
            ? safe(bullrunGet<RiskProfileRow[]>(`${base}/risk-profile`, { limit: 200 }))
            : Promise.resolve(null),
          include.has("supplier_exposure")
            ? safe(bullrunGet<SupplierExposure>(`${base}/supplier-exposure`))
            : Promise.resolve(null),
          include.has("events")
            ? safe(bullrunGet<CompanyEvent[]>(`${base}/events`, { limit: 40 }))
            : Promise.resolve(null),
        ]);

        const warnings: string[] = [];
        const modules: Record<string, unknown> = {};

        if (include.has("dials")) {
          const cluster = preview?.dials ?? null;
          if (!cluster) {
            modules.dials = null;
            warnings.push("Risk dials could not be loaded for this ticker.");
          } else {
            const dark = (cluster.dials ?? []).filter((d) => d.score == null).map((d) => d.key);
            if (dark.length) {
              warnings.push(`Dark dials (no stored reading, which means unmeasured rather than safe): ${dark.join(", ")}.`);
            }
            modules.dials = {
              asOfDate: cluster.asOfDate,
              formulaVersion: cluster.formulaVersion,
              composite: cluster.composite ? compactReading(cluster.composite, withTerms) : null,
              ...(cluster.composite ? {} : { compositeAbsentWhy: cluster.compositeAbsentWhy }),
              dials: (cluster.dials ?? []).map((d) => compactDial(d, withTerms)),
            };
          }
        }

        if (include.has("headline")) {
          modules.headline = preview?.headline ?? null;
          if (preview?.headline) {
            warnings.push("The headline is context beside the dials, never an input to them; the dials read filings and market data.");
          }
        }

        if (include.has("risk_factors")) {
          const rows = [...(factors ?? [])].sort(bySeverityThenConfidence);
          modules.riskFactors = {
            total: rows.length,
            returned: Math.min(rows.length, args.maxRiskFactors),
            bySeverity: rows.reduce<Record<string, number>>((acc, r) => {
              const k = r.severity ?? "UNKNOWN";
              acc[k] = (acc[k] ?? 0) + 1;
              return acc;
            }, {}),
            factors: rows.slice(0, args.maxRiskFactors).map((r) => ({
              risk: clip(r.riskLabel, 300),
              category: r.riskClass,
              severity: r.severity,
              confidence: round(r.confidence, 2),
              mechanism: clip(r.mechanism, 600),
              trigger: clip(r.trigger, 300),
              mitigation: clip(r.mitigation, 300),
              thesisWorse: clip(r.thesisWorse, 300),
              status: r.status,
              sourceQuality: r.sourceQuality,
              source: r.sourceTitle,
              sourceUrl: r.sourceUrl,
              asOfDate: r.asOfDate,
            })),
          };
          if (!rows.length) warnings.push("No filing-derived risk factors are stored for this company yet.");
          else if (rows.every((r) => r.status === "SUGGESTED")) {
            warnings.push("Risk factors are machine-extracted from the filing (status SUGGESTED) and not individually reviewed.");
          }
        }

        if (include.has("supplier_exposure")) {
          if (!suppliers || !suppliers.suppliers?.length) {
            modules.supplierExposure = null;
            warnings.push("No priced supplier relationships are on file, so supplier concentration is unknown (not zero).");
          } else {
            modules.supplierExposure = {
              currency: suppliers.currency,
              identifiedSpend: suppliers.identifiedSpend,
              costOfRevenue: suppliers.costOfRevenue,
              costOfRevenueYear: suppliers.costOfRevenueYear,
              coveragePctOfCogs: suppliers.coveragePctOfCogs,
              hhiOfIdentified: suppliers.hhiOfIdentified,
              top1SharePct: suppliers.top1SharePct,
              soleSourceCount: suppliers.soleSourceCount,
              suppliers: suppliers.suppliers.map((s) => ({
                supplier: s.supplier,
                ticker: s.ticker,
                supplierRevenueFromThisCompanyPct: s.disclosedPct,
                period: s.period,
                soleSource: s.soleSource,
                estimatedSpend: s.spendInSubjectCcy != null ? Math.round(s.spendInSubjectCcy) : null,
                shareOfIdentifiedSpendPct: s.shareOfIdentifiedPct,
              })),
              unpricedSuppliers: suppliers.unpricedSuppliers ?? [],
            };
            warnings.push(
              `Supplier shares are of IDENTIFIED spend, which covers ${suppliers.coveragePctOfCogs ?? "an unknown share"}% of cost of revenue; spend is estimated from each supplier's disclosed revenue share from this company.`,
            );
          }
        }

        if (include.has("events")) {
          const rows = [...(events ?? [])].sort(bySeverityThenConfidence);
          modules.events = rows.slice(0, args.maxEvents).map((e) => ({
            type: e.eventType,
            headline: clip(e.headline, 240),
            summary: clip(e.summary, 400),
            severity: e.severity,
            impact: e.impact,
            status: e.status,
            confidence: round(e.confidence, 2),
            sourceUrl: e.sourceUrl,
            publishedAt: e.publishedAt,
            discoveredAt: e.discoveredAt,
          }));
          if (!rows.length) warnings.push("No company events are stored for this ticker.");
        }

        // The dials endpoint never 404s (an unknown ticker comes back as six dark dials), so
        // "found" means something was actually measured or stored for it.
        const cluster = preview?.dials ?? null;
        const measured = Boolean(cluster?.composite) || (cluster?.dials ?? []).some((d) => d.score != null)
          || Boolean(factors?.length) || Boolean(suppliers?.suppliers?.length) || Boolean(events?.length);
        if (!identity && !measured) {
          return {
            content: [{
              type: "text",
              text: `No risk data found for "${ticker}". Use the plain local-exchange symbol (e.g. "BMW" not "BMW.DE"), or find the exact symbol with screen_stocks.`,
            }],
          };
        }

        return toolResult({
          ticker,
          identity: identityPayload(identity),
          requestedModules: [...include],
          methodology: RISK_METHOD_NOTE,
          bandScale: BAND_SCALE,
          modules,
          warnings,
          webPage: `https://bull-run.org/stocks/${enc}/analysis`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_company_risk failed: ${msg}` }] };
      }
    },
  );
}
