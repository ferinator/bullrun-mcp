import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let estimates = [];
let fail = false;
let quoteCurrency = "USD";
const api = http.createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/api/stocks/AAPL") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ticker: "AAPL", company: "Apple", currency: quoteCurrency, quoteType: "EQUITY" }));
  }
  if (path === "/api/prices/AAPL") return res.end(JSON.stringify([{ closePrice: 200, tradeDate: "2026-10-16" }]));
  if (fail) { res.writeHead(503); return res.end("private-upstream-diagnostic-must-not-leak"); }
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(path.endsWith("/forward-estimates") ? estimates : []));
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
process.env.BULLRUN_API_BASE = `http://127.0.0.1:${api.address().port}`;
const { registerGetForwardEstimates } = await import("../dist/tools/getForwardEstimates.js");
const { registerGetOperatingKpis } = await import("../dist/tools/getOperatingKpis.js");
const { registerGetEarningsCallTranscript } = await import("../dist/tools/getEarningsCallTranscript.js");
after(() => new Promise(resolve => api.close(resolve)));

const row = (year, eps, asOfDate = "2026-10-19", sourceCurrency = "USD") => ({
  ticker: "AAPL", fiscalYear: year, fiscalQuarter: 0, periodType: "ANNUAL", asOfDate,
  source: "yfinance", sourceCurrency, epsAvg: eps, revenueAvg: 1000,
});

async function call(name) {
  const server = new McpServer({ name: "research-feed-test", version: "1" });
  registerGetForwardEstimates(server);
  registerGetOperatingKpis(server);
  registerGetEarningsCallTranscript(server);
  const client = new Client({ name: "research-feed-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: { ticker: "AAPL" } });
    return result.isError ? result : JSON.parse(result.content.find(item => item.type === "text").text);
  } finally { await Promise.allSettled([client.close(), server.close()]); }
}

test("forward context uses matching units and consecutive fiscal targets", async () => {
  estimates = [row(2027, 10), row(2028, 12)];
  const data = await call("get_forward_estimates");
  assert.equal(data.derived.forwardPe, 20);
  assert.equal(data.derived.impliedForwardEpsGrowthPct, 20);
  assert.equal(data.derived.forwardPeg, 1);
  assert.match(data.coverage.refreshPolicy, /completion is not awaited/);
});

test("a latest loss estimate never falls back to an older positive snapshot", async () => {
  estimates = [row(2027, -1), row(2028, 12), row(2027, 10, "2026-10-18")];
  const data = await call("get_forward_estimates");
  assert.equal(data.derived.forwardPe, null);
  assert.equal(data.derived.forwardPeBasis.epsAvg, -1);
  assert.equal(data.derived.forwardPeg, null);
});

test("unmatched currency units and nonconsecutive periods suppress invalid ratios", async () => {
  estimates = [row(2027, 10, "2026-10-19", "CHF"), row(2028, 12, "2026-10-19", "CHF")];
  assert.equal((await call("get_forward_estimates")).derived.forwardPe, null);
  estimates = [row(2027, 10), row(2029, 12)];
  const data = await call("get_forward_estimates");
  assert.equal(data.derived.forwardPe, 20);
  assert.equal(data.derived.impliedForwardEpsGrowthPct, null);
});

test("empty optional feeds distinguish curated coverage from pending imports", async () => {
  assert.equal((await call("get_operating_kpis")).coverage.feedStatus, "curated_only_no_automatic_feed");
  const transcript = await call("get_earnings_call_transcript");
  assert.equal(transcript.coverage.chunks, 0);
  assert.match(transcript.warnings.join(" "), /background/);
  assert.match(transcript.warnings.join(" "), /roles.*not supplied/i);
});

test("upstream failures remain errors without exposing diagnostic bodies or internal URLs", async () => {
  fail = true;
  try {
    for (const name of ["get_forward_estimates", "get_operating_kpis", "get_earnings_call_transcript"]) {
      const result = await call(name);
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /private-upstream|127\.0\.0\.1|\/api\//);
    }
  } finally { fail = false; }
});
