import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bullrunGet } from "../bullrun.js";
import { requirePublicScope } from "../auth/scopes.js";
import { failureText, settle } from "./stockIdentity.js";
import { findExactEtf, fractionToPct, toolResult, type EtfProfile } from "./etfData.js";

const inputSchema = {
  ticker: z.string().min(1).describe("Exact Bullrun ETF listing ticker."),
  initialInvestment: z.number().nonnegative().default(10_000),
  contributionAmount: z.number().nonnegative().default(0),
  contributionFrequency: z.enum(["none", "monthly", "quarterly", "annual"]).default("monthly"),
  years: z.number().min(0.25).max(50).default(10),
  grossAnnualReturnPct: z.number().min(-99).max(100).default(0)
    .describe("Assumed annual return before ETF and trading costs, in percentage points. Default 0 isolates direct costs."),
  expenseRatioPct: z.number().nonnegative().max(20).optional()
    .describe("Optional expense-ratio override in percentage points. Otherwise uses the stored ETF profile value."),
  spreadPct: z.number().nonnegative().max(20).default(0)
    .describe("Assumed full bid/ask spread in percentage points; each purchase pays half the spread."),
  commissionPerTrade: z.number().nonnegative().default(0),
};

const outputSchema = {
  ticker: z.string(),
  assumptions: z.record(z.string(), z.unknown()),
  results: z.record(z.string(), z.unknown()),
  costBreakdown: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

function money(value: number): number {
  return Number(value.toFixed(2));
}

export function registerSimulateEtfCost(server: McpServer): void {
  server.registerTool(
    "simulate_etf_cost",
    {
      title: "Simulate ETF cost",
      annotations: { readOnlyHint: true },
      description:
        "Simulate expense-ratio, assumed bid/ask spread, commissions, and recurring contributions over a holding period. Compares the same gross-return path with and without costs and reports direct charges plus ending-value drag. Taxes, FX, market impact and brokerage-specific fees are excluded unless represented by the inputs. Read-only.",
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        requirePublicScope("read:market");
        const ticker = args.ticker.trim().toUpperCase();
        const [identity, profileRead] = await Promise.all([
          findExactEtf(ticker),
          settle(bullrunGet<EtfProfile>(`/api/etfs/${encodeURIComponent(ticker)}/profile`)),
        ]);
        const storedExpenseRatioPct = fractionToPct(profileRead.data?.expenseRatio);
        const expenseRatioPctUsed = args.expenseRatioPct ?? storedExpenseRatioPct;
        if (expenseRatioPctUsed == null) {
          throw new Error(profileRead.failure
            ? `${failureText(`The stored expense ratio for ${ticker}`, profileRead.failure)} Or provide expenseRatioPct explicitly.`
            : `No expense ratio is stored for ${ticker}; provide expenseRatioPct explicitly to simulate costs.`);
        }

        const months = Math.max(1, Math.round(args.years * 12));
        const annualGross = args.grossAnnualReturnPct / 100;
        const monthlyGross = (1 + annualGross) ** (1 / 12) - 1;
        const monthlyExpense = expenseRatioPctUsed / 100 / 12;
        const contributionEvery = {
          none: 0,
          monthly: 1,
          quarterly: 3,
          annual: 12,
        }[args.contributionFrequency];
        const halfSpreadRate = args.spreadPct / 200;

        let transactionCosts = 0;
        let managementFees = 0;
        let tradeCount = 0;
        let totalContributions = args.initialInvestment;
        const initialTrade = args.initialInvestment > 0;
        const initialTransactionCost = initialTrade
          ? Math.min(args.initialInvestment, args.commissionPerTrade + args.initialInvestment * halfSpreadRate)
          : 0;
        if (initialTrade) tradeCount++;
        transactionCosts += initialTransactionCost;
        let withCosts = Math.max(0, args.initialInvestment - initialTransactionCost);
        let withoutCosts = args.initialInvestment;

        for (let month = 1; month <= months; month++) {
          withCosts *= 1 + monthlyGross;
          withoutCosts *= 1 + monthlyGross;
          const fee = Math.max(0, withCosts * monthlyExpense);
          withCosts -= fee;
          managementFees += fee;

          if (contributionEvery > 0 && month % contributionEvery === 0 && args.contributionAmount > 0) {
            totalContributions += args.contributionAmount;
            withoutCosts += args.contributionAmount;
            const transactionCost = Math.min(
              args.contributionAmount,
              args.commissionPerTrade + args.contributionAmount * halfSpreadRate,
            );
            withCosts += args.contributionAmount - transactionCost;
            transactionCosts += transactionCost;
            tradeCount++;
          }
        }

        const endingValueDrag = withoutCosts - withCosts;
        return toolResult({
          ticker,
          assumptions: {
            currency: identity?.currency ?? null,
            initialInvestment: args.initialInvestment,
            contributionAmount: args.contributionAmount,
            contributionFrequency: args.contributionFrequency,
            holdingMonths: months,
            grossAnnualReturnPct: args.grossAnnualReturnPct,
            expenseRatioPctUsed,
            expenseRatioSource: args.expenseRatioPct != null ? "user_override" : "stored_profile",
            storedExpenseRatioPct,
            spreadPct: args.spreadPct,
            spreadCostPerPurchase: "half_quoted_spread",
            commissionPerTrade: args.commissionPerTrade,
          },
          results: {
            totalContributions: money(totalContributions),
            endingValueWithoutCosts: money(withoutCosts),
            endingValueWithCosts: money(withCosts),
            endingValueDrag: money(endingValueDrag),
            endingValueDragPct: withoutCosts > 0 ? Number((endingValueDrag / withoutCosts * 100).toFixed(6)) : null,
          },
          costBreakdown: {
            tradeCount,
            managementFeesPaid: money(managementFees),
            commissionsAndSpreadPaid: money(transactionCosts),
            directCostsPaid: money(managementFees + transactionCosts),
            opportunityCostOfFees: money(Math.max(0, endingValueDrag - managementFees - transactionCosts)),
          },
          warnings: [
            "This is a deterministic scenario, not a return forecast.",
            "Excludes taxes, FX conversion, market impact, securities lending revenue, tracking difference, and unprovided brokerage charges.",
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `simulate_etf_cost failed: ${msg}` }] };
      }
    },
  );
}
