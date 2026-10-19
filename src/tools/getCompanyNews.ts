import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { findExactStock, identityPayload, safe } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import { newsCutoff, newsInstant, selectCompanyNews } from "./companyNewsData.js";

interface NewsCoverage {
  ticker?: unknown;
  datasets?: Array<{ dataset?: string; status?: string; latestStoredAt?: string | null; storedAtMeaning?: string | null }>;
}

const NEWS_SOURCE_LIMIT = 50;
const STALE_AFTER_HOURS = 24;

export function registerGetCompanyNews(server: McpServer): void {
  server.registerTool("get_company_news", {
    title: "Get company news with sources and freshness",
    // Read-only for user/domain data. The disclosed refresh/demand bookkeeping
    // changes only operational caches, like analytics attached to other reads.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    description: "Get cached company news for one exact Bullrun ticker, newest publication first, with publisher, source URL, publication date and stored-fetch freshness when recorded. Optional since cutoff and limit up to 50; only the newest 50 stored articles are searched. Useful for company headlines and article sources; use get_corporate_calendar for scheduled earnings/dividends and get_earnings_call_transcript for call text. Reading news also registers demand and requests a best-effort background cache refresh; this response does not wait for or confirm a refresh. Cached/empty/stale results do not establish that no new events exist. Does not change portfolios or place trades.",
    inputSchema: {
      ticker: z.string().trim().min(1).max(32).describe("Exact native Bullrun company ticker, e.g. AAPL, SAP or ABBN. Resolve the symbol with search_stocks first if uncertain."),
      since: z.string().refine(value => newsCutoff(value) != null, "Use a real YYYY-MM-DD date or an ISO timestamp with seconds and explicit Z/UTC offset.").optional()
        .describe("Inclusive publication-time cutoff. YYYY-MM-DD means midnight UTC; timestamps need an explicit Z or UTC offset. Applied to the newest 50 stored articles, not a full historical news archive."),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum returned articles, newest publication first. Up to 50 cached source articles are read before cutoff filtering."),
    },
  }, async ({ ticker: rawTicker, since, limit }) => {
    try { requirePublicScope("read:market"); }
    catch { return { isError: true, content: [{ type: "text", text: 'get_company_news requires the "read:market" scope.' }] }; }
    try {
      const ticker = rawTicker.toUpperCase();
      const identity = await findExactStock(ticker);
      if (!identity) return { isError: true, content: [{ type: "text", text: "No exact Bullrun stock identity was found. Use search_stocks to resolve its native ticker before requesting news." }] };
      const enc = encodeURIComponent(ticker);
      const [raw, manifest] = await Promise.all([
        bullrunGet<unknown>(`/api/stocks/${enc}/news`, { limit: NEWS_SOURCE_LIMIT }, 8_000),
        safe(bullrunGet<NewsCoverage>(`/api/stocks/${enc}/data-coverage`, undefined, 8_000)),
      ]);
      if (!Array.isArray(raw)) throw new Error("Invalid news response");
      const cutoff = since ? newsCutoff(since) : null;
      const selected = selectCompanyNews(raw.slice(0, NEWS_SOURCE_LIMIT), ticker, cutoff, limit);
      const dataset = typeof manifest?.ticker === "string" && manifest.ticker.toUpperCase() === ticker && Array.isArray(manifest.datasets)
        ? manifest.datasets.find(row => row?.dataset === "company_news") : null;
      const sourceFetchedAt = newsInstant(dataset?.latestStoredAt);
      const retrievedAt = new Date().toISOString();
      const ageHours = sourceFetchedAt ? (Date.parse(retrievedAt) - Date.parse(sourceFetchedAt)) / 3_600_000 : null;
      const freshnessStatus = ageHours == null || ageHours < 0 ? "unknown" : ageHours > STALE_AFTER_HOURS ? "stale" : "recently_stored";
      const warnings = ["The API serves cached rows immediately and may queue a background refresh after registering this ticker as requested. Refresh acceptance/completion is not returned, and it may be disabled, throttled or fail. Retry later to observe any update."];
      if (!selected.articles.length) warnings.push("No matching usable articles were returned from the newest 50 stored rows. This is unknown news coverage, not proof that no company news exists.");
      if (freshnessStatus === "stale") warnings.push(`The newest recorded article fetch is older than ${STALE_AFTER_HOURS} hours; these cached headlines may miss recent events.`);
      if (freshnessStatus === "unknown") warnings.push("An absolute stored-fetch time is unavailable or invalid, so cache freshness is unknown. Publication dates and this retrieval time are not fetch times.");
      if (raw.length >= NEWS_SOURCE_LIMIT) warnings.push("The 50-article source cap was reached; older matching articles may exist outside this bounded result.");
      if (selected.omittedRows) warnings.push(`${selected.omittedRows} rows with mismatched ticker, missing headline or invalid/timezone-free publication time were omitted.`);
      if (selected.duplicateArticles) warnings.push(`${selected.duplicateArticles} duplicate article identifiers/URLs were omitted.`);
      if (selected.articles.some(row => row.textTruncated)) warnings.push("Long headline/summary snippets were truncated; follow the source URL for the original article.");
      if (selected.articles.some(row => !row.source || !row.url)) warnings.push("Some stored articles have no usable publisher or source URL; those source fields remain null.");
      return toolResult({
        ticker, identity: identityPayload(identity), status: selected.articles.length ? "available" : "no_matching_stored_articles",
        articles: selected.articles,
        coverage: { sourceArticleLimit: NEWS_SOURCE_LIMIT, requestedLimit: limit, since: cutoff,
          loadedRows: Math.min(raw.length, NEWS_SOURCE_LIMIT), usableLoadedArticles: selected.loadedUsableArticles,
          matchingLoadedArticles: selected.matchingArticles, returnedArticles: selected.articles.length,
          sourceLimitReached: raw.length >= NEWS_SOURCE_LIMIT, mayBeTruncated: raw.length >= NEWS_SOURCE_LIMIT || selected.matchingArticles > limit,
          latestLoadedPublicationAt: selected.latestLoadedPublicationAt, oldestLoadedPublicationAt: selected.oldestLoadedPublicationAt,
          omittedRows: selected.omittedRows, duplicateArticles: selected.duplicateArticles },
        freshness: { retrievedAt, sourceFetchedAt, storedAtMeaning: dataset?.storedAtMeaning ?? null,
          ageHours: ageHours == null || ageHours < 0 ? null : Number(ageHours.toFixed(2)),
          status: freshnessStatus, staleAfterHours: STALE_AFTER_HOURS, datasetStatus: dataset?.status ?? "unknown",
          refresh: { behavior: "cached_read_with_best_effort_background_refresh", accepted: null, completed: null } },
        methodology: {
          ordering: "Newest absolute publication instant first, then article identifier/URL/headline for ties. All output timestamps are normalized to UTC.",
          dates: "since is inclusive. A date-only cutoff means 00:00:00 UTC. Invalid and timezone-free article timestamps are omitted rather than guessed.",
          freshness: "sourceFetchedAt is the latest stored article-fetch timestamp across this company's cached dataset, when recorded. It is not proof every returned article was just fetched, or that a subsequent empty/failed refresh succeeded. recently_stored uses a 24-hour threshold and does not mean live or comprehensive news.",
          sources: "Articles and summaries are provider content, not verified filings or investment conclusions. Source URL/publisher can be missing; no article body or sentiment score is invented.",
        },
        warnings,
      });
    } catch {
      return { isError: true, content: [{ type: "text", text: "Company news could not be loaded. Check the exact Bullrun ticker and retry later; no refresh completion can be confirmed." }] };
    }
  });
}
