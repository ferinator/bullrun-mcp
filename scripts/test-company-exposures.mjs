import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

let upstream;
let registerCompareCompanyExposures;
let runWithAuth;
let callback;
let mode = "normal";
let requests = [];
let active = 0;
let maxActive = 0;
const subjectIds = { AAA: "1", BBB: "2", CCC: "3", DDD: "4", EEE: "5" };
const node = (id, name, ticker = null, role = "RELATED") => ({ id, name, ticker, role });
function edge(from, to, overrides = {}) {
  return { from, to, type: "SUPPLIES_TO", status: "VERIFIED", confidence: 0.91, soleSource: true,
    evidenceCount: 1, lastVerifiedAt: "2026-10-01T00:00:00Z",
    metrics: [{ metricType: "CUSTOMER_REVENUE_PCT", value: 61, unit: "PCT", period: "FY2025",
      measurementClass: "EXPLICIT", note: "Supplier revenue concentration" }],
    evidence: [{ sourceUrl: "https://example.com/filing", title: "Annual filing", sourceType: "PRIMARY_FILING", publishedAt: "2026-02-01T00:00:00Z" }],
    ...overrides };
}
function graph(ticker) {
  if (ticker.startsWith("NONE")) return { status: "none", subject: { name: null, ticker }, nodes: [], edges: [], coverage: {} };
  const id = subjectIds[ticker] ?? "999";
  const selected = node(id, `Company ${ticker}`, ticker, "SELECTED");
  if (mode === "empty") return { status: "ready", subject: { ticker }, nodes: [selected], edges: [], coverage: { edges: 0 } };
  const nodes = [selected, node("10", "Shared supplier", "SUP"), node("110", "Shared private vendor"),
    node(ticker === "AAA" ? "101" : "102", "Same Name Private LLC"),
    node(ticker === "AAA" ? "20" : "21", "Listed competitor", "CMP")];
  const edges = [edge("10", id), edge("110", id, { status: "SUGGESTED", confidence: 0.52, soleSource: false, metrics: [] }),
    edge(ticker === "AAA" ? "101" : "102", id), edge(id, ticker === "AAA" ? "20" : "21", { type: "COMPETES_WITH", soleSource: false })];
  if (ticker === "BBB") edges[0] = edge(id, "10", { status: "NEEDS_REVIEW", confidence: 0.65, soleSource: false });
  if (mode === "large") {
    nodes.splice(1);
    edges.splice(0);
    for (let index = 0; index < 80; index++) {
      const otherId = String(1000 + index);
      nodes.push(node(otherId, `Counterparty ${index}`, `OTHER${index}`));
      edges.push(edge(otherId, id, { evidenceCount: 10,
        evidence: Array.from({ length: 10 }, (_, n) => ({ sourceUrl: `https://example.com/${"path/".repeat(250)}${index}/${n}`, title: "Evidence ".repeat(60), sourceType: "PRIMARY_FILING" })),
        metrics: Array.from({ length: 10 }, () => ({ metricType: "CUSTOMER_REVENUE_PCT", value: 10, unit: "PCT", period: "FY2025", note: "Some disclosed metric. ".repeat(40) })) }));
    }
  }
  if (mode === "indirect") {
    edges.push(edge("10", "110"));
    edges.push(edge("no-such-node", id));
    edges.push(edge(id, id));
  }
  if (mode === "unknown-metric") {
    edges[0].metrics = [{ metricType: "OTHER_PROVIDER_METRIC", value: 0.7, unit: "ratio", period: "FY2023", measurementClass: "ESTIMATED" }];
    edges[0].evidence = [{ sourceUrl: "javascript:alert(1)", title: "Invalid source URL" }];
  }
  if (mode === "wrong-selected" && ticker === "AAA") selected.ticker = "WRONG";
  if (mode === "ambiguous" && ticker === "AAA") nodes.push(node("10", "Conflicting identity", "DIFFERENT"));
  if (mode === "alias") {
    selected.id = "same-subject";
    edges.forEach(e => { if (e.from === id) e.from = selected.id; if (e.to === id) e.to = selected.id; });
  }
  return { status: mode === "analyzing" ? "analyzing" : "ready", subject: { ticker: mode === "wrong-subject" && ticker === "AAA" ? "WRONG" : ticker },
    nodes, edges, coverage: { nodes: nodes.length, edges: edges.length, verifiedEdges: edges.filter(e => e.status === "VERIFIED").length },
    caveats: ["Missing edges are not evidence of no relationship."] };
}
before(async () => {
  upstream = http.createServer(async (req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const request = new URL(req.url, "http://upstream.test");
    requests.push({ method: req.method, url: request });
    const ticker = decodeURIComponent(request.pathname.split("/")[3] ?? "");
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (mode === "all-failed" || mode === "partial-failure" && ticker === "BBB") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "private-upstream-host secret-token body" }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(graph(ticker)));
      }
    } finally { active--; }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  // Large graph fixtures must not time out under parallel CI load.
  process.env.BULLRUN_API_TIMEOUT_MS = "5000";
  ({ registerCompareCompanyExposures } = await import("../dist/tools/compareCompanyExposures.js"));
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  registerCompareCompanyExposures({ registerTool(_name, _definition, handler) { callback = handler; } });
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});
function reset(nextMode = "normal") { mode = nextMode; requests = []; maxActive = 0; }
async function withClient(run) {
  const server = new McpServer({ name: "exposure-test", version: "1" });
  registerCompareCompanyExposures(server);
  const client = new Client({ name: "exposure-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}
const call = (client, changes = {}) => client.callTool({ name: "compare_company_exposures", arguments: { tickers: ["AAA", "BBB"], ...changes } });

test("SDK schema, directed cross-role joins, stable private identities and source evidence", async () => {
  reset();
  await withClient(async client => {
    const definition = (await client.listTools()).tools[0];
    assert.equal(definition.name, "compare_company_exposures");
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.inputSchema.properties.tickers.maxItems, 5);
    const result = await call(client, { tickers: [" aaa ", "BBB"] });
    assert.equal(result.isError, undefined);
    assert.equal(CallToolResultSchema.safeParse(result).success, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const payload = result.structuredContent;
    assert.deepEqual(payload.tickers, ["AAA", "BBB"]);
    assert.equal(payload.totals.matchingRelationships, 8);
    assert.equal(payload.sharedCounterparties.length, 3, "stable private ID, listed ticker and supplier join; same names alone do not join");
    assert.equal(payload.sharedCounterparties.some(row => row.identity.observedNames.includes("Same Name Private LLC")), false);
    const supplier = payload.sharedCounterparties.find(row => row.identity.tickers.includes("SUP"));
    assert.deepEqual(supplier.subjects.map(row => [row.subjectTicker, row.roles]), [["AAA", ["suppliers"]], ["BBB", ["customers"]]]);
    const evidenceRows = supplier.subjects.flatMap(subject => subject.relationshipIds).map(id => payload.relationships.find(row => row.id === id));
    assert.deepEqual(evidenceRows[0].direction, { fromNodeId: "10", toNodeId: "1", type: "SUPPLIES_TO" });
    assert.deepEqual(evidenceRows[1].direction, { fromNodeId: "2", toNodeId: "10", type: "SUPPLIES_TO" });
    assert.equal(evidenceRows[0].verified, true);
    assert.equal(evidenceRows[1].status, "NEEDS_REVIEW");
    assert.equal(evidenceRows[1].confidence, 0.65);
    assert.equal(evidenceRows[0].soleSource, true);
    assert.equal(evidenceRows[0].lastVerifiedAt, "2026-10-01T00:00:00Z");
    assert.equal(evidenceRows[0].evidence[0].url, "https://example.com/filing");
    assert.equal(evidenceRows[0].metrics[0].value, 61);
    assert.equal(evidenceRows[0].metrics[0].unit, "PCT");
    assert.equal(evidenceRows[0].metrics[0].period, "FY2025");
    assert.match(evidenceRows[0].metrics[0].meaning, /supplier's revenue.*not the customer's purchasing spend/);
    const competitor = payload.sharedCounterparties.find(row => row.identity.tickers.includes("CMP"));
    assert.deepEqual(competitor.identity.nodeIds, ["20", "21"], "exact ticker can join different cached entity IDs");
    const suggested = payload.relationships.find(row => row.counterparty.nodeId === "110");
    assert.equal(suggested.status, "SUGGESTED");
    assert.equal(suggested.verified, false);
    assert.equal(suggested.confidence, 0.52);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(row => row.method === "GET" && /^\/api\/stocks\/[A-Z]+\/relationships$/.test(row.url.pathname) && !row.url.search));
    assert.equal(Object.hasOwn(payload, "lossEstimate"), false);
  });
});

test("role and verification filters keep individual edge status and coverage", async () => {
  reset();
  await withClient(async client => {
    const result = await call(client, { roles: ["suppliers"], verifiedOnly: true });
    const payload = result.structuredContent;
    assert.ok(payload.relationships.every(row => row.role === "suppliers" && row.verified));
    assert.equal(payload.sharedCounterparties.length, 0, "the shared supplier is a customer for BBB and private vendor is unverified");
    assert.equal(payload.companies[0].hiddenUnverifiedRelationships, 1);
    assert.equal(payload.companies[1].hiddenUnverifiedRelationships, 1);
    assert.equal(payload.companies[0].cachedCoverage.edges, 4);
    assert.equal(payload.companies[0].countsByRole.suppliers, 2);
  });
});

test("duplicate/invalid tickers and SDK count limits reject before any reads", async () => {
  reset();
  await withClient(async client => {
    for (const tickers of [["AAA", "aaa"], ["AAA", "Company Name"], ["AAA", "../BBB"], ["AAA"], ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]]) {
      const result = await call(client, { tickers });
      assert.equal(result.isError, true, JSON.stringify(tickers));
    }
    assert.equal(requests.length, 0);
  });
});

test("five requested companies use at most five reads and three concurrent reads", async () => {
  reset();
  await withClient(async client => {
    const result = await call(client, { tickers: ["AAA", "BBB", "CCC", "DDD", "EEE"] });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 5);
    assert.ok(maxActive <= 3 && maxActive > 1);
  });
});

test("unknown graphs remain unknown and partial failures retain usable evidence without leaking errors", async () => {
  reset();
  await withClient(async client => {
    let result = await call(client, { tickers: ["AAA", "NONE"] });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.companies[1].status, "unknown");
    assert.equal(result.structuredContent.companies[1].matchingRelationships, null);
    assert.equal(result.structuredContent.sharedCounterparties.length, 0);
    result = await call(client, { tickers: ["NONE1", "NONE2"] });
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.companies.every(company => company.status === "unknown" && company.matchingRelationships == null));
    reset("partial-failure");
    result = await call(client);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.companies[1].status, "unavailable");
    assert.ok(result.structuredContent.relationships.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /private-upstream-host|secret-token|127\.0\.0\.1/);
    reset("all-failed");
    result = await call(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.relationships.length, 0);
  });
});

test("subject and duplicate-node identity mismatches reject the entire affected graph", async () => {
  await withClient(async client => {
    for (const nextMode of ["wrong-subject", "wrong-selected", "ambiguous"]) {
      reset(nextMode);
      const result = await call(client);
      assert.equal(result.structuredContent.companies[0].status, "identity_mismatch", nextMode);
      assert.equal(result.structuredContent.relationships.some(row => row.subjectTicker === "AAA"), false);
      assert.equal(result.structuredContent.sharedCounterparties.length, 0);
    }
  });
});

test("non-subject and malformed edges are excluded without reversing supplier direction", async () => {
  reset("indirect");
  await withClient(async client => {
    const result = await call(client);
    assert.equal(result.structuredContent.totals.matchingRelationships, 8);
    assert.equal(result.structuredContent.companies[0].ignoredIndirectOrMalformedEdges, 3);
    assert.equal(result.structuredContent.companies[0].status, "partial");
  });
});

test("same-company listing aliases cannot manufacture a shared multi-company exposure", async () => {
  reset("alias");
  await withClient(async client => {
    const result = await call(client);
    assert.equal(result.structuredContent.sharedCounterparties.length, 0);
    assert.ok(result.structuredContent.warnings.some(warning => /same company entity/.test(warning)));
  });
});

test("unknown metric semantics stay unknown and invalid source URLs are accounted for", async () => {
  reset("unknown-metric");
  await withClient(async client => {
    const result = await call(client);
    const row = result.structuredContent.relationships.find(relationship => relationship.counterparty.ticker === "SUP");
    assert.equal(row.metrics[0].meaning, null);
    assert.equal(row.metrics[0].value, 0.7);
    assert.equal(row.metrics[0].unit, "ratio");
    assert.equal(row.metrics[0].measurementClass, "ESTIMATED");
    assert.equal(row.evidence[0].url, null);
    assert.equal(row.detailsOmitted.invalidSourceUrls, 1);
    assert.equal(result.structuredContent.totals.truncated, true);
  });
});

test("per-company and byte limits expose complete totals and valid evidence references", async () => {
  reset();
  await withClient(async client => {
    let result = await call(client, { limitPerCompany: 1 });
    assert.equal(result.structuredContent.relationships.length, 2);
    assert.equal(result.structuredContent.totals.matchingRelationships, 8);
    assert.equal(result.structuredContent.totals.omittedRelationships, 6);
    assert.equal(result.structuredContent.totals.sharedCounterpartiesInMatchingGraphs, 3);
    assert.equal(result.structuredContent.totals.truncated, true);
    reset("large");
    result = await call(client, { tickers: ["AAA", "BBB", "CCC", "DDD", "EEE"], limitPerCompany: 50 });
    const payload = result.structuredContent;
    assert.equal(payload.totals.matchingRelationships, 400);
    assert.equal(payload.totals.sharedCounterpartiesInMatchingGraphs, 80);
    assert.ok(payload.relationships.length < 250, "response budget must bound the serialized MCP result too");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 220 * 1024);
    assert.equal(payload.totals.truncated, true);
    assert.ok(payload.relationships.every(row => row.detailsOmitted.evidence === 7 && row.detailsOmitted.metrics === 2));
    const ids = new Set(payload.relationships.map(row => row.id));
    assert.ok(payload.sharedCounterparties.every(group => group.subjects.every(subject => subject.relationshipIds.every(id => ids.has(id)))));
    assert.equal(payload.totals.omittedRelationships, 400 - payload.relationships.length);
  });
});

test("in-progress graphs and valid empty graphs do not imply complete real-world coverage", async () => {
  await withClient(async client => {
    reset("analyzing");
    let result = await call(client);
    assert.equal(result.structuredContent.companies[0].status, "partial");
    reset("empty");
    result = await call(client);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.totals.matchingRelationships, 0);
    assert.match(result.structuredContent.warnings[0], /unknown coverage/);
  });
});

test("upstream timeouts retain partial results and auth failures make no requests", async t => {
  reset();
  const originalFetch = globalThis.fetch;
  // Inject the transport failure so this case does not depend on CI timer scheduling.
  const timeoutFetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).pathname === "/api/stocks/AAA/relationships") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return originalFetch(url, options);
  });
  await withClient(async client => {
    const result = await call(client);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.companies[0].status, "unavailable");
    assert.equal(result.structuredContent.companies[1].status, "available");
  });
  timeoutFetch.mock.restore();
  reset();
  const result = await runWithAuth({ token: "test", scopes: [] }, () => callback({ tickers: ["AAA", "BBB"], roles: ["suppliers"], verifiedOnly: false, limitPerCompany: 25 }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read:market/);
  assert.equal(requests.length, 0);
});
