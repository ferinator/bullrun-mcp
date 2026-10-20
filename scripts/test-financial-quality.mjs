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

before(async () => {
  upstream = http.createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.test").pathname;
    let body;
    if (path === "/api/stocks/2050.HK") body = {
      ticker: "2050.HK", company: "Zhejiang Sanhua Intelligent Controls", exchange: "HK", country: "China", currency: "HKD",
    };
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
