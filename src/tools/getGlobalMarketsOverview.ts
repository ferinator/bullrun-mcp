import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import {
  fetchOverview,
  historyCodeForCentralBank,
  historyCodeForCommodity,
  historyCodeForCurrency,
  historyCodeForIndex,
  historyCodeForMetric,
  type NewsItem,
} from "./marketsData.js";

const SECTIONS = [
  "headline", "indices", "rates", "yields", "currencies", "commodities", "calendar", "news", "us_housing",
] as const;
type Section = (typeof SECTIONS)[number];
const DEFAULT_SECTIONS: Section[] = ["headline", "indices", "rates", "yields", "currencies", "commodities", "calendar"];

interface LiveQuote { symbol: string; name: string; price: number | null; changePct: number | null; asOf: string | null }

/** The 7-point sparkline is the last seven daily closes; report its range rather than the raw array. */
function trendSummary(trend: number[] | undefined): Record<string, number> | null {
  const t = (trend ?? []).filter((v) => Number.isFinite(v));
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  return {
    points: t.length,
    first,
    min: Math.min(...t),
    max: Math.max(...t),
    changePctOverTrend: first !== 0 ? Math.round(((last - first) / Math.abs(first)) * 10000) / 100 : 0,
  };
}

const inputSchema = {
  sections: z.array(z.enum(SECTIONS)).min(1).optional()
    .describe("Sections to return. headline = global GDP/inflation/debt, oil, gold, DXY, US 10Y, 2s10s curve, VIX, EUR/USD, Bitcoin, policy-rate average, OECD unemployment, US jobless claims; indices = 19 world equity indices (live intraday level when a market is open); rates = six major central-bank policy rates + upcoming rate decisions; yields = 16 sovereign 10Y yields; currencies = 20 FX pairs; commodities = Brent, WTI, natural gas, gold, copper; calendar = upcoming high-impact economic releases; news = market headlines; us_housing = US housing-market balance (months' supply, inventory, price cuts). Default: everything except news and us_housing."),
  newsLimit: z.number().int().min(1).max(50).default(8)
    .describe("Headlines to return when the news section is requested."),
};

/**
 * Where a row's numbers come from and how fresh that source can be, from its history
 * code. FX and oil/gas rows take whichever of the FRED series and its daily Yahoo twin
 * has the newer observation (datacrawler-macro's catalog fallback_series).
 */
function seriesCadence(historyCode: string | null | undefined): string | null {
  if (!historyCode) return null;
  if (historyCode.startsWith("YAHOO_")) return "Yahoo, daily";
  if (/^DEX/.test(historyCode)) return "FRED H.10 (weekly release) or Yahoo daily, whichever is newer";
  if (/^DCOIL|^DHHNG/.test(historyCode)) return "FRED/EIA (a few days' lag) or Yahoo futures daily, whichever is newer";
  return null;
}

export function registerGetGlobalMarketsOverview(server: McpServer): void {
  server.registerTool(
    "get_global_markets_overview",
    {
      title: "Get global markets overview",
      annotations: { readOnlyHint: true },
      description:
        "Bullrun's Global Markets dashboard in one call: world equity indices (S&P 500, Nasdaq-100, MSCI World, DAX, FTSE 100, Nikkei, Hang Seng, Nifty...), central-bank policy rates and next rate decisions (Fed, ECB, BoE, BoJ, SNB, BoC), 16 sovereign 10-year yields, 20 FX pairs, oil/gas/gold/copper, headline macro tiles (global GDP growth, inflation, debt/GDP, VIX, DXY, 2s10s curve, US jobless claims), the upcoming economic calendar, market news and the US housing balance. Each row carries a historyCode for get_macro_history. Use for \"how are markets doing today\", \"what's the macro backdrop\", \"where are rates/yields\", \"what's on the calendar this week\" or a morning briefing. Daily closes, with live intraday index levels while markets are open. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const sections = new Set<Section>(args.sections?.length ? args.sections : DEFAULT_SECTIONS);
        const wantsMoreNews = sections.has("news") && args.newsLimit > 8;
        const [overview, quotes, moreNews] = await Promise.all([
          fetchOverview(),
          sections.has("indices") ? safe(bullrunGet<LiveQuote[]>("/api/markets/quotes")) : Promise.resolve(null),
          wantsMoreNews ? safe(bullrunGet<NewsItem[]>("/api/markets/news", { limit: args.newsLimit })) : Promise.resolve(null),
        ]);
        const out: Record<string, unknown> = {};
        const warnings: string[] = [];

        if (sections.has("headline")) {
          out.headline = (overview.metrics ?? []).map((m) => ({
            key: m.key,
            label: m.label,
            value: m.value,
            changePct: m.changePct,
            change: m.changeLabel,
            context: m.sub,
            tone: m.tone,
            historyCode: historyCodeForMetric(m.key),
          }));
        }

        if (sections.has("indices")) {
          const live = new Map((quotes ?? []).map((q) => [q.name, q]));
          out.indices = (overview.indices ?? []).map((i) => {
            const q = live.get(i.name);
            return {
              name: i.name,
              region: i.region,
              currency: i.currency,
              level: q?.price ?? i.price,
              changePct: q?.changePct ?? i.changePct,
              basis: q ? `live intraday (${q.asOf ?? "now"})` : "last daily close",
              ...(i.proxy ? { proxy: true, proxyNote: "Level is an ETF proxy for the index, not the index points." } : {}),
              last7Closes: trendSummary(i.trend),
              historyCode: historyCodeForIndex(i.name),
            };
          });
          if ((overview.indices ?? []).some((i) => i.proxy)) {
            warnings.push("Indices marked proxy are tracked via a listed ETF, so their level is the ETF price, not index points; percentage changes are comparable.");
          }
        }

        if (sections.has("rates")) {
          out.rates = {
            centralBanks: (overview.centralBanks ?? []).map((b) => ({
              bank: b.bank,
              code: b.code,
              policyRatePct: b.ratePct,
              lastChangeBps: b.changeBps,
              historyCode: historyCodeForCentralBank(b.code),
            })),
            upcomingDecisions: overview.rateDecisions ?? [],
          };
        }

        if (sections.has("yields")) {
          out.yields = (overview.yields ?? []).map((y) => ({
            name: y.name,
            yieldPct: y.yieldPct,
            changeBps: y.changeBps,
            asOf: y.asOf,
            ...(y.spreadBps != null ? { spreadBps: y.spreadBps, spreadAnchor: y.anchor } : {}),
            historyCode: y.seriesCode,
          }));
        }

        if (sections.has("currencies")) {
          out.currencies = (overview.currencies ?? []).map((c) => {
            const historyCode = historyCodeForCurrency(c.pair);
            return { pair: c.pair, rate: c.price, changePct: c.changePct, historyCode, source: seriesCadence(historyCode) };
          });
        }

        if (sections.has("commodities")) {
          out.commodities = (overview.commodities ?? []).map((c) => {
            const historyCode = historyCodeForCommodity(c.name);
            return {
              name: c.name, price: c.price, changePct: c.changePct, last7Closes: trendSummary(c.trend),
              historyCode, source: seriesCadence(historyCode),
            };
          });
        }
        if ((sections.has("currencies") || sections.has("commodities") || sections.has("headline"))
            && [...((out.currencies as Array<{ source: string | null }> | undefined) ?? []),
              ...((out.commodities as Array<{ source: string | null }> | undefined) ?? [])]
              .some((row) => row.source?.endsWith("whichever is newer"))) {
          warnings.push("Rows whose source says \"whichever is newer\" show the fresher of a FRED series and its daily Yahoo twin. For FX and natural gas the historyCode is the FRED series, so get_macro_history can end before the row's value (H.10 FX is a weekly release); oil history follows the fresher source. The DXY tile is ICE's dollar index from Yahoo, daily; the headline context field gives each tile's latest observation dates.");
        }

        if (sections.has("calendar")) {
          out.calendar = overview.calendar ?? [];
        }

        if (sections.has("news")) {
          const items = (moreNews && moreNews.length ? moreNews : overview.news ?? []).slice(0, args.newsLimit);
          out.news = items.map((n) => ({ headline: n.headline, source: n.source, minutesAgo: n.minutesAgo, url: n.url }));
        }

        if (sections.has("us_housing")) {
          const h = overview.usHousing;
          out.usHousing = h
            ? {
                asOf: h.asOf,
                tilt: h.tilt,
                headline: h.headline,
                headlineNote: h.headlineNote,
                indicators: (h.rows ?? []).map((r) => ({
                  label: r.label, value: r.value, basis: r.basis, delta: r.delta, deltaUnit: r.deltaUnit,
                  tilt: r.tilt, period: r.period, historyCode: r.seriesCode,
                })),
              }
            : null;
        }

        return toolResult({
          asOf: overview.asOf,
          sections: [...sections],
          ...out,
          warnings,
          webPage: "https://bull-run.org/markets",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_global_markets_overview failed: ${msg}` }] };
      }
    },
  );
}
