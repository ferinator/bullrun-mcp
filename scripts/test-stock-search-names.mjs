import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let upstream;
let registerSearchStocks;
const row = (fields) => ({ quoteType: "EQUITY", primaryTicker: null, lifecycleStatus: "ACTIVE", ...fields });
const listings = [
  { ticker: "6324.T", company: "Harmonic Drive Systems Inc.", exchange: "TSE", currency: "JPY", country: "Japan" },
  { ticker: "K3R", company: "HARMONIC DRIVE", exchange: "F", currency: "EUR", country: "Japan" },
].map(fields => row({ ...fields, isin: "JP3765150002" }));
// Sanhua as stored: the Shenzhen A share has no ISIN; the Hong Kong H share and its
// Frankfurt line share CNE100006Z79. The Frankfurt row carries the short provider label
// that exactly matches the query, as K3R does for Harmonic Drive.
const sanhua = [
  row({ ticker: "002050.SZ", company: "ZHEJIANG SANHUA INTELLIGENT CONTROLS CO.,LTD.", exchange: "SZ", currency: "CNY", country: "China", isin: null }),
  row({ ticker: "2050.HK", company: "Zhejiang Sanhua Intelligent Controls Co.,Ltd", exchange: "HK", currency: "HKD", country: "China", isin: "CNE100006Z79" }),
  row({ ticker: "I19", company: "SANHUA", exchange: "F", currency: "EUR", country: "China", isin: "CNE100006Z79" }),
];
// No home-venue line in Bullrun: an Irish issuer seen only in Frankfurt and London.
const awayOnly = [
  row({ ticker: "A1B", company: "Away Holdings", exchange: "F", currency: "EUR", country: "Ireland", isin: "IE000AWAY001" }),
  row({ ticker: "AWAY", company: "Away Holdings plc", exchange: "LSE", currency: "GBX", country: "Ireland", isin: "IE000AWAY001" }),
];

before(async () => {
  upstream = http.createServer((req, res) => {
    const term = new URL(req.url, "http://stub").searchParams.get("search");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(term === "Sanhua" ? sanhua : term === "Away Holdings" ? awayOnly : listings));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerSearchStocks } = await import("../dist/tools/searchStocks.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

async function search(args) {
  const server = new McpServer({ name: "stock-search-names-test", version: "1" });
  registerSearchStocks(server);
  const client = new Client({ name: "stock-search-names-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "search_stocks", arguments: args });
    assert.equal(result.isError, undefined);
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}

test("an exact provider name keeps the home listing visible, and the home listing ranks first", async () => {
  const result = await search({ query: "Harmonic Drive" });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.resolvedTicker, null);
  assert.equal(result.candidateCount, 2);
  // Same ISIN: Tokyo is the issuer's home venue, so it leads Frankfurt's exact-name line.
  assert.deepEqual(result.candidates.map(row => row.ticker), ["6324.T", "K3R"]);
  assert.equal(result.candidates[0].match, "name_or_symbol_search");
  assert.equal(result.candidates[1].match, "exact_company_name");
});

test("limited name results disclose the omitted listings", async () => {
  const result = await search({ query: "Harmonic Drive", limit: 1 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidateCount, 2);
  assert.equal(result.returnedCount, 1);
  assert.deepEqual(result.candidates.map(row => row.ticker), ["6324.T"]);
  assert.equal(result.coverage.mayBeTruncated, true);
  assert.ok(result.warnings.some(warning => /Additional candidates/.test(warning)));
});

test("an exact native ticker still selects the requested listing", async () => {
  const result = await search({ query: "6324.T" });
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedTicker, "6324.T");
  assert.deepEqual(result.candidates.map(row => row.ticker), ["6324.T"]);
});

test("a Frankfurt line ranks after its Hong Kong H share, and the A share keeps its place", async () => {
  const result = await search({ query: "Sanhua" });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.resolvedTicker, null, "a name search never resolves");
  // Without the home-venue rule the exact-name Frankfurt row would come first.
  assert.deepEqual(result.candidates.map(row => row.ticker), ["2050.HK", "002050.SZ", "I19"]);
  assert.deepEqual(result.candidates.map(row => row.match), ["name_or_symbol_search", "name_or_symbol_search", "exact_company_name"]);
});

test("a security with no home-venue listing keeps its order", async () => {
  const result = await search({ query: "Away Holdings" });
  assert.deepEqual(result.candidates.map(row => row.ticker), ["A1B", "AWAY"]);
  assert.equal(result.candidates[0].match, "exact_company_name");
});
