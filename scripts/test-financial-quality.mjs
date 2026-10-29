import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { reportedEbitdaWarnings } from "../dist/tools/financialQuality.js";

let upstream;
let registerGetFinancialHistory;
let registerGetStockMetrics;
const quarterly = {
  ticker: "2050.HK", fiscalYear: 2026, fiscalQuarter: 2, sourceCurrency: "CNY",
  revenue: 9_126_417_141.28, operatingIncome: 1_559_248_989.74,
  ebit: 1_335_083_267.54, ebitda: 1_335_083_267.54,
  depreciationAndAmortization: null,
};
const annual = { ...quarterly, fiscalYear: 2025, fiscalQuarter: 0, depreciationAndAmortization: 0 };
const historyRows = Array.from({ length: 13 }, (_, index) => 2014 + index).flatMap(fiscalYear =>
  Array.from({ length: 5 }, (_, fiscalQuarter) => ({
    ...annual,
    ticker: "HIST", fiscalYear, fiscalQuarter, sourceCurrency: "CHF", reportingScale: 1,
    revenue: (fiscalYear - 2000) * 100_000_000,
    netIncome: (fiscalYear - 2000) * 10_000_000,
    freeCashflow: (fiscalYear - 2000) * 8_000_000,
    totalDebt: 120_000_000,
    totalAssets: 500_000_000,
  })),
);

before(async () => {
  upstream = http.createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.test").pathname;
    let body;
    if (path === "/api/stocks/2050.HK") body = {
      ticker: "2050.HK", company: "Zhejiang Sanhua Intelligent Controls", exchange: "HK", country: "China", currency: "HKD",
    };
    else if (path === "/api/stocks/HIST") body = {
      ticker: "HIST", company: "History fixture", exchange: "SW", country: "Switzerland", currency: "CHF",
    };
    else if (path === "/api/financials/HIST") body = historyRows;
    else if (path === "/api/financials/2050.HK") body = [quarterly, annual];
    else if (path === "/api/stocks/2050.HK/profile") body = { ticker: "2050.HK" };
    else if (/^\/api\/(prices|valuations)\//.test(path)) body = [];
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerGetFinancialHistory } = await import("../dist/tools/getFinancialHistory.js"));
  ({ registerGetStockMetrics } = await import("../dist/tools/getStockMetrics.js"));
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function call(name, args) {
  const server = new McpServer({ name: "financial-quality-test", version: "1" });
  registerGetFinancialHistory(server);
  registerGetStockMetrics(server);
  const client = new Client({ name: "financial-quality-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  } finally { await client.close(); await server.close(); }
}

test("missing D&A is disclosed while explicit zero and independent EBIT definitions remain valid", () => {
  const [warning] = reportedEbitdaWarnings([{ period: "FY2026 Q2", ...quarterly }]);
  assert.match(warning, /cannot be validated/);
  assert.match(warning, /unknown, not zero/);
  assert.deepEqual(reportedEbitdaWarnings([{ period: "FY2025", ...annual }]), []);
  assert.deepEqual(reportedEbitdaWarnings([{ period: "Q1", ebit: 100, ebitda: 120 }]), []);
  assert.deepEqual(reportedEbitdaWarnings([{ period: "Q1", ebit: null, ebitda: 100 }]), []);
});

test("history retains the reported amounts and flags only the requested periods", async () => {
  const history = await call("get_financial_history", { ticker: "2050.HK", periodType: "quarterly" });
  assert.equal(history.quarterly[0].incomeStatement.ebitda, quarterly.ebitda);
  assert.equal(history.quarterly[0].incomeStatement.operatingIncome, quarterly.operatingIncome);
  assert.equal(history.quarterly[0].cashFlow.depreciationAndAmortization, null);
  assert.ok(history.warnings.some(w => /FY2026 Q2.*cannot be validated/.test(w)));
  const annualHistory = await call("get_financial_history", { ticker: "2050.HK", periodType: "annual" });
  assert.equal(annualHistory.annual[0].incomeStatement.ebitda, annual.ebitda);
  assert.deepEqual(annualHistory.warnings, [], "an unrequested quarter cannot flag an annual-only answer");
});

test("the stock snapshot carries the same caveat without replacing EBITDA or inferring D&A", async () => {
  const snapshot = await call("get_stock_metrics", { ticker: "2050.HK" });
  assert.equal(snapshot.latestFinancials.ebitda, quarterly.ebitda);
  assert.ok(snapshot.warnings.some(w => /FY2026 Q2.*cannot be validated/.test(w)));
});

test("default financial research is compact while explicit quarterly and longer windows remain available", async () => {
  const compact = await call("get_financial_history", { ticker: "HIST" });
  const detailed = await call("get_financial_history", { ticker: "HIST", years: 10, periodType: "both" });
  assert.equal(compact.coverage.requestedYears, 5);
  assert.equal(compact.coverage.requestedPeriodType, "annual");
  assert.equal(compact.coverage.returnedRows, 5);
  assert.equal(compact.annual.length, 5);
  assert.equal(compact.quarterly, undefined);
  assert.equal(detailed.coverage.returnedRows, 50);
  assert.equal(detailed.annual.length, 10);
  assert.equal(detailed.quarterly.length, 40);
  assert.deepEqual(compact.annual, detailed.annual.slice(0, 5), "compact defaults must preserve statement values");
  assert.ok(JSON.stringify(compact).length < JSON.stringify(detailed).length * 0.4, "default history should avoid a decade of unrequested quarterly rows");
  assert.equal(compact.summary.comparableAnnualPeriods, 4);
  assert.equal(typeof compact.summary.revenueCagrPct, "number");
  assert.deepEqual(compact.coverage.sourceCurrencies, ["CHF"]);
  assert.match(compact.methodology.growth, /missing years.*currency/);
  assert.match(compact.methodology.statements, /publication or collection dates/);

  const quarterlyOnly = await call("get_financial_history", { ticker: "HIST", years: 1, periodType: "quarterly" });
  assert.equal(quarterlyOnly.coverage.returnedRows, 4);
  assert.equal(quarterlyOnly.annual, undefined);
  assert.equal(quarterlyOnly.quarterly.length, 4);
});

test("compact server instructions retain account, data-coverage and research-only boundaries", async () => {
  const { createMcpServer } = await import("../dist/mcpServer.js");
  for (const options of [{}, { researchOnly: true }, { marketplace: true }]) {
    const server = createMcpServer(options);
    const client = new Client({ name: "instruction-coverage-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const text = client.getInstructions();
      assert.ok(text.length < (options.researchOnly || options.marketplace ? 4000 : 6500));
      for (const phrase of ["search_stocks", "get_company_data_coverage", "Missing data is unknown", "percentage points", "one holding", "source dates", "not live quotes"]) {
        assert.ok(text.includes(phrase), `${JSON.stringify(options)} lost ${phrase}`);
      }
      if (options.marketplace) {
        assert.match(text, /Mcprush enforces subscription call allowances/);
        assert.doesNotMatch(text, /700 successful tool calls/);
      } else {
        assert.match(text, /700 successful tool calls per rolling 30 days/);
        assert.match(text, /1,000 successful tool calls per rolling 5 hours/);
      }
      if (options.researchOnly || options.marketplace) {
        for (const name of ["list_portfolios", "save_research_shortlist", "create_portfolio_draft"]) assert.equal(text.includes(name), false);
      } else {
        assert.match(text, /privacyMode=weights_only/);
        assert.match(text, /never change holdings until accepted/);
        assert.match(text, /preserve the basket verbatim/);
        assert.match(text, /write:shortlist\/read:shortlist/);
      }
    } finally { await client.close(); await server.close(); }
  }
});
