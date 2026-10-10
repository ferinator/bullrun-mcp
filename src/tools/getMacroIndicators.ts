import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requirePublicScope } from "../auth/scopes.js";
import { toolResult } from "./etfData.js";
import {
  INDICATORS,
  INDICATOR_KEYS,
  canonicalCountry,
  fetchOverview,
  overviewCountries,
  type CountryValue,
} from "./marketsData.js";

const inputSchema = {
  indicator: z.enum(INDICATOR_KEYS)
    .describe("Which cross-country indicator: gdp_growth (annual), gdp_growth_quarterly, inflation, government_debt, unemployment, youth_unemployment, real_house_prices, house_price_to_income, house_price_to_rent, credit_gap, household_debt_service, household_credit, business_confidence, consumer_confidence, macro_stress (Bullrun composite)."),
  countries: z.array(z.string().min(1)).max(60).optional()
    .describe("Only these countries (e.g. [\"Germany\",\"France\",\"Italy\"]); aliases like US/UK understood. Omit for every covered country."),
  order: z.enum(["desc", "asc"]).default("desc")
    .describe("desc = highest value first, asc = lowest first."),
  limit: z.number().int().min(1).max(250).default(25),
};

export function registerGetMacroIndicators(server: McpServer): void {
  server.registerTool(
    "get_macro_indicators",
    {
      title: "Rank countries by macro indicator",
      annotations: { readOnlyHint: true },
      description:
        "Cross-country macro comparison from Bullrun's Global Markets warehouse: rank up to ~200 countries on one indicator (GDP growth annual or quarterly, CPI inflation, government debt/GDP, unemployment, youth unemployment, real house-price growth, house price-to-income and price-to-rent vs history, BIS credit-to-GDP gap, household debt service, household credit/GDP, business and consumer confidence, or Bullrun's macro stress score), or compare a named set of countries. Every row has value, period, source and a historyCode for get_macro_history. Use for \"fastest growing economies\", \"highest inflation in Europe\", \"most indebted G7 government\", \"where is housing most overvalued\", \"compare unemployment in Spain, Italy and Greece\". Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const spec = INDICATORS[args.indicator];
        const overview = await fetchOverview();
        const rows = ((overview[spec.mapKey] as CountryValue[] | undefined) ?? [])
          .filter((r) => r.growthPct != null && Number.isFinite(r.growthPct));
        const warnings: string[] = [];

        let selected = rows;
        if (args.countries?.length) {
          const known = overviewCountries(overview);
          const wanted = args.countries.map((c) => canonicalCountry(c, known));
          const byName = new Map(rows.map((r) => [r.country, r]));
          selected = wanted.map((c) => byName.get(c)).filter((r): r is CountryValue => r != null);
          const missing = wanted.filter((c) => !byName.has(c));
          if (missing.length) warnings.push(`No ${args.indicator} reading for: ${missing.join(", ")}.`);
        }

        const sign = args.order === "desc" ? -1 : 1;
        const sorted = [...selected].sort((a, b) => sign * ((a.growthPct as number) - (b.growthPct as number)));
        const values = rows.map((r) => r.growthPct as number).sort((a, b) => a - b);
        const median = values.length ? values[Math.floor(values.length / 2)] : null;

        const periods = new Set(selected.map((r) => r.period).filter(Boolean));
        if (periods.size > 1) warnings.push("Periods differ between countries; compare each row's period before reading a gap as a difference.");

        return toolResult({
          indicator: args.indicator,
          label: spec.label,
          unit: spec.unit,
          higherIs: spec.higherIs,
          note: spec.note ?? null,
          ...(args.indicator === "gdp_growth" && overview.gdpYear ? { referenceYear: overview.gdpYear } : {}),
          ...(args.indicator === "gdp_growth_quarterly" && overview.gdpQuarter ? { referenceQuarter: overview.gdpQuarter } : {}),
          countriesCovered: rows.length,
          universeMedian: median,
          order: args.order,
          returned: Math.min(sorted.length, args.limit),
          rows: sorted.slice(0, args.limit).map((r, i) => ({
            rank: i + 1,
            country: r.country,
            value: Math.round((r.growthPct as number) * 100) / 100,
            period: r.period,
            source: r.source,
            historyCode: spec.historyCode(r.country),
          })),
          asOf: overview.asOf,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_macro_indicators failed: ${msg}` }] };
      }
    },
  );
}
