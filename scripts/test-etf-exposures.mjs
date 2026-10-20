import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let upstream;
let registerGetEtfExposures;
let unknownAssetClass = false;

const holding = (holdingSymbol, holdingName, holdingCountry, weightPct, extra = {}) => ({
  ticker: "COPPER", asOfDate: "2026-10-09", holdingKey: holdingSymbol,
  holdingSymbol, holdingName, holdingCountry, weightPct,
  holdingAssetClass: "Equity", source: "ISSUER_FIXTURE", currency: null, ...extra,
});

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    let body;
    if (url.pathname.endsWith("/profile")) {
      body = {
        ticker: "COPPER", fundName: "Copper fund", holdingsCount: 4,
        // Raw provider asset_class may contain a fund name, while its label is Equity.
        assetClass: "Copper fund UCITS ETF - USD Acc",
        assetClassLabel: unknownAssetClass ? null : "Equity", categoryLabel: null,
      };
    } else if (url.pathname.endsWith("/holdings")) {
      body = [
        // HBM is also a different German company; accepting it would invent EUR/retail exposure.
        holding("HBM", "Hudbay Minerals Inc", "Canada", 60),
        // The right company on a German secondary venue still cannot supply its currency exposure.
        holding("S19", "Sumitomo Metal Mining Co Ltd", "Japan", 25),
        holding("A", "Another Miner Inc", "Canada", 10, { holdingSector: "Materials" }),
        holding("USD", "US Dollar", "US", 5, { holdingAssetClass: "Cash", currency: "USD" }),
      ];
    } else if (url.pathname === "/api/stocks/HBM") {
      body = { ticker: "HBM", company: "Hornbach Baumarkt AG", country: "Germany", sector: "Consumer Cyclical", exchange: "XETRA", currency: "EUR" };
    } else if (url.pathname === "/api/stocks/S19") {
      body = { ticker: "S19", company: "Sumitomo Metal Mining Co Ltd", country: "Japan", sector: "Basic Materials", exchange: "DU", currency: "EUR" };
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ registerGetEtfExposures } = await import("../dist/tools/getEtfExposures.js"));
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

beforeEach(() => { unknownAssetClass = false; });

async function withClient(run) {
  const server = new McpServer({ name: "etf-exposures-test", version: "1" });
  registerGetEtfExposures(server);
  const client = new Client({ name: "etf-exposures-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

async function exposures(client, args = {}) {
  const result = await client.callTool({ name: "get_etf_exposures", arguments: { ticker: "COPPER", ...args } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}

test("symbol collisions and foreign secondary currencies cannot invent mining-fund exposures", async () => {
  await withClient(async client => {
    const result = await exposures(client);
    assert.deepEqual(result.exposures.sector.map(row => [row.name, row.weightPct]), [
      ["Unclassified", 60], ["Basic Materials", 35], ["Cash & derivatives", 5],
    ]);
    assert.deepEqual(result.exposures.currency.map(row => [row.name, row.weightPct]), [
      ["CAD", 70], ["JPY", 25], ["USD", 5],
    ]);
    assert.deepEqual(result.coverage.currencyBasisWeightPct, {
      reported: 5, homeListing: 0, countryCurrency: 95, notReported: 0,
    });
    assert.equal(result.coverage.bucketCoverage.sector.totalWeightPct, 100);
    assert.equal(result.coverage.bucketCoverage.currency.totalWeightPct, 100);
    assert.equal(result.coverage.bucketCoverage.country.totalWeightPct, 95, "country excludes the disclosed 5% cash");
    assert.ok(result.warnings.some(warning => /currency shown is inferred/.test(warning)));
  });
});

test("asset exposure uses the normalized profile label and keeps an unknown label unavailable", async () => {
  await withClient(async client => {
    const result = await exposures(client, { types: ["asset"] });
    assert.deepEqual(result.exposures.asset, [{ name: "Equity", weightPct: 100, methodology: "fund_profile_classification" }]);
    unknownAssetClass = true;
    const missing = await exposures(client, { types: ["asset"] });
    assert.deepEqual(missing.exposures.asset, []);
    assert.deepEqual(missing.unavailableTypes, ["asset"]);
  });
});

test("a bucket limit explicitly accounts for all omitted exposure weight", async () => {
  await withClient(async client => {
    const result = await exposures(client, { types: ["sector", "country", "currency"], limitPerType: 1 });
    assert.deepEqual(result.coverage.bucketCoverage.sector, {
      totalBuckets: 3, returnedBuckets: 1, totalWeightPct: 100, returnedWeightPct: 60, omittedWeightPct: 40,
    });
    assert.equal(result.coverage.bucketCoverage.country.omittedWeightPct, 25);
    assert.equal(result.coverage.bucketCoverage.currency.omittedWeightPct, 30);
    assert.equal(result.exposures.sector.length, 1);
    assert.equal(result.warnings.filter(warning => /because of limitPerType/.test(warning)).length, 3);
  });
});

test("the advertised contract discloses inferred currencies and the country denominator", async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    const { description } = tools.find(tool => tool.name === "get_etf_exposures");
    assert.match(description, /explicitly disclosed estimate/);
    assert.match(description, /country covers securities and excludes cash and derivatives/);
    assert.doesNotMatch(description, /reported currency only/);
  });
});
