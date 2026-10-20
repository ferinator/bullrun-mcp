import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet, config } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import { resolveStockTicker } from "./stockIdentity.js";

const TYPES = ["earnings", "ex_dividend", "listings"] as const;
type CalendarType = (typeof TYPES)[number];
const PATHS: Record<CalendarType, string> = {
  earnings: "/api/calendar/earnings",
  ex_dividend: "/api/calendar/ex-dividend",
  listings: "/api/calendar/listings",
};
const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_CAP_USD = 50_000_000;
const MAX_RESPONSE_BYTES = 200 * 1024;

interface CalendarRow {
  ticker?: unknown;
  company?: unknown;
  currency?: unknown;
  marketCapUsd?: unknown;
  eventDate?: unknown;
  timeHint?: unknown;
  epsEstimate?: unknown;
  revenueEstimate?: unknown;
  exDate?: unknown;
  payDate?: unknown;
  amount?: unknown;
  exchange?: unknown;
  ipoDate?: unknown;
  source?: unknown;
  fetchedAt?: unknown;
}

const inputSchema = {
  include: z.array(z.enum(TYPES)).min(1).max(3).default([...TYPES])
    .describe("Selected stored calendars: upcoming earnings, upcoming ex-dividend dates, and recent listings (not an upcoming IPO schedule)."),
  days: z.number().int().min(1).max(120).default(14)
    .describe("Forward days for earnings and ex-dividend, inclusive of the API server's current date. A nonblank q makes the backend use 120 days regardless of this value."),
  listingMonths: z.number().int().min(1).max(60).default(12)
    .describe("Trailing months for recent listings. A nonblank q makes the backend search 60 months regardless of this value."),
  q: z.string().trim().max(100).optional()
    .describe("Optional case-insensitive ticker or company-name contains search, also matched with spaces removed. This is not an exact ticker filter. A Yahoo-style symbol whose listing Bullrun stores in another form (BMW.DE as BMW, 7203.T as 7203) is searched under the stored ticker. A nonblank search widens earnings/ex-dividend to 120 days and listings to 60 months. % and _ act as search wildcards."),
  minCapUsd: z.number().finite().min(0).max(1_000_000_000_000_000).optional()
    .describe("Optional minimum market capitalization in USD. Omit to retain API defaults: 50 million for earnings/ex-dividend and zero for listings. Listings with unknown market cap are retained even with a positive floor."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum rows per selected calendar, not an overall result count. A full page may omit other matching events."),
};

function text(value: unknown, max = 160): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function date(value: unknown): string | null {
  const candidate = text(value, 10);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(candidate) ? candidate : null;
}

function event(row: CalendarRow, type: CalendarType): Record<string, unknown> | null {
  const ticker = text(row.ticker, 40);
  const eventDate = date(type === "earnings" ? row.eventDate : type === "ex_dividend" ? row.exDate : row.ipoDate);
  if (!ticker || !eventDate) return null;
  const common = {
    kind: type === "listings" ? "recent_listing" : type,
    ticker,
    company: text(row.company),
    eventDate,
    quoteCurrency: text(row.currency, 12),
    marketCapUsd: number(row.marketCapUsd),
    source: text(row.source, 80),
    sourceFetchedAt: text(row.fetchedAt, 64),
  };
  if (type === "earnings") return {
    ...common,
    timeHint: text(row.timeHint, 40),
    epsEstimate: number(row.epsEstimate),
    revenueEstimate: number(row.revenueEstimate),
    estimateCurrency: null,
  };
  if (type === "ex_dividend") return {
    ...common,
    exDate: eventDate,
    payDate: date(row.payDate),
    amountPerShare: number(row.amount),
    amountCurrency: null,
  };
  return { ...common, firstTradeDate: eventDate, exchange: text(row.exchange, 80), confirmedIpo: null };
}

export function registerGetCorporateCalendar(server: McpServer): void {
  server.registerTool("get_corporate_calendar", {
    title: "Get corporate calendar",
    annotations: { readOnlyHint: true },
    description: "Read stored upcoming earnings and ex-dividend dates, plus recent equity listings. Supports ticker/company search and explicit effective windows, market-cap filters, native listing quote currencies, available source metadata and partial coverage. Recent first-trade dates are not confirmed IPOs or an upcoming IPO schedule. Calendar dates and estimates can change; missing events mean unknown coverage, never proof that no event exists. Read-only; at most three calendar requests, plus a ticker lookup when q carries a Yahoo exchange suffix.",
    inputSchema,
    outputSchema: {
      requestedTypes: z.array(z.enum(TYPES)), retrievedAt: z.string(),
      query: z.record(z.string(), z.unknown()), calendars: z.array(z.record(z.string(), z.unknown())),
      methodology: z.record(z.string(), z.unknown()), warnings: z.array(z.string()),
    },
  }, async args => {
    try {
      requirePublicScope("read:market");
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "get_corporate_calendar requires the \"read:market\" scope." }] };
    }
    try {
      const include = [...new Set<CalendarType>(args.include)];
      const typed = args.q?.trim() || null;
      const warnings: string[] = [];
      // A contains search already finds 6324.T for "6324", but not BMW for "BMW.DE" or 7203
      // for "7203.T". A Yahoo-suffixed symbol the resolver maps to another stored ticker is
      // searched under that ticker; anything else is searched as typed.
      let q = typed;
      if (typed && /^[A-Z0-9][A-Z0-9^=_-]{0,30}\.[A-Z]{1,3}$/i.test(typed)) {
        const resolution = await resolveStockTicker(typed).catch(() => null);
        if (resolution?.ticker && !resolution.ticker.toUpperCase().includes(typed.toUpperCase())) {
          q = resolution.ticker;
          warnings.push(`q "${typed}" was searched as ${resolution.ticker}: ${resolution.note ?? "the stored Bullrun ticker."}`);
        }
      }
      const effectiveDays = q ? 120 : args.days;
      const effectiveListingMonths = q ? 60 : args.listingMonths;
      const timeout = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
        ? Math.min(UPSTREAM_TIMEOUT_MS, config.requestTimeoutMs) : UPSTREAM_TIMEOUT_MS;
      if (q) warnings.push("Search matches ticker/company text, not an exact ticker; the backend widens the forward window to 120 days and recent listings to 60 months. Inspect each calendar's effective window.");
      const calendars = await Promise.all(include.map(async type => {
        const minCapUsd = args.minCapUsd ?? (type === "listings" ? 0 : DEFAULT_MIN_CAP_USD);
        const window = type === "listings"
          ? { direction: "trailing", requestedMonths: args.listingMonths, effectiveMonths: effectiveListingMonths,
            searchWidened: Boolean(q && args.listingMonths !== effectiveListingMonths), anchor: "API server local date" }
          : { direction: "upcoming", requestedDays: args.days, effectiveDays,
            searchWidened: Boolean(q && args.days !== effectiveDays), anchor: "API server local date", bounds: "inclusive" };
        const base = { type, window, minCapUsd, limit: args.limit };
        try {
          const data = await bullrunGet<unknown>(PATHS[type], {
            ...(type === "listings" ? { months: args.listingMonths } : { days: args.days }),
            q, minCapUsd: args.minCapUsd, limit: args.limit,
          }, timeout);
          if (!Array.isArray(data)) throw new Error("Invalid calendar response");
          const rows = data.slice(0, args.limit);
          const events = rows.flatMap(row => {
            if (row == null || typeof row !== "object") return [];
            const item = event(row as CalendarRow, type);
            return item ? [item] : [];
          });
          if (events.length !== rows.length) warnings.push(`${type}: some stored rows lacked a usable ticker/date and were omitted.`);
          if (data.length >= args.limit) warnings.push(`${type}: the response reached the row limit; other matching events may be omitted.`);
          if (!events.length) warnings.push(`${type}: no matching stored events were returned; coverage is unknown, not proof that no events exist.`);
          return { ...base, status: events.length ? "available" : "empty", returnedCount: events.length,
            mayBeTruncated: data.length >= args.limit, events };
        } catch {
          // Never return transport errors, upstream bodies or internal API URLs.
          warnings.push(`${type}: calendar data could not be loaded; retry later.`);
          return { ...base, status: "unavailable", returnedCount: 0, mayBeTruncated: null, events: [] };
        }
      }));
      const usefulData = calendars.some(calendar => calendar.returnedCount > 0);
      if (!usefulData) warnings.unshift("No usable requested calendar events were available. Check the filters, exact listing symbols and stored coverage, or retry unavailable calendars.");
      const payload = {
        requestedTypes: include,
        retrievedAt: new Date().toISOString(),
        query: { q, matching: q ? "case-insensitive contains search over ticker/company, also ignoring spaces; % and _ are wildcards" : null },
        calendars,
        methodology: {
          coverage: "Stored calendar observations, not a complete global event schedule or a real-time feed. Dates and estimates can change. An empty result means no matching stored event in the effective window and filter, not that the company has no event.",
          windows: "Earnings/ex-dividend use the API server's local date through date + effectiveDays, both inclusive. Recent listings use first-trade dates on or after the API server's local date minus effectiveMonths; the backend does not impose a separate upper date bound. Exact server window dates are not returned by the API.",
          currencies: "quoteCurrency is the stock listing's native quote currency, including minor units such as GBX. The API does not identify earnings estimate or dividend-amount currencies, so estimateCurrency/amountCurrency remain unknown; do not assume they equal quoteCurrency. Monetary values are returned without FX conversion or unit rescaling. marketCapUsd is the backend's USD-converted market-cap estimate, not the currency of event amounts.",
          sources: "source/sourceFetchedAt are included only when returned by the API; missing source metadata is unknown. retrievedAt is the MCP retrieval time, not the source refresh time.",
          listings: "The listings calendar contains recent primary listings classified as EQUITY or unclassified, not ETF launches. firstTradeDate comes from the backend's ipoDate (Yahoo first-trade history); it does not confirm an IPO, listing transaction type or future offering. Unknown market caps remain eligible even when minCapUsd is positive.",
          ordering: "Earnings/ex-dividend: earliest date first, then larger USD market cap. Listings: newest first-trade date first, then larger USD market cap. Results are capped separately for each calendar.",
        },
        warnings,
      };
      // MCP returns both text and structured JSON, so budget the serialized
      // result rather than just the event array. Preserve each calendar's
      // ordering and report any additional truncation explicitly.
      let budgetTruncated = false;
      while (Buffer.byteLength(JSON.stringify(toolResult(payload)), "utf8") > MAX_RESPONSE_BYTES) {
        const largest = [...calendars].sort((a, b) => b.events.length - a.events.length)[0];
        if (!largest?.events.length) break;
        largest.events.pop();
        largest.returnedCount = largest.events.length;
        largest.mayBeTruncated = true;
        if (!budgetTruncated) warnings.push("The response size budget omitted some later rows; narrow the search or select fewer calendar types for more detail.");
        budgetTruncated = true;
      }
      const result = toolResult(payload);
      return usefulData ? result : { ...result, isError: true };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "get_corporate_calendar could not prepare calendar data. Check the input and retry." }] };
    }
  });
}
