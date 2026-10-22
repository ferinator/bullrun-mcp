import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import {
  INDICATORS,
  INDICATOR_KEYS,
  canonicalCountry,
  fetchOverview,
  historyCatalog,
  overviewCountries,
  resolveInstrument,
} from "./marketsData.js";

interface HistorySeries {
  code: string;
  title: string | null;
  unit: string | null;
  frequency: string | null;
  points: Array<{ date: string; value: number | null }>;
}

type Point = { date: string; value: number };
const INTERVALS = ["auto", "daily", "weekly", "monthly", "quarterly", "annual"] as const;
type Interval = (typeof INTERVALS)[number];

function bucketKey(date: string, interval: Interval): string {
  const d = new Date(`${date}T00:00:00Z`);
  const y = d.getUTCFullYear();
  switch (interval) {
    case "weekly": {
      // ISO-ish week bucket: the Monday that starts the week.
      const day = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - day * 86_400_000).toISOString().slice(0, 10);
    }
    case "monthly": return date.slice(0, 7);
    case "quarterly": return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "annual": return String(y);
    default: return date;
  }
}

/** Keep the last observation in each bucket (end-of-period value). */
function resample(points: Point[], interval: Interval): Point[] {
  if (interval === "daily" || interval === "auto") return points;
  const out = new Map<string, Point>();
  for (const p of points) out.set(bucketKey(p.date, interval), p);
  return [...out.values()];
}

function pickInterval(points: Point[], maxPoints: number): Interval {
  for (const interval of ["daily", "weekly", "monthly", "quarterly", "annual"] as Interval[]) {
    if (resample(points, interval).length <= maxPoints) return interval;
  }
  return "annual";
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Value at or before `date` (series ascending). */
function valueAtOrBefore(points: Point[], date: string): Point | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: Point | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) { found = points[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

function shiftDate(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const inputSchema = {
  code: z.string().min(1).optional()
    .describe("Exact series code from another tool's historyCode field (e.g. \"CNBC_US10Y\", \"BIS_CBPOL_US\", \"UNEMPLOYMENT:Germany\", \"YAHOO_GSPC\")."),
  instrument: z.string().min(1).optional()
    .describe("Or a market name: an index (\"S&P 500\", \"DAX\", \"Nikkei 225\"), commodity (\"Brent\", \"Gold\"), FX pair (\"EUR/USD\"), central bank (\"Fed\", \"ECB\", \"BoE\"), 10Y yield (\"Germany 10Y\", \"US 10Y\"), or headline series (\"VIX\", \"DXY\", \"2s10s\", \"global inflation\")."),
  indicator: z.enum(INDICATOR_KEYS).optional()
    .describe("Or a per-country macro indicator, together with country (same keys as get_macro_indicators)."),
  country: z.string().optional().describe("Country for indicator, e.g. \"Japan\"."),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date YYYY-MM-DD (inclusive)."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (inclusive)."),
  interval: z.enum(INTERVALS).default("auto")
    .describe("Resample to end-of-period values. auto = the finest interval that fits maxPoints."),
  maxPoints: z.number().int().min(10).max(1000).default(260)
    .describe("Upper bound on returned points (auto interval only; an explicit interval is truncated to the most recent maxPoints)."),
};

export function registerGetMacroHistory(server: McpServer): void {
  server.registerTool(
    "get_macro_history",
    {
      title: "Get macro / market history",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Historical time series behind the Global Markets dashboard, often decades long: equity indices, central-bank policy rates, 10-year government bond yields, FX rates, oil/gas/gold/copper, VIX, DXY, the US 2s10s curve, and per-country macro indicators (GDP growth, inflation, unemployment, house prices, credit gap, debt, confidence, macro stress). Address a series by historyCode (from get_global_markets_overview, get_country_macro or get_macro_indicators), by instrument name (\"Fed\", \"Brent\", \"Germany 10Y\", \"S&P 500\"), or by indicator + country. Returns summary statistics (latest, change over 1M/3M/1Y/5Y, range, where the latest sits in the window) plus resampled points. Use for \"how have rates moved since 2022\", \"plot Brent over 10 years\", \"is German unemployment rising\". Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        let code = args.code?.trim() ?? null;
        if (!code && args.instrument) {
          code = resolveInstrument(args.instrument);
          if (!code) {
            return toolResult({
              found: false,
              message: `Unknown instrument "${args.instrument}". Pass a historyCode from another tool, or one of the names below.`,
              catalog: historyCatalog(),
            });
          }
        }
        if (!code && args.indicator) {
          if (!args.country?.trim()) {
            return { isError: true, content: [{ type: "text", text: "indicator requires country (e.g. indicator=\"unemployment\", country=\"Spain\")." }] };
          }
          const overview = await safe(fetchOverview());
          const country = canonicalCountry(args.country, overview ? overviewCountries(overview) : []);
          code = INDICATORS[args.indicator].historyCode(country);
        }
        if (!code) {
          return { isError: true, content: [{ type: "text", text: "Provide code, instrument, or indicator + country." }] };
        }

        const series = await bullrunGet<HistorySeries>("/api/markets/history", { code });
        const all: Point[] = (series.points ?? [])
          .filter((p): p is Point => p.value != null && Number.isFinite(p.value))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (!all.length) {
          return toolResult({
            found: false,
            code,
            message: `No stored history for "${code}". Series codes come from the historyCode field of get_global_markets_overview, get_country_macro or get_macro_indicators.`,
            catalog: historyCatalog(),
          });
        }

        const windowed = all.filter((p) => (!args.from || p.date >= args.from) && (!args.to || p.date <= args.to));
        if (!windowed.length) {
          return toolResult({
            found: true,
            code,
            title: series.title,
            message: `No observations between ${args.from ?? "start"} and ${args.to ?? "end"}; the series runs ${all[0].date} to ${all[all.length - 1].date}.`,
          });
        }

        const interval = args.interval === "auto" ? pickInterval(windowed, args.maxPoints) : args.interval;
        let points = resample(windowed, interval);
        const truncated = points.length > args.maxPoints;
        if (truncated) points = points.slice(-args.maxPoints);

        const latest = windowed[windowed.length - 1];
        const first = windowed[0];
        let min = windowed[0];
        let max = windowed[0];
        for (const p of windowed) {
          if (p.value < min.value) min = p;
          if (p.value > max.value) max = p;
        }
        const below = windowed.filter((p) => p.value < latest.value).length;
        // Rates, yields and other percent-unit series move in points: a policy rate going
        // from 0.125% to 3.875% is +375bp, and calling it +3000% would mislead.
        const isRate = /percent|%/i.test(series.unit ?? "");
        const changes: Record<string, unknown> = {};
        for (const [label, months] of [["1M", 1], ["3M", 3], ["1Y", 12], ["5Y", 60]] as const) {
          const past = valueAtOrBefore(all, shiftDate(latest.date, months));
          // A monthly or annual series has no distinct observation a month back; skip
          // rather than report a zero change against the latest point itself.
          if (!past || past.date === latest.date) continue;
          const change = latest.value - past.value;
          changes[label] = {
            from: past.date,
            fromValue: past.value,
            change: round(change),
            ...(isRate
              ? { changeBps: round(change * 100, 1) }
              : { changePct: past.value !== 0 ? round((change / Math.abs(past.value)) * 100, 2) : null }),
          };
        }

        return toolResult({
          found: true,
          code,
          title: series.title,
          unit: series.unit,
          sourceFrequency: series.frequency,
          coverage: { seriesStart: all[0].date, seriesEnd: all[all.length - 1].date, observations: all.length },
          window: { from: first.date, to: latest.date, observations: windowed.length },
          summary: {
            latest: { date: latest.date, value: latest.value },
            changeOverWindow: round(latest.value - first.value),
            changes,
            min: { date: min.date, value: min.value },
            max: { date: max.date, value: max.value },
            latestPercentileInWindow: round((below / windowed.length) * 100, 1),
            ...(isRate ? { note: "Percent-unit series: change is in percentage points, changeBps in basis points." } : {}),
          },
          interval: interval === "daily" && args.interval === "auto" ? `as stored (${series.frequency ?? "native"})` : interval,
          returnedPoints: points.length,
          truncatedToMostRecent: truncated,
          points: points.map((p) => [p.date, p.value]),
          pointFormat: "[date, value], end-of-period values, oldest first",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_macro_history failed: ${msg}` }] };
      }
    },
  );
}
