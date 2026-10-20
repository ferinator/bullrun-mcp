import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, NOT_REQUESTED, safe, settle } from "./stockIdentity.js";
import { anchoredWindow, calculatePriceRisk, pricesAscending, roundMetric } from "./etfAnalytics.js";
import { calculateEtfOverlap } from "./etfOverlap.js";
import {
  etfClassification,
  findExactEtf,
  fractionToPct,
  toolResult,
  type EtfHolding,
  type EtfPrice,
  type EtfProfile,
} from "./etfData.js";

const comparisonModule = z.enum([
  "classification", "market", "fund_data", "costs", "income", "benchmark", "performance", "risk", "holdings", "overlap",
]);

const inputSchema = {
  tickers: z.array(z.string().min(1)).min(2).max(10)
    .describe("Two to ten exact Bullrun ETF listing tickers."),
  include: z.array(comparisonModule).min(1).max(10)
    .default(["classification", "market", "fund_data", "costs", "income", "benchmark"])
    .describe("Selected comparison modules. overlap is opt-in and returns pairwise shared holdings and weighted overlap from each fund's latest stored snapshot."),
  performanceDays: z.number().int().min(30).max(1825).default(365)
    .describe("Window in calendar days back from each fund's newest close; the start is the last close on or before that day. 365 matches the fund page and the screener's 1-year return."),
  topSharedLimit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum shared holdings per ETF pair when overlap is requested; does not limit the snapshots used in overlap calculations."),
};

const outputSchema = {
  tickers: z.array(z.string()),
  requestedModules: z.array(comparisonModule),
  rows: z.array(z.record(z.string(), z.unknown())),
  leaders: z.record(z.string(), z.unknown()),
  coverage: z.array(z.record(z.string(), z.unknown())),
  overlap: z.object({
    methodology: z.record(z.string(), z.unknown()),
    coverage: z.array(z.record(z.string(), z.unknown())),
    pairs: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).optional(),
  warnings: z.array(z.string()),
};

function leader(
  rows: Array<Record<string, unknown>>,
  field: string,
  direction: "min" | "max",
): Record<string, unknown> | null {
  const usable = rows.filter((row) => typeof row[field] === "number");
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => direction === "min"
    ? Number(a[field]) - Number(b[field])
    : Number(b[field]) - Number(a[field]));
  return { ticker: sorted[0].ticker, value: sorted[0][field], field };
}

export function registerCompareEtfs(server: McpServer): void {
  server.registerTool(
    "compare_etfs",
    {
      title: "Compare ETFs",
      annotations: { readOnlyHint: true },
      description:
        "Return a normalized side-by-side comparison of two to ten ETFs across selected classification, market, fund-data, cost, income, benchmark, price-performance, price-risk, holdings, and optional overlap modules. Include overlap to measure pairwise shared securities and weighted overlap from latest stored holdings, matched by security identity rather than ticker alone; cash, currency and derivatives are excluded. Missing holdings make overlap unavailable, while partial holdings make it a lower bound. Only requested modules run; overlap alone fetches no price history. Leaders are mechanical extrema, not recommendations. Currency, holdings dates and coverage caveats are explicit. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const tickers = [...new Set(args.tickers.map((ticker) => ticker.trim().toUpperCase()))];
        if (tickers.length < 2) throw new Error("At least two distinct ETF tickers are required.");
        const include = [...new Set(args.include)];
        const needsPrices = include.some((module) => ["market", "performance", "risk"].includes(module));
        const needsOverlap = include.includes("overlap");
        const needsHoldings = include.includes("holdings") || needsOverlap;
        // Enough bars to reach the window's anchor even across holidays (weekday bars ~0.71/day).
        const limit = Math.min(1400, Math.max(2, Math.ceil((args.performanceDays + 45) * 0.75) + 15));

        const bundles = await Promise.all(tickers.map(async (ticker) => {
          const enc = encodeURIComponent(ticker);
          const [identity, profile, priceResult, holdingResult] = await Promise.all([
            findExactEtf(ticker),
            safe(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`)),
            needsPrices ? safe(bullrunGet<EtfPrice[]>(`/api/prices/${enc}`, { limit })) : Promise.resolve(null),
            needsHoldings ? settle(bullrunGet<EtfHolding[]>(`/api/etfs/${enc}/holdings`)) : Promise.resolve(NOT_REQUESTED),
          ]);
          const window = anchoredWindow(pricesAscending(priceResult), args.performanceDays);
          return { ticker, identity, profile, prices: window.rows, windowComplete: window.complete,
            holdings: holdingResult.data ?? [], holdingsFailure: holdingResult.failure };
        }));

        const unresolved = bundles
          .filter(({ identity, profile, prices, holdings }) => identity == null && profile == null && prices.length === 0 && holdings.length === 0)
          .map(({ ticker }) => ticker);
        const rows = bundles.map(({ ticker, identity, profile, prices, windowComplete, holdings }) => {
          const row: Record<string, unknown> = {
            ticker,
            found: !unresolved.includes(ticker),
            name: profile?.fundName ?? identity?.company ?? null,
          };
          if (include.includes("classification")) Object.assign(row, {
            ...etfClassification(profile, identity),
            region: profile?.region ?? null,
            domicile: profile?.domicile ?? identity?.country ?? null,
          });
          if (include.includes("market")) Object.assign(row, {
            exchange: identity?.exchange ?? null,
            tradingCurrency: identity?.currency ?? null,
            latestPrice: prices.at(-1)?.closePrice ?? null,
            latestPriceDate: prices.at(-1)?.tradeDate ?? null,
          });
          if (include.includes("fund_data")) Object.assign(row, {
            nav: profile?.nav ?? null,
            aum: profile?.totalAssets ?? null,
            aumCurrency: null,
          });
          if (include.includes("costs")) row.expenseRatioPct = fractionToPct(profile?.expenseRatio);
          if (include.includes("income")) Object.assign(row, {
            yieldTtmPct: fractionToPct(profile?.yieldTtm),
            distributionPolicy: profile?.distributionPolicy ?? null,
          });
          if (include.includes("benchmark")) row.benchmark = profile?.benchmark ?? null;
          if (include.includes("performance") || include.includes("risk")) {
            const metrics = calculatePriceRisk(prices);
            if (include.includes("performance")) Object.assign(row, {
              priceReturnPct: roundMetric(metrics.priceReturnPct, 4),
              annualizedPriceReturnPct: roundMetric(metrics.annualizedReturnPct, 4),
              performanceStartDate: metrics.startDate,
              performanceEndDate: metrics.endDate,
              performanceCurrency: identity?.currency ?? null,
              performanceWindowComplete: windowComplete,
            });
            if (include.includes("risk")) Object.assign(row, {
              volatilityAnnualizedPct: metrics.volatilityAnnualizedPct,
              maxDrawdownPct: metrics.maxDrawdownPct,
              sharpeRatio: metrics.sharpeRatio,
              riskObservations: metrics.observations,
            });
          }
          if (include.includes("holdings")) {
            const coveredWeight = holdings.reduce((sum, holding) => sum + (holding.weightPct ?? 0), 0);
            const reported = profile?.holdingsCount ?? null;
            Object.assign(row, {
              storedHoldings: holdings.length,
              reportedHoldingsCount: reported,
              holdingsCoveredWeightPct: roundMetric(coveredWeight),
              holdingsComplete: reported == null ? null : holdings.length >= reported && coveredWeight >= 98,
            });
          }
          return row;
        });

        const coverage = bundles.map(({ ticker, identity, profile, prices, holdings }) => ({
          ticker,
          identityAvailable: identity != null,
          profileAvailable: profile != null,
          priceRows: prices.length,
          holdingRows: holdings.length,
          sourceUpdatedAt: profile?.sourceUpdatedAt ?? null,
        }));
        const warnings = [
          "Performance and risk use close-price returns, not distribution-adjusted total returns.",
        ];
        if (unresolved.length) {
          warnings.unshift(`${unresolved.join(", ")} did not match any Bullrun ETF listing (found=false; its fields are empty, not zero). Check the ticker with search_etfs.`);
        }
        if (include.includes("performance") && rows.some((row) => row.found && row.performanceWindowComplete === false)) {
          warnings.push(`At least one fund has less than ${args.performanceDays} days of price history (performanceWindowComplete=false); its return covers a shorter window and is not comparable.`);
        }
        if (include.includes("performance") && new Set(rows.filter((row) => row.found).map((row) => row.performanceCurrency)).size > 1) {
          warnings.push("The funds trade in different currencies; their price returns include each currency's move and are not FX-adjusted.");
        }
        if (include.includes("fund_data")) warnings.push("AUM and NAV currencies are not stored; cross-currency comparisons are not normalized.");
        if (include.includes("holdings") && rows.some((row) => row.holdingsComplete !== true)) warnings.push("At least one ETF has partial or unknown holdings coverage.");
        // With overlap requested its own warnings name the failed reads.
        const failedHoldings = bundles.filter((bundle) => bundle.holdingsFailure);
        if (include.includes("holdings") && !needsOverlap && failedHoldings.length) {
          warnings.push(failureText(`Holdings for ${failedHoldings.map((bundle) => bundle.ticker).join(", ")}`, failedHoldings[0].holdingsFailure!));
        }
        const overlap = needsOverlap ? calculateEtfOverlap(bundles, args.topSharedLimit) : undefined;
        if (overlap) warnings.push(...overlap.warnings);

        return toolResult({
          tickers,
          requestedModules: include,
          rows,
          leaders: {
            lowestExpenseRatio: leader(rows, "expenseRatioPct", "min"),
            highestAum: leader(rows, "aum", "max"),
            highestYield: leader(rows, "yieldTtmPct", "max"),
            highestPriceReturn: leader(rows, "priceReturnPct", "max"),
            lowestVolatility: leader(rows, "volatilityAnnualizedPct", "min"),
          },
          coverage,
          ...(overlap ? { overlap } : {}),
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `compare_etfs failed: ${msg}` }] };
      }
    },
  );
}
