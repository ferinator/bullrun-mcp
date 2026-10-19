import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { addPlatformLinks, continuationFor, platformLink, withPlatformLink } from "../dist/tools/platformLinks.js";

function destination(tool, args, payload) {
  const link = continuationFor(tool, args, payload);
  assert.ok(link, `${tool} has a continuation`);
  const url = new URL(link.url);
  assert.equal(url.origin, "https://bull-run.org");
  assert.equal(url.searchParams.get("utm_source"), "mcp");
  assert.equal(url.searchParams.get("utm_medium"), "assistant");
  assert.equal(url.searchParams.get("utm_content"), tool);
  assert.equal(url.searchParams.get("utm_campaign"), tool.startsWith("create_") ? "portfolio" : "research");
  return { link, url };
}

test("new research continuations use real pages and disclose unavailable historical or shared-network UI state", () => {
  const calendar = destination("get_corporate_calendar", {}, { calendars: [{type:"ex_dividend",events:[{ticker:"AAPL"}]}] });
  assert.equal(calendar.url.pathname, "/calendar/ex-dividend");
  assert.match(calendar.link.description, /MCP filters.*not applied/);
  const history = destination("get_company_risk_history", {ticker:"AAPL"}, {history:[{asOfDate:"2026-10-18"}]});
  assert.equal(history.url.pathname, "/stocks/AAPL/analysis");
  assert.equal(history.url.hash, "#dials");
  assert.match(history.link.description, /does not reproduce this historical window/);
  const coverage = destination("get_company_data_coverage", {ticker:"AAPL"}, {datasets:[{dataset:"prices"}]});
  assert.equal(coverage.url.pathname, "/stocks/AAPL");
  const network = destination("compare_company_exposures", {}, {companies:[{ticker:"AAPL",subject:{nodeId:"1"}}]});
  assert.equal(network.url.pathname, "/stocks/AAPL/analysis");
  assert.equal(network.url.hash, "#network");
  assert.match(network.link.description, /does not reproduce.*shared-counterparty/);
  assert.equal(continuationFor("get_company_risk_history", {ticker:"UNKNOWN"}, {history:[]}), null);
  assert.equal(continuationFor("get_corporate_calendar", {}, {calendars:[]}), null);
});

test("continuations stay on the canonical origin and encode entity identifiers", () => {
  const { url } = destination("get_stock_metrics", { ticker: " BRK/B " }, { ticker: "BRK/B", identity: { company: "Berkshire" } });
  assert.equal(url.pathname, "/stocks/BRK%2FB");
  assert.throws(() => platformLink("get_stock_metrics", "https://evil.test", "x", "x"));
  assert.throws(() => platformLink("get_stock_metrics", "//evil.test", "x", "x"));
  assert.throws(() => platformLink("get_stock_metrics", "/\\evil.test", "x", "x"));
  assert.throws(() => platformLink("bad tool", "/stocks", "x", "x"));
});

test("stock screen preserves normalized AND/OR rules, aliases, lookback and listing semantics", () => {
  const rules = [
    { id: "mcp-rule-1", metric: "peRatio", operator: "..", value: "5", valueMax: "25", unit: "", groupId: 1 },
    { id: "mcp-rule-2", metric: "latestRevenue", operator: ">=", value: "2.5", valueMax: "", unit: "B", groupId: 2 },
    // minMarketCap is already expanded into each group by the tool handler.
    { id: "marketCap-1", metric: "marketCap", operator: ">=", value: "1000000", valueMax: "", unit: "", groupId: 1 },
    { id: "marketCap-2", metric: "marketCap", operator: ">=", value: "1000000", valueMax: "", unit: "", groupId: 2 },
  ];
  const query = { rules, lookbackMode: "quarterly", lookback: 8, sector: "Technology", industry: "Software & Services", country: "", countries: ["United States", "Japan"], sortBy: "revenueGrowth", order: "asc" };
  const { url } = destination("screen_stocks", { includeSecondary: true, includeInactive: true, brief: "Do not copy" }, { query, returned: 0, results: [] });
  assert.equal(url.pathname, "/screener");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), { version: 1, rules, lookbackMode: "quarterly", lookback: 8, sector: query.sector, industry: query.industry, country: "", countries: query.countries, includeSecondary: true });
  assert.equal(url.searchParams.get("sortBy"), "revenueGrowthPct");
  assert.equal(url.searchParams.get("order"), "asc");
  assert.equal(url.searchParams.get("includeInactive"), "true");
  assert.equal(url.searchParams.has("brief"), false);
  const universe = destination("screen_stocks", {}, { query: { rules: [], lookbackMode: "annual", lookback: 40 } }).url;
  assert.equal(JSON.parse(universe.searchParams.get("filter")).lookback, 40);
  assert.deepEqual(JSON.parse(universe.searchParams.get("filter")).rules, []);
});

test("discovery links preserve preset rules and avoid choosing ambiguous stock listings", () => {
  assert.equal(continuationFor("search_stocks", {}, { resolvedTicker: null, candidates: [{ ticker: "BMW" }, { ticker: "BMW3" }] }), null);
  assert.equal(destination("search_stocks", {}, { resolvedTicker: "BMW" }).url.pathname, "/stocks/BMW");
  const query = { rules: [{ metric: "peRatio", operator: "<=", value: "20", groupId: 1 }], lookbackMode: "annual", lookback: 3,
    countries: ["Germany"], sortBy: "peRatio", order: "asc" };
  const preset = destination("screen_stock_presets", {}, { action: "run", query }).url;
  assert.deepEqual(JSON.parse(preset.searchParams.get("filter")).rules, query.rules);
  assert.equal(preset.searchParams.get("sortBy"), "peRatio");
  assert.equal(continuationFor("screen_stock_presets", {}, { action: "list", presets: [] }), null);
  for (const [name, field] of [["get_stock_price_history", "bars"], ["get_company_news", "articles"], ["find_stock_peers", "peers"]]) {
    assert.equal(continuationFor(name, { ticker: "AAPL" }, { [field]: [] }), null);
    const { link, url } = destination(name, { ticker: "AAPL", since: "2026-01-01" }, { [field]: [{}] });
    assert.equal(url.pathname, "/stocks/AAPL");
    assert.ok(link.description.includes("not"));
    assert.equal(url.searchParams.has("since"), false);
  }
});

test("risk-board links preserve multi-band coverage and every supported sort", () => {
  const sortMap = { market_cap: "marketCap", score_desc: "score", score_asc: "score-asc", worsened: "move", improved: "improved", coverage: "coverage", name: "name" };
  for (const [sortBy, sort] of Object.entries(sortMap)) {
    const { url } = destination("screen_risk_board", {}, { mechanism: "LEVERAGE", filters: { bands: ["STRETCHED", "ACUTE"], sector: "Financial Services", country: "United States", minDialsLit: 2 }, sortBy, offset: 75 });
    assert.equal(url.pathname, "/analysis");
    assert.equal(url.searchParams.get("mechanism"), "LEVERAGE");
    assert.equal(url.searchParams.get("band"), "stretched,acute");
    assert.equal(url.searchParams.get("sector"), "Financial Services");
    assert.equal(url.searchParams.get("country"), "United States");
    assert.equal(url.searchParams.get("coverage"), "2");
    assert.equal(url.searchParams.get("sort"), sort);
    assert.equal(url.searchParams.has("offset"), false);
  }
});

test("portfolio handoff selects exactly one saved draft or portfolio without private values", () => {
  for (const name of ["create_portfolio_draft", "create_position_draft", "create_portfolio_from_positions"]) {
    const { url } = destination(name, { startingCash: 12345, brief: "private strategy" }, { saved: true, draftId: 42, targetPortfolioId: 8 });
    assert.equal(url.pathname, "/portfolio");
    assert.equal(url.searchParams.get("draftId"), "42");
    assert.equal(url.searchParams.has("portfolioId"), false);
    assert.equal(url.searchParams.has("startingCash"), false);
    assert.equal(url.searchParams.has("brief"), false);
    assert.equal(continuationFor(name, {}, { saved: false, draftId: 42 }), null);
    assert.equal(continuationFor(name, {}, { saved: true, draftId: null }), null);
  }
  for (const name of ["get_portfolio_context", "get_portfolio_analytics", "analyze_portfolio_fit"]) {
    const { url } = destination(name, { portfolioId: 8, privacyMode: "weights_only" }, {});
    assert.equal(url.searchParams.get("portfolioId"), "8");
    assert.equal(url.searchParams.has("privacyMode"), false);
  }
});

test("network hash, macro country and history series match supported destinations", () => {
  const network = destination("get_company_relationships", {}, { ticker: "AAPL", subject: { ticker: "AAPL" } }).url;
  assert.equal(network.pathname, "/stocks/AAPL/analysis");
  assert.equal(network.hash, "#network");
  assert.equal(destination("get_company_risk", {}, { ticker: "AAPL", identity: { ticker: "AAPL" } }).url.hash, "#dials");
  const country = destination("get_country_macro", {}, { country: "Côte d'Ivoire", coverage: { indicatorsHeld: 3 } }).url;
  assert.equal(country.pathname, "/markets/country/cote-d-ivoire");
  const history = destination("get_macro_history", {}, { found: true, code: "UNEMPLOYMENT:Germany", title: "German unemployment" }).url;
  assert.equal(history.searchParams.get("series"), "UNEMPLOYMENT:Germany");
  assert.equal(history.searchParams.get("title"), "German unemployment");
  assert.equal(destination("get_macro_indicators", {}, { indicator: "house_price_to_income" }).url.pathname, "/markets/house-prices-vs-income");
});

test("ETF funds, index groups and comparisons use real app routes and disclose UI limits", () => {
  assert.equal(destination("get_etf_fund", {}, { found: true, fund: { fundIsin: "IE00B4L5Y983" } }).url.pathname, "/etfs/isin/IE00B4L5Y983");
  assert.equal(destination("get_etf_index_group", {}, { found: true, indexKey: "MSCI_WORLD" }).url.pathname, "/etfs/index/MSCI_WORLD");
  const compare = destination("compare_etfs", {}, { coverage: ["EUNL.DE", "VWRL.L", "SPY", "VTI", "QQQ"].map(ticker => ({ ticker, identityAvailable: true })) });
  assert.equal(compare.url.pathname, "/compare/eunl.de-vs-vwrl.l-vs-spy-vs-vti");
  assert.match(compare.link.description, /four instruments/);
  const screen = destination("screen_etfs", { category: "Equity" }, {});
  assert.equal(screen.url.pathname, "/screener");
  assert.equal(screen.url.searchParams.get("universe"), "etfs");
  assert.match(screen.link.description, /without applying.*filters/);
  assert.equal(destination("get_etf_exposures", {}, { ticker: "SPY", coverage: { storedHoldingRows: 0 }, exposures: { asset: [{ name: "Equity" }] } }).url.pathname, "/etfs/SPY");
  assert.equal(destination("simulate_etf_cost", {}, { ticker: "SPY", assumptions: { currency: "USD", storedExpenseRatioPct: null } }).url.pathname, "/etfs/SPY");
  assert.match(destination("screen_valuation_model", { model: "valuation_ps" }, {}).link.description, /does not apply the MCP screen/);
});

test("stock comparison links use covered stock identities and disclose the four-instrument limit", () => {
  const coverage = ["AAPL", "MSFT", "GOOGL", "V", "MA"].map(ticker => ({ ticker, identityAvailable: true, quoteType: "EQUITY" }));
  const result = continuationFor("compare_stocks", {}, { coverage });
  assert.equal(new URL(result.url).pathname, "/compare/aapl-vs-msft-vs-googl-vs-v");
  assert.match(result.description, /four instruments/);
  assert.match(result.description, /settings are not carried over/);
  assert.equal(continuationFor("compare_stocks", {}, { coverage: [{ ticker: "SPY", identityAvailable: true, quoteType: "ETF" }] }), null);
  assert.equal(continuationFor("compare_stocks", {}, { coverage: [{ ticker: "UNKNOWN", identityAvailable: false }] }), null);
  const single = continuationFor("compare_stocks", {}, { coverage: coverage.slice(0, 1) });
  assert.equal(new URL(single.url).pathname, "/stocks/AAPL");
});

test("unavailable entities and errors do not gain misleading links", () => {
  for (const name of ["get_etf_snapshot", "get_etf_fund", "get_etf_index_group", "get_macro_history"]) assert.equal(continuationFor(name, { ticker: "UNKNOWN" }, { found: false }), null);
  assert.equal(continuationFor("get_financial_history", { ticker: "UNKNOWN" }, { identity: null, annual: [], quarterly: [] }), null);
  assert.equal(continuationFor("get_company_relationships", { ticker: "UNKNOWN" }, { subject: null, status: "none" }), null);
  assert.equal(continuationFor("get_country_macro", { country: "UNKNOWN" }, { country: "UNKNOWN", coverage: { indicatorsHeld: 0 } }), null);
  assert.equal(continuationFor("get_valuation_model", {}, { results: [{ ticker: "UNKNOWN", scored: false }] }), null);
  const error = { isError: true, content: [{ type: "text", text: "failure" }] };
  assert.equal(withPlatformLink("screen_stocks", {}, error), error);
  const missing = { found: false, webPage: "https://bull-run.org/stocks/UNKNOWN" };
  const cleaned = withPlatformLink("get_valuation_model", {}, { content: [{ type: "text", text: JSON.stringify(missing) }], structuredContent: missing });
  assert.equal(cleaned.structuredContent.webPage, undefined);
});

test("SDK accepts text, structuredContent and resource_link while coverage banners stay first", async () => {
  const server = new McpServer({ name: "platform-link-test", version: "1" });
  addPlatformLinks(server);
  server.registerTool("get_stock_metrics", { description: "A fixture snapshot.", inputSchema: { ticker: z.string() }, outputSchema: { ticker: z.string(), identity: z.record(z.unknown()), warnings: z.array(z.string()) } }, async ({ ticker }) => {
    const payload = { ticker, identity: { ticker }, warnings: ["Partial coverage"] };
    return { content: [{ type: "text", text: "Coverage: matched holdings only." }, { type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "link-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const definitions = await client.listTools();
    assert.match(definitions.tools[0].description, /platformLink/);
    assert.ok(definitions.tools[0].outputSchema.properties.platformLink);
    const result = await client.callTool({ name: "get_stock_metrics", arguments: { ticker: "AAPL" } });
    assert.equal(result.isError, undefined);
    assert.equal(CallToolResultSchema.safeParse(result).success, true);
    assert.equal(result.content[0].text, "Coverage: matched holdings only.");
    const payload = JSON.parse(result.content[1].text);
    assert.deepEqual(payload, result.structuredContent);
    assert.deepEqual(payload.warnings, ["Partial coverage"]);
    assert.equal(payload.webPage, payload.platformLink.url);
    assert.match(result.content[2].text, /^\[Explore AAPL's company research\]\(https:\/\/bull-run.org\/stocks\/AAPL\?/);
    assert.equal(result.content[3].type, "resource_link");
    assert.equal(result.content[3].uri, payload.platformLink.url);
  } finally {
    await client.close();
    await server.close();
  }
});
