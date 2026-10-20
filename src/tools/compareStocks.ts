import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet, config } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { mapWithConcurrency, toolResult } from "./etfData.js";
import { RISK_METHOD_NOTE, round, type RiskDialCluster } from "./riskData.js";
import { interpretScore, VALUATION_CAVEAT, type MlScore, type ModelKey } from "./valuationModelData.js";
import {
  failureText,
  readFailure,
  resolveStockTicker,
  TICKER_CONVENTION,
  tickerNotFoundText,
  tidy,
  type ReadFailure,
  type Stock,
  type TickerResolution,
} from "./stockIdentity.js";
import { clipText } from "./textClip.js";

const MODULES = ["fundamentals", "quality", "valuation", "risk"] as const;
type Module = (typeof MODULES)[number];
const VALUATION_KEYS: ModelKey[] = ["valuation", "valuation_annual_1y", "valuation_ps", "valuation_ps_annual_1y"];
// Thirty reads at most, in five waves of six. Each read has a six-second deadline,
// keeping the entire tool below the marketplace's 44-second response limit.
const CONCURRENCY = 6;
const UPSTREAM_TIMEOUT_MS = 6_000;

interface Financials {
  ticker: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceCurrency: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  pretaxIncome: number | null;
  taxProvision: number | null;
  netIncome: number | null;
  dilutedEps: number | null;
  freeCashflow: number | null;
  operatingCashflow: number | null;
  totalDebt: number | null;
  cashAndCashEquivalents: number | null;
  totalAssets: number | null;
  stockholdersEquity: number | null;
}

interface Valuation {
  ticker: string;
  tradeDate: string | null;
  marketCap: number | null;
  peRatio: number | null;
  dividendYield: number | null;
}

interface Price { ticker: string; tradeDate: string | null; closePrice: number | null }
interface ModelSummary { results: Partial<Record<ModelKey, MlScore>> }
interface RiskPreview { dials: RiskDialCluster | null }
type Source = "identity" | "financials" | "price" | "valuation" | "models" | "risk";
type ReadResult = { status: "ok"; data: unknown } | { status: "unavailable"; data: null };
interface ReadTask { ticker: string; source: Source; path: string; params?: Record<string, string | number | boolean> }

const inputSchema = {
  tickers: z.array(z.string().trim().min(1).max(40)).min(2).max(5)
    .describe("Two to five distinct Bullrun stock tickers, e.g. AAPL, BMW, NESN, 6324.T or 7203. " + TICKER_CONVENTION + " Company names are not accepted here."),
  include: z.array(z.enum(MODULES)).min(1).max(4).default([...MODULES])
    .describe("Selected compact modules. Fundamentals and quality use the latest usable ANNUAL fiscal year only; valuation includes stored multiples and Bullrun model context; risk includes measured dials."),
};

function value(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function rounded(n: number | null, digits = 2): number | null {
  return n == null || !Number.isFinite(n) ? null : Number(n.toFixed(digits));
}

function ratio(numerator: number | null | undefined, denominator: number | null | undefined, scale = 1): number | null {
  const n = value(numerator);
  const d = value(denominator);
  return n == null || d == null || d <= 0 ? null : rounded(n / d * scale);
}

function text(s: string | null | undefined, max = 160): string | null {
  return clipText(s, max);
}

function matches(row: { ticker: string } | null | undefined, ticker: string): boolean {
  return typeof row?.ticker === "string" && row.ticker.toUpperCase() === ticker;
}

function annualRows(rows: Financials[] | null, ticker: string): Financials[] {
  // A null quarter is unknown, not proof of an annual reporting period. Avoid
  // empty annual skeletons and never silently substitute a quarterly observation.
  return (Array.isArray(rows) ? rows : []).filter(row => matches(row, ticker)
    && row.fiscalQuarter === 0 && Number.isInteger(row.fiscalYear)
    && [row.revenue, row.operatingIncome, row.netIncome, row.operatingCashflow, row.freeCashflow]
      .some(n => value(n) != null))
    .sort((a, b) => (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0));
}

function financialBasis(row: Financials | null) {
  return row ? {
    period: `FY${row.fiscalYear}`,
    fiscalYear: row.fiscalYear,
    periodType: "annual",
    calendarPeriodEnd: null,
    reportingCurrency: text(row.sourceCurrency, 12),
    amountUnit: "absolute reporting-currency units; EPS in reporting currency per share",
  } : null;
}

function quality(row: Financials) {
  const debt = value(row.totalDebt);
  const equity = value(row.stockholdersEquity);
  const cash = value(row.cashAndCashEquivalents);
  const invested = debt != null && equity != null && cash != null ? debt + equity - cash : null;
  const pretax = value(row.pretaxIncome);
  const tax = value(row.taxProvision);
  const taxRate = pretax != null && pretax > 0 && tax != null && tax >= 0 && tax / pretax <= 0.5
    ? tax / pretax : null;
  const operating = value(row.operatingIncome);
  const nopat = operating != null && taxRate != null ? operating * (1 - taxRate) : null;
  const netIncome = value(row.netIncome);
  const ocf = value(row.operatingCashflow);
  return {
    basis: financialBasis(row),
    grossMarginPct: ratio(row.grossProfit, row.revenue, 100),
    operatingMarginPct: ratio(row.operatingIncome, row.revenue, 100),
    netMarginPct: ratio(netIncome, row.revenue, 100),
    freeCashflowMarginPct: ratio(row.freeCashflow, row.revenue, 100),
    roePct: ratio(netIncome, equity, 100),
    roaPct: ratio(netIncome, row.totalAssets, 100),
    roicPct: ratio(nopat, invested, 100),
    effectiveTaxRatePct: rounded(taxRate == null ? null : taxRate * 100),
    operatingCashflowToNetIncome: ratio(ocf, netIncome),
    accrualsPctOfAssets: ratio(netIncome != null && ocf != null ? netIncome - ocf : null, row.totalAssets, 100),
    debtToEquity: ratio(debt, equity),
  };
}

function summarizeRisk(cluster: RiskDialCluster | null, ticker: string) {
  if (!matches(cluster, ticker)) return null;
  const composite = cluster?.composite;
  return {
    asOfDate: text(cluster?.asOfDate, 40),
    formulaVersion: text(cluster?.formulaVersion, 80),
    // Whole points, as get_company_risk and the analysis page show them.
    composite: composite ? {
      score: value(composite.displayScore) ?? round(value(composite.score), 0), band: text(composite.band, 40), state: text(composite.state, 40),
      direction: text(composite.direction, 40), weightProfile: text(composite.weightProfile, 80),
      inputsAvailable: value(composite.inputsAvailable), inputsRequired: value(composite.inputsRequired),
    } : null,
    compositeAbsentWhy: composite ? null : text(cluster?.compositeAbsentWhy, 400),
    dials: (cluster?.dials ?? []).slice(0, 6).map(dial => ({
      mechanism: text(dial.key, 40), score: round(value(dial.score), 0), band: text(dial.band, 40),
      state: text(dial.state, 40), direction: text(dial.direction, 40), waitingOn: text(dial.waitingOn, 400),
    })),
  };
}

export function registerCompareStocks(server: McpServer): void {
  server.registerTool("compare_stocks", {
    title: "Compare stocks",
    annotations: { readOnlyHint: true },
    description: "Compare two to five stock tickers in one compact structured response: annual fundamentals and growth, quality ratios, stored valuation and Bullrun model context, and measured risk dials. Reports each fiscal year, source date, native quote/reporting currency and missing coverage. No currency conversion, quarterly-to-annual substitution, buy/sell ranking or generated research. Read-only.",
    inputSchema,
    outputSchema: {
      tickers: z.array(z.string()), requestedModules: z.array(z.enum(MODULES)), retrievedAt: z.string(),
      rows: z.array(z.record(z.string(), z.unknown())), coverage: z.array(z.record(z.string(), z.unknown())),
      methodology: z.record(z.string(), z.unknown()), warnings: z.array(z.string()),
    },
  }, async args => {
    try {
      requirePublicScope("read:market");
      const requested = [...new Set(args.tickers.map(ticker => ticker.trim().toUpperCase()))];
      if (requested.length < 2) throw new Error("At least two distinct stock tickers are required.");
      const include = [...new Set<Module>(args.include)];
      const timeout = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
        ? Math.min(UPSTREAM_TIMEOUT_MS, config.requestTimeoutMs) : UPSTREAM_TIMEOUT_MS;
      // The ticker lookup doubles as the identity read. One input at a time: a bare
      // numeric code fans out to four venue lookups of its own.
      const lookups = await mapWithConcurrency(requested, 1, async (input): Promise<{
        input: string; resolution: TickerResolution | null; failure: ReadFailure | null;
      }> => {
        try {
          return { input, resolution: await resolveStockTicker(input), failure: null };
        } catch (err) {
          return { input, resolution: null, failure: readFailure(err) ?? "unavailable" };
        }
      });
      const warnings: string[] = [];
      const tickers: string[] = [];
      const identities = new Map<string, ReadResult>();
      for (const { input, resolution, failure } of lookups) {
        const ticker = resolution?.ticker?.toUpperCase() ?? input;
        if (tickers.includes(ticker)) {
          warnings.push(`${input} is the same listing as ${ticker}; it is compared once.`);
          continue;
        }
        tickers.push(ticker);
        identities.set(ticker, failure ? { status: "unavailable", data: null } : { status: "ok", data: resolution?.stock ?? null });
        if (failure) warnings.push(`${input}: ${failureText("The ticker lookup", failure)}`);
        else if (resolution?.note) warnings.push(resolution.note);
        else if (resolution && !resolution.ticker) warnings.push(tickerNotFoundText(input, resolution));
      }
      if (tickers.length < 2) throw new Error(`These tickers name only one listing (${tickers[0]}); compare at least two different stocks.`);
      const tasks: ReadTask[] = [];
      for (const ticker of tickers) {
        const enc = encodeURIComponent(ticker);
        if (include.includes("fundamentals") || include.includes("quality")) {
          tasks.push({ ticker, source: "financials", path: `/api/financials/${enc}` });
        }
        if (include.includes("fundamentals")) tasks.push({ ticker, source: "price", path: `/api/prices/${enc}`, params: { limit: 1 } });
        if (include.includes("valuation")) tasks.push(
          { ticker, source: "valuation", path: `/api/valuations/${enc}`, params: { limit: 1 } },
          { ticker, source: "models", path: "/api/ml-scores/summary", params: { ticker, includePs: true } },
        );
        if (include.includes("risk")) tasks.push({ ticker, source: "risk", path: `/api/company-intelligence/${enc}/risk-preview` });
      }
      const reads = await mapWithConcurrency(tasks, CONCURRENCY, async (task): Promise<ReadResult> => {
        try {
          return { status: "ok", data: await bullrunGet(task.path, task.params, timeout) };
        } catch {
          // Do not disclose upstream bodies or internal addresses. Coverage makes a
          // failed endpoint distinguishable from a successful empty response.
          return { status: "unavailable", data: null };
        }
      });
      const bundles = new Map(tickers.map(ticker => [ticker, new Map<Source, ReadResult>([["identity", identities.get(ticker)!]])]));
      tasks.forEach((task, index) => bundles.get(task.ticker)!.set(task.source, reads[index]));
      const coverage: Array<Record<string, unknown>> = [];
      const rows = tickers.map(ticker => {
        const sources = bundles.get(ticker)!;
        const data = <T>(source: Source) => sources.get(source)?.data as T | null | undefined;
        const candidate = data<Stock>("identity");
        const stock = matches(candidate, ticker) ? candidate! : null;
        const nonStock = stock?.quoteType != null && stock.quoteType !== "EQUITY";
        const annual = annualRows(data<Financials[]>("financials") ?? null, ticker);
        const latest = annual[0] ?? null;
        const previous = latest ? annual.find(row => row.fiscalYear === latest.fiscalYear! - 1) ?? null : null;
        const reportingCurrency = text(latest?.sourceCurrency, 12);
        const comparableGrowth = previous != null && reportingCurrency != null
          && reportingCurrency === text(previous.sourceCurrency, 12);
        const valuation = (data<Valuation[]>("valuation") ?? []).find(row => matches(row, ticker)) ?? null;
        const price = (data<Price[]>("price") ?? []).find(row => matches(row, ticker)) ?? null;
        const modelRows = data<ModelSummary>("models")?.results ?? {};
        const models = VALUATION_KEYS.filter(key => matches(modelRows[key], ticker)).map(key => {
          const score = modelRows[key]!;
          // Bound provider strings as this summary is returned twice (text + JSON).
          return interpretScore(key, { ...score, predicted: value(score.predicted), percentile: value(score.percentile),
            rank: value(score.rank), asOfDate: text(score.asOfDate, 40), horizonQ: value(score.horizonQ),
            nPeriods: value(score.nPeriods), currentMultiple: value(score.currentMultiple),
            fiscalPeriod: text(score.fiscalPeriod, 80), dataQuality: text(score.dataQuality, 40) });
        });
        const risk = summarizeRisk(data<RiskPreview>("risk")?.dials ?? null, ticker);
        const measuredRisk = risk?.composite?.score != null || risk?.dials.some(dial => dial.score != null) === true;
        const endpoints = Object.fromEntries([...sources].map(([source, result]) => [source, result.status]));
        const unavailable = [...sources].filter(([, result]) => result.status !== "ok").map(([source]) => source);
        if (unavailable.length) warnings.push(`${ticker}: unavailable sources: ${unavailable.join(", ")}.`);
        if (nonStock) warnings.push(`${ticker}: quote type ${text(stock?.quoteType, 40)} is not a stock; use compare_etfs for ETFs.`);
        if (sources.has("financials") && !latest) warnings.push(`${ticker}: no usable annual financials; quarterly rows were not substituted.`);
        if (latest && !reportingCurrency) warnings.push(`${ticker}: reporting currency is unknown; absolute statement amounts cannot be compared across currencies.`);
        if (include.includes("fundamentals") && latest && !comparableGrowth) warnings.push(`${ticker}: annual YoY growth unavailable without the immediately previous fiscal year in the same known reporting currency.`);
        if (include.includes("valuation") && !valuation && !models.length) warnings.push(`${ticker}: no stored valuation or model coverage.`);
        if (models.some(model => model.dataQuality === "partial")) warnings.push(`${ticker}: some valuation models use a partial financial history.`);
        if (include.includes("risk") && !measuredRisk) warnings.push(`${ticker}: risk is unmeasured; missing scores do not mean low risk.`);

        coverage.push({ ticker, identityAvailable: stock != null, quoteType: text(stock?.quoteType, 40),
          annualRows: sources.has("financials") ? annual.length : null, latestFiscalYear: latest?.fiscalYear ?? null,
          priceAvailable: sources.has("price") ? price != null : null,
          valuationAvailable: sources.has("valuation") ? valuation != null : null,
          valuationModels: sources.has("models") ? models.length : null,
          measuredRisk: sources.has("risk") ? measuredRisk : null, endpoints });
        const missingModule = (sources.has("financials") && !latest)
          || (sources.has("price") && !price)
          || (include.includes("valuation") && !valuation && !models.length)
          || (include.includes("risk") && !measuredRisk);
        const row: Record<string, unknown> = {
          ticker, status: nonStock ? "unsupported_instrument" : !stock && !latest && !price && !valuation && !models.length && !measuredRisk ? "unavailable" : unavailable.length || !stock || missingModule ? "partial" : "available",
          identity: stock ? { company: text(stock.company), exchange: text(stock.exchange, 80),
            quoteCurrency: text(stock.currency, 12), sector: text(stock.sector, 80), industry: text(stock.industry),
            country: text(stock.country, 80), primaryTicker: text(stock.primaryTicker, 40) } : null,
        };
        if (include.includes("fundamentals")) row.fundamentals = nonStock ? null : {
          latestPrice: price ? { close: tidy(price.closePrice), asOfDate: text(price.tradeDate, 40), quoteCurrency: text(stock?.currency, 12) } : null,
          annual: latest ? { basis: financialBasis(latest), revenue: value(latest.revenue), netIncome: value(latest.netIncome),
            dilutedEps: tidy(latest.dilutedEps), operatingCashflow: value(latest.operatingCashflow), freeCashflow: value(latest.freeCashflow),
            totalDebt: value(latest.totalDebt), cash: value(latest.cashAndCashEquivalents),
            revenueGrowthYoyPct: comparableGrowth && previous!.revenue != null && previous!.revenue > 0 && value(latest.revenue) != null
              ? rounded((latest.revenue! - previous!.revenue) / previous!.revenue * 100) : null,
            growthPriorFiscalYear: comparableGrowth ? previous!.fiscalYear : null } : null,
        };
        if (include.includes("quality")) row.quality = !nonStock && latest ? quality(latest) : null;
        if (include.includes("valuation")) row.valuation = nonStock ? null : {
          latest: valuation ? { asOfDate: text(valuation.tradeDate, 40), marketCap: value(valuation.marketCap), marketCapCurrency: null,
            peRatio: tidy(valuation.peRatio, 5), dividendYieldPct: tidy(valuation.dividendYield, 5) } : null,
          models,
        };
        if (include.includes("risk")) row.risk = nonStock ? null : risk;
        return row;
      });
      const financialYears = new Set(coverage.map(row => row.latestFiscalYear).filter(year => year != null));
      if (financialYears.size > 1) warnings.push("Latest annual fiscal years differ between companies; inspect each row's basis before comparing.");
      // Identity records alone are not a successful research comparison. Retain
      // coverage on errors so a marketplace client can distinguish no data from
      // a usable partial response without billing a failed research operation.
      const hasNumber = (record: Record<string, unknown> | null | undefined, exclude: string[] = []) =>
        record != null && Object.entries(record).some(([key, n]) => !exclude.includes(key) && typeof n === "number" && Number.isFinite(n));
      const usefulData = rows.some(row => {
        if (row.status === "unsupported_instrument") return false;
        const fundamentals = row.fundamentals as { latestPrice: { close: number | null } | null; annual: Record<string, unknown> | null } | undefined;
        const valuation = row.valuation as { latest: Record<string, unknown> | null; models: Array<Record<string, unknown>> } | undefined;
        const risk = row.risk as ReturnType<typeof summarizeRisk> | undefined;
        return fundamentals?.latestPrice?.close != null || hasNumber(fundamentals?.annual, ["growthPriorFiscalYear"])
          || hasNumber(row.quality as Record<string, unknown> | null | undefined)
          || hasNumber(valuation?.latest)
          || valuation?.models.some(model => ["valuationGapPct", "currentPe", "modelTypicalPe", "percentile", "rank"].some(key => value(model[key] as number | null) != null))
          || risk?.composite?.score != null || risk?.dials.some(dial => dial.score != null) === true;
      });
      if (!usefulData) warnings.unshift("No useful requested stock metrics were available for this comparison. Verify the exact listing tickers or retry unavailable sources.");
      const result = toolResult({
        tickers, requestedModules: include, retrievedAt: new Date().toISOString(), rows, coverage,
        methodology: {
          currencies: "No FX conversion. Quote currencies are native listing price units (including minor-unit currencies such as GBX). Statement amounts use the reporting currency supplied by the API, which can fall back to listing currency when missing upstream. Market-cap currency is not supplied by the valuation endpoint and is left unknown.",
          annualBasis: "Latest annual row (fiscalQuarter=0) with operating data; no TTM or quarterly substitution. Fiscal-year labels do not identify calendar period ends. API annual rows may include rollups of complete quarterly data. Amounts are already absolute units; reportingScale is not applied again.",
          ratios: "Pct values are percentage points; other ratios are multiples. ROE/ROA/ROIC use fiscal-year-end balances, not average balances. ROIC = operating income * (1 - reported effective tax rate) / (debt + equity - cash); no tax fallback, missing cash is unknown, and nonpositive denominators are excluded. YoY revenue growth requires consecutive fiscal years in the same known currency.",
          ...(include.includes("valuation") ? { valuation: VALUATION_CAVEAT, dividendYield: "Latest stored dividend yield in percentage points, resolved to trailing-12-month paid dividends by the API." } : {}),
          ...(include.includes("risk") ? { risk: RISK_METHOD_NOTE } : {}),
        },
        warnings: ["Absolute amounts in different or unknown currencies are not normalized; fiscal calendars and source dates can differ. No metric leaders or investment recommendations are computed.", ...warnings],
      });
      return usefulData ? result : { ...result, isError: true };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: `compare_stocks failed: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  });
}
