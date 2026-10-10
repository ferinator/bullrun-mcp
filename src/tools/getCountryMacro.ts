import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { safe } from "./stockIdentity.js";
import { toolResult } from "./etfData.js";
import { canonicalCountry, fetchOverview, overviewCountries } from "./marketsData.js";

interface CountryIndicator {
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  period: string | null;
  source: string | null;
  frequency: string | null;
  stale: boolean;
  stress: number | null;
  basis: string | null;
  percentile: number | null;
  observations: number | null;
  histCode: string | null;
}

interface CountryDetail {
  country: string;
  score: { value: number | null; band: string | null; pillarsCovered: number; pillarsTotal: number; pillarsRequired: number; state: string };
  pillars: Array<{ key: string; label: string; score: number | null; band: string | null; inputs: number; inputsHeld: number; indicators: CountryIndicator[] }>;
  newestInput: string | null;
  oldestInput: string | null;
  indicatorsHeld: number;
  indicatorsScored: number;
}

const inputSchema = {
  country: z.string().min(1)
    .describe("Country name, e.g. \"Germany\", \"United States\" (aliases like US, UK, Korea, Eurozone are understood). Also \"Euro Area\"."),
};

export function registerGetCountryMacro(server: McpServer): void {
  server.registerTool(
    "get_country_macro",
    {
      title: "Get country macro profile",
      annotations: { readOnlyHint: true },
      description:
        "One country's macro dashboard from Bullrun's Global Markets warehouse: a 0-100 macro stress score (higher = more stress) built from six pillars - labour (unemployment, its change, youth unemployment), housing (real house prices, price-to-income and price-to-rent vs history), credit (BIS credit-to-GDP gap, household debt service, household credit), fiscal (government debt, fiscal balance), external (current account) and cycle (GDP growth, inflation) - with every input's latest value, period, source (OECD, IMF, BIS, World Bank, Eurostat), its stress contribution and a historyCode for get_macro_history. Use for \"how is the German economy doing\", \"is there a housing bubble in Canada\", \"macro risks in Italy\", or to judge the backdrop for a country's stocks. A thinly covered country returns state \"insufficient\", never a falsely calm score. Read-only.",
      inputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const overview = await safe(fetchOverview());
        const known = overview ? overviewCountries(overview) : [];
        const country = canonicalCountry(args.country, known);
        const detail = await bullrunGet<CountryDetail>("/api/markets/country", { name: country });

        const warnings: string[] = [];
        if (detail.score?.state !== "scored") {
          warnings.push(
            `Not enough indicators to score ${detail.country} (${detail.score?.pillarsCovered ?? 0} of ${detail.score?.pillarsRequired ?? 4} required pillars). Treat this as unmeasured, not calm.`,
          );
          if (known.length && !known.includes(country)) {
            const q = args.country.trim().toLowerCase();
            const close = known.filter((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase())).slice(0, 8);
            warnings.push(close.length
              ? `"${args.country}" is not a country name the warehouse uses. Close matches: ${close.join(", ")}.`
              : `"${args.country}" is not a country name the warehouse uses.`);
          }
        }
        const stale = detail.pillars.flatMap((p) => p.indicators.filter((i) => i.stale).map((i) => i.label));
        if (stale.length) warnings.push(`Stale inputs (old relative to their release cadence): ${stale.join(", ")}.`);

        return toolResult({
          country: detail.country,
          stress: {
            score: detail.score?.value ?? null,
            band: detail.score?.band ?? null,
            state: detail.score?.state ?? null,
            pillarsCovered: detail.score?.pillarsCovered ?? 0,
            pillarsTotal: detail.score?.pillarsTotal ?? 6,
            scale: "0-100, higher = more macro stress; bands calm (<30), watch (30-44), elevated (45-59), stretched (60+)",
          },
          pillars: detail.pillars.map((p) => ({
            pillar: p.label,
            score: p.score,
            band: p.band,
            inputsHeld: `${p.inputsHeld}/${p.inputs}`,
            indicators: p.indicators.map((i) => ({
              indicator: i.label,
              value: i.value,
              unit: i.unit,
              period: i.period,
              source: i.source,
              frequency: i.frequency,
              stale: i.stale,
              stressScore: i.stress,
              scoredHow: i.basis,
              ...(i.percentile != null ? { percentileInOwnHistory: i.percentile, observations: i.observations } : {}),
              historyCode: i.histCode,
            })),
          })),
          freshness: { newestInput: detail.newestInput, oldestInput: detail.oldestInput },
          coverage: { indicatorsHeld: detail.indicatorsHeld, indicatorsScored: detail.indicatorsScored },
          warnings,
          webPage: "https://bull-run.org/markets",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `get_country_macro failed: ${msg}` }] };
      }
    },
  );
}
