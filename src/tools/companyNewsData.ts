import { validCalendarDate } from "./stockPriceHistoryData.js";

/** Reject timezone-free timestamps and impossible dates instead of silently shifting them. */
export function newsInstant(value: unknown): string | null {
  if (typeof value !== "string" || !validCalendarDate(value.slice(0, 10)) ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function newsCutoff(value: string): string | null {
  return validCalendarDate(value) ? `${value}T00:00:00.000Z` : newsInstant(value);
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function articleUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export interface CompanyNewsArticle {
  newsId: string | null;
  publishedAt: string;
  headline: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  sourceFetchedAt: string | null;
  textTruncated: boolean;
}

export function selectCompanyNews(raw: unknown[], ticker: string, since: string | null, limit: number) {
  const usable: CompanyNewsArticle[] = [];
  let omittedRows = 0;
  let duplicateArticles = 0;
  const seen = new Set<string>();
  for (const value of raw) {
    if (value == null || typeof value !== "object") { omittedRows++; continue; }
    const row = value as Record<string, unknown>;
    const publishedAt = newsInstant(row.publishedAt);
    const headline = boundedText(row.headline, 1024);
    if (typeof row.ticker !== "string" || row.ticker.toUpperCase() !== ticker || !publishedAt || !headline) { omittedRows++; continue; }
    const url = articleUrl(row.url);
    const newsId = boundedText(row.newsId, 256);
    const key = newsId ?? url ?? `${publishedAt}:${headline}`;
    if (seen.has(key)) { duplicateArticles++; continue; }
    seen.add(key);
    usable.push({ newsId, publishedAt, headline, summary: boundedText(row.summary, 2000),
      source: boundedText(row.publisher, 256), url, sourceFetchedAt: newsInstant(row.fetchedAt),
      textTruncated: (typeof row.headline === "string" && row.headline.trim().length > 1024) || (typeof row.summary === "string" && row.summary.trim().length > 2000),
    });
  }
  usable.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || (a.newsId ?? a.url ?? a.headline).localeCompare(b.newsId ?? b.url ?? b.headline));
  const matching = usable.filter(row => since == null || row.publishedAt >= since);
  return { articles: matching.slice(0, limit), loadedUsableArticles: usable.length, matchingArticles: matching.length,
    latestLoadedPublicationAt: usable[0]?.publishedAt ?? null, oldestLoadedPublicationAt: usable.at(-1)?.publishedAt ?? null,
    omittedRows, duplicateArticles };
}
