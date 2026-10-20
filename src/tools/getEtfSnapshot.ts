import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, NOT_REQUESTED, settle } from "./stockIdentity.js";
import {
  etfClassification,
  fractionToPct,
  readExactEtf,
  toolResult,
  type EtfPrice,
  type EtfProfile,
} from "./etfData.js";

const snapshotModule = z.enum([
  "identity",
  "classification",
  "market",
  "fund_data",
  "costs",
  "income",
  "benchmark",
]);
type SnapshotModule = z.infer<typeof snapshotModule>;

const DEFAULT_MODULES: SnapshotModule[] = ["identity", "classification", "market", "costs"];
const PROFILE_MODULES = new Set<SnapshotModule>([
  "identity", "classification", "fund_data", "costs", "income", "benchmark",
]);

const inputSchema = {
  ticker: z.string().min(1)
    .describe("Exact Bullrun ETF listing ticker, including its exchange suffix when present, e.g. SPY, VWRL.L, or EUNL.DE."),
  include: z.array(snapshotModule).min(1).max(7).default(DEFAULT_MODULES)
    .describe("Only these snapshot modules are fetched and returned. Default: identity, classification, market, costs."),
};

const outputSchema = {
  ticker: z.string(),
  found: z.boolean(),
  requestedModules: z.array(snapshotModule),
  availableModules: z.array(snapshotModule),
  missingModules: z.array(snapshotModule),
  modules: z.record(z.string(), z.unknown()),
  asOf: z.record(z.string(), z.unknown()),
  dataQuality: z.record(z.string(), z.unknown()),
};

function hasProfileData(profile: EtfProfile | null, module: SnapshotModule): boolean {
  if (!profile) return false;
  switch (module) {
    case "identity": return [profile.fundName, profile.fundFamily, profile.domicile, profile.inceptionDate].some((v) => v != null);
    case "classification": return [profile.category, profile.assetClass, profile.region].some((v) => v != null);
    case "fund_data": return [profile.nav, profile.totalAssets, profile.holdingsCount].some((v) => v != null);
    case "costs": return profile.expenseRatio != null;
    case "income": return profile.yieldTtm != null || profile.distributionPolicy != null;
    case "benchmark": return profile.benchmark != null;
    default: return false;
  }
}

export function registerGetEtfSnapshot(server: McpServer): void {
  server.registerTool(
    "get_etf_snapshot",
    {
      title: "Get ETF snapshot",
      annotations: { readOnlyHint: true },
      description:
        "Fetch a modular snapshot for one exact ETF listing. The include array controls which of identity, classification, market, fund_data (NAV/AUM), costs, income, and benchmark are fetched and returned. Unrequested modules are omitted; requested-but-unavailable modules are named explicitly. Ratios use percentage points. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const requestedModules = [...new Set(args.include)] as SnapshotModule[];
        const enc = encodeURIComponent(ticker);
        const needsProfile = requestedModules.some((module) => PROFILE_MODULES.has(module));
        const needsMarket = requestedModules.includes("market");

        const [identityRead, profileRead, priceRead] = await Promise.all([
          readExactEtf(ticker),
          needsProfile
            ? settle(bullrunGet<EtfProfile>(`/api/etfs/${enc}/profile`))
            : Promise.resolve(NOT_REQUESTED),
          needsMarket
            ? settle(bullrunGet<EtfPrice[]>(`/api/prices/${enc}`, { limit: 1 }))
            : Promise.resolve(NOT_REQUESTED),
        ]);
        const identity = identityRead.data;
        const profile = profileRead.data;
        const price = priceRead.data?.[0] ?? null;
        const modules: Record<string, unknown> = {};
        const availableModules: SnapshotModule[] = [];
        const missingModules: SnapshotModule[] = [];

        for (const module of requestedModules) {
          let available = false;
          switch (module) {
            case "identity":
              available = identity != null || hasProfileData(profile, module);
              modules.identity = {
                instrumentId: null,
                listingId: null,
                ticker,
                isin: identity?.isin ?? null,
                name: profile?.fundName ?? identity?.company ?? null,
                issuer: profile?.fundFamily ?? null,
                domicile: profile?.domicile ?? identity?.country ?? null,
                inceptionDate: profile?.inceptionDate ?? null,
                website: profile?.website ?? null,
                description: profile?.description
                  ? (profile.description.length > 1200 ? `${profile.description.slice(0, 1200)}...` : profile.description)
                  : null,
                primaryTicker: identity?.primaryTicker ?? null,
                isPrimaryListing: identity ? identity.primaryTicker == null : null,
              };
              break;
            case "classification":
              available = hasProfileData(profile, module) || [identity?.sector, identity?.industry].some((value) => value != null);
              modules.classification = {
                ...etfClassification(profile, identity),
                region: profile?.region ?? null,
              };
              break;
            case "market":
              available = price != null || [identity?.exchange, identity?.currency].some((value) => value != null);
              modules.market = {
                exchange: identity?.exchange ?? null,
                tradingCurrency: identity?.currency ?? null,
                latestPrice: price
                  ? {
                      date: price.tradeDate,
                      close: price.closePrice,
                      open: price.openPrice,
                      high: price.highPrice,
                      low: price.lowPrice,
                      volume: price.volume,
                    }
                  : null,
                bid: null,
                ask: null,
                spreadPct: null,
              };
              break;
            case "fund_data":
              available = hasProfileData(profile, module);
              modules.fund_data = {
                nav: profile?.nav ?? null,
                navCurrency: null,
                aum: profile?.totalAssets ?? null,
                aumCurrency: null,
                holdingsCount: profile?.holdingsCount ?? null,
              };
              break;
            case "costs":
              available = hasProfileData(profile, module);
              modules.costs = {
                expenseRatioPct: fractionToPct(profile?.expenseRatio),
                terPct: null,
              };
              break;
            case "income":
              available = hasProfileData(profile, module);
              modules.income = {
                yieldTtmPct: fractionToPct(profile?.yieldTtm),
                distributionPolicy: profile?.distributionPolicy ?? null,
                distributionFrequency: null,
                latestDistribution: null,
              };
              break;
            case "benchmark":
              available = hasProfileData(profile, module);
              modules.benchmark = {
                name: profile?.benchmark ?? null,
                identifier: null,
                provider: null,
              };
              break;
          }
          (available ? availableModules : missingModules).push(module);
        }

        const found = identity != null || profile != null || price != null;
        // A read that failed (quota, outage) is not evidence that nothing is stored.
        const failure = identityRead.failure ?? profileRead.failure ?? priceRead.failure;
        if (!found && failure) {
          return { isError: true, content: [{ type: "text" as const, text: `get_etf_snapshot: ${failureText(`ETF data for ${ticker}`, failure)}` }] };
        }
        const moduleFailure = (module: SnapshotModule) => module === "market"
          ? priceRead.failure ?? identityRead.failure
          : profileRead.failure ?? (module === "identity" || module === "classification" ? identityRead.failure : null);
        const warnings: Array<Record<string, unknown>> = [];
        if (!found) {
          warnings.push({ code: "not_found", message: `No ETF data found for ticker ${ticker}. Use search_etfs to resolve the exact listing ticker.` });
        }
        for (const module of missingModules) {
          const notLoaded = moduleFailure(module);
          warnings.push(notLoaded
            ? { code: "module_not_loaded", module, message: failureText(`The ${module} data for ${ticker}`, notLoaded) }
            : { code: "module_unavailable", module, message: `No stored ${module} data is available for ${ticker}.` });
        }

        return toolResult({
          ticker,
          found,
          requestedModules,
          availableModules,
          missingModules,
          modules,
          asOf: {
            marketDate: price?.tradeDate ?? null,
            profileSourceUpdatedAt: profile?.sourceUpdatedAt ?? null,
            profileUpdatedAt: profile?.updatedAt ?? null,
          },
          dataQuality: {
            profileSource: profile?.source ?? null,
            units: {
              expenseRatioPct: "percentage_points",
              yieldTtmPct: "percentage_points",
              aum: "reported_currency_units_currency_unavailable",
            },
            warnings,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_etf_snapshot failed: ${msg}` }] };
      }
    },
  );
}
