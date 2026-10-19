import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { cleanText, discoveryIdentity, discoveryRows, finiteNumber, sameIssuer, sameText, type DiscoveryStock } from "./stockDiscoveryData.js";

const CANDIDATE_CAP = 500;

export function registerFindStockPeers(server: McpServer): void {
  server.registerTool("find_stock_peers", {
    title: "Discover comparable stock candidates",
    annotations: { readOnlyHint: true },
    description: "Discover stock comparison candidates for one exact Bullrun ticker using stored industry or sector classification. Discloses the chosen classification, country preference, deterministic selection order, scan cap and issuer/listing exclusions. Excludes the subject, secondary listings and identifiable duplicate issuers/share classes. Returns compact stored multiples/growth plus ready-to-use compare_stocks arguments. Classification peers are not verified competitors or a financial-similarity ranking; no generated peers or paid graph discovery. Read-only.",
    inputSchema: {
      ticker: z.string().trim().min(1).max(80).describe("Exact native Bullrun equity ticker. Use search_stocks first for a company name, ISIN or Yahoo-format symbol."),
      matchBy: z.enum(["auto", "industry", "sector"]).default("auto").describe("auto uses exact stored industry when present, otherwise sector. It does not silently widen an empty industry result to the entire sector."),
      sameCountryOnly: z.boolean().default(false).describe("Restrict to the subject's exact stored country. Otherwise same-country candidates are shown first, followed by other countries."),
      limit: z.number().int().min(1).max(10).default(4).describe("Maximum peers. compare_stocks supports the subject plus at most four selected peers."),
    },
  }, async args => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text" as const, text: 'find_stock_peers requires the "read:market" scope.' }] }; }
    try {
      const ticker = args.ticker.trim().toUpperCase();
      const subject = await bullrunGet<DiscoveryStock>(`/api/stocks/${encodeURIComponent(ticker)}`, undefined, 6_000);
      if (!subject || !sameText(subject.ticker, ticker) || subject.quoteType != null && !sameText(subject.quoteType, "EQUITY")) {
        return { isError: true, content: [{ type: "text" as const, text: "No exact equity identity matched this ticker. Resolve the intended native stock listing with search_stocks first." }] };
      }
      const classification = args.matchBy === "auto" ? cleanText(subject.industry) ? "industry" : "sector" : args.matchBy;
      const classificationValue = cleanText(subject[classification], 140);
      if (!classificationValue || args.sameCountryOnly && !cleanText(subject.country)) {
        return { isError: true, content: [{ type: "text" as const, text: "The subject lacks the requested stored classification or country. Choose another explicit matching scope; no broader peer set was inferred." }] };
      }
      const raw = discoveryRows(await bullrunGet<unknown>("/api/stocks", { quoteType: "EQUITY", [classification]: classificationValue,
        country: args.sameCountryOnly ? subject.country : undefined, includeSecondary: false, includeInactive: false, limit: CANDIDATE_CAP }, 10_000));
      let duplicateExclusions = 0;
      let otherExclusions = 0;
      const eligible = raw.filter(row => {
        const lifecycle = cleanText(row.lifecycleStatus)?.toUpperCase();
        if (row.primaryTicker || row.quoteType != null && !sameText(row.quoteType, "EQUITY")
          || !sameText(row[classification], classificationValue)
          || args.sameCountryOnly && !sameText(row.country, subject.country)
          || lifecycle != null && lifecycle !== "ACTIVE"
          || row.succeededBy) { otherExclusions++; return false; }
        if (sameIssuer(subject, row)) { duplicateExclusions++; return false; }
        return true;
      }).sort((a, b) => Number(sameText(b.country, subject.country)) - Number(sameText(a.country, subject.country))
        || (cleanText(a.company) ?? a.ticker).localeCompare(cleanText(b.company) ?? b.ticker)
        || a.ticker.localeCompare(b.ticker));
      const unique: DiscoveryStock[] = [];
      for (const row of eligible) {
        if (unique.some(other => sameIssuer(other, row))) duplicateExclusions++;
        else unique.push(row);
      }
      const peers = unique.slice(0, args.limit);
      return toolResult({
        ticker, subject: discoveryIdentity(subject), retrievedAt: new Date().toISOString(),
        selection: { matchByRequested: args.matchBy, effectiveMatchBy: classification, classificationValue,
          sameCountryOnly: args.sameCountryOnly, primaryListingsOnly: true, includeInactive: false,
          order: "Subject country first, then company name, then ticker; not ranked by investment merit or financial similarity.",
          issuerDeduplication: "Exclude matching canonical tickers, ISIN, LEI, CIK or normalized company names where available. Different share classes of a known same issuer are excluded." },
        returnedCount: peers.length,
        peers: peers.map(row => ({ ...discoveryIdentity(row),
          matchReason: `Same stored ${classification}${sameText(row.country, subject.country) ? " and country" : ""}`,
          storedMetrics: { peRatio: finiteNumber(row.peRatio), revenueGrowthPct: finiteNumber(row.revenueGrowthPct),
            marketCap: finiteNumber(row.marketCap), marketCapCurrency: null, asOfDate: null,
            growthBasis: "Backend stock-search summary; fiscal period and source date are not exposed." } })),
        comparison: peers.length ? { tool: "compare_stocks", arguments: { tickers: [ticker, ...peers.slice(0, 4).map(row => row.ticker)],
          include: ["fundamentals", "quality", "valuation", "risk"] }, omittedPeers: Math.max(0, peers.length - 4) } : null,
        coverage: { candidatesReturnedByBackend: raw.length, candidateCap: CANDIDATE_CAP, backendMayBeTruncated: raw.length >= CANDIDATE_CAP,
          eligibleUniqueCandidates: unique.length, duplicateIssuerExclusions: duplicateExclusions, otherExclusions,
          outputTruncated: unique.length > args.limit, completeUniverse: false },
        warnings: ["Shared industry/sector is a screening heuristic, not evidence that these companies compete directly. Use get_company_relationships for cached competitor evidence.",
          "Issuer exclusions are best-effort: identifiers/company names may be missing, stale or inconsistent. A surviving candidate is not proof of an independent economic issuer.",
          "Stock-search metric dates, reporting periods and market-cap currencies are not supplied by this endpoint. Monetary values are not used to rank candidates; use compare_stocks to inspect source periods and currency differences.",
          ...(raw.length >= CANDIDATE_CAP ? ["The backend candidate cap was reached. The displayed peer set can omit other eligible companies."] : []),
          ...(peers.length ? [] : ["No eligible peers were found in this bounded classification search. This does not establish that the company has no competitors or comparable businesses."]),
          ...(subject.quoteType == null ? ["The subject's quote type is unclassified; the backend treats it as equity, but this is not a confirmed instrument classification."] : []),
        ],
      });
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Stock peers could not be loaded. Check the exact ticker and retry. No graph enrichment or paid discovery was started." }] };
    }
  });
}
