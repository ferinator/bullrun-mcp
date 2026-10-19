import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

let upstream;
let registerGetCorporateCalendar;
let runWithAuth;
let capturedCallback;
let mode = "normal";
let requests = [];
let active = 0;
let maxActive = 0;

const earnings = { ticker: "AAA", company: "Company A", currency: "GBX", eventDate: "2026-10-22", timeHint: "bmo",
  epsEstimate: 1.25, revenueEstimate: 2_000_000, marketCapUsd: 50_000_001, source: "yfinance", fetchedAt: "2026-10-17T03:04:05Z" };
const exDividend = { ticker: "BBB", company: "Company B", currency: "EUR", exDate: "2026-10-23", payDate: "2026-11-07",
  amount: 0.5, marketCapUsd: 80_000_000, source: "provider", fetchedAt: "2026-10-16T03:04:05Z" };
const listing = { ticker: "CCC", company: "Company C", currency: "JPY", exchange: "TYO", ipoDate: "2026-09-01", marketCapUsd: null };

function responseFor(url) {
  if (mode === "all-failed") return { status: 503, body: { error: "sensitive upstream detail: internal-host/token" } };
  if (mode === "empty") return { body: [] };
  if (mode === "partial" && url.pathname.endsWith("/earnings")) return { status: 503, body: { error: "sensitive upstream detail: internal-host/token" } };
  if (mode === "invalid" && url.pathname.endsWith("/earnings")) return { body: { secret: "sensitive upstream detail: internal-host/token" } };
  const row = url.pathname.endsWith("/earnings") ? earnings : url.pathname.endsWith("/ex-dividend") ? exDividend : listing;
  if (mode === "huge") return { body: Array.from({ length: 100 }, (_, index) => ({ ...row, ticker: `T${index}`,
    company: 'A"\\'.repeat(200), currency: "GBX", source: 'P"\\'.repeat(100), fetchedAt: "2026-10-17T03:04:05.000000000+00:00" })) };
  if (mode === "invalid-rows") return { body: [row, { ...row, ticker: null }, { ...row, eventDate: "2026-02-31", exDate: "2026-02-31", ipoDate: "2026-02-31" }, null] };
  return { body: [row] };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://upstream.test");
    active++;
    maxActive = Math.max(maxActive, active);
    requests.push(url);
    const requestMode = mode;
    const reply = responseFor(url);
    try {
      await new Promise(resolve => setTimeout(resolve, requestMode === "timeout" && url.pathname.endsWith("/earnings") ? 800 : 10));
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    } finally { active--; }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  process.env.BULLRUN_API_TIMEOUT_MS = "300";
  ({ registerGetCorporateCalendar } = await import("../dist/tools/getCorporateCalendar.js"));
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  registerGetCorporateCalendar({ registerTool(_name, _definition, callback) { capturedCallback = callback; } });
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

function reset(nextMode = "normal") {
  mode = nextMode;
  requests = [];
  maxActive = 0;
}

async function withClient(run) {
  const server = new McpServer({ name: "calendar-test", version: "1" });
  registerGetCorporateCalendar(server);
  const client = new Client({ name: "calendar-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await run(client); }
  finally { await client.close(); await server.close(); }
}

test("SDK defaults serialize all three event kinds, currencies, dates and source metadata faithfully", async () => {
  reset();
  await withClient(async client => {
    const definitions = await client.listTools();
    const definition = definitions.tools.find(tool => tool.name === "get_corporate_calendar");
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.inputSchema.properties.days.maximum, 120);
    assert.equal(definition.inputSchema.properties.listingMonths.maximum, 60);
    assert.equal(definition.inputSchema.properties.limit.maximum, 100);
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(CallToolResultSchema.safeParse(result).success, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const payload = result.structuredContent;
    assert.deepEqual(payload.requestedTypes, ["earnings", "ex_dividend", "listings"]);
    assert.equal(requests.length, 3);
    assert.equal(maxActive, 3);
    assert.ok(requests.every(url => !url.searchParams.has("minCapUsd")), "omitted cap must preserve distinct backend defaults");
    const [e, d, l] = payload.calendars;
    assert.deepEqual(payload.calendars.map(calendar => calendar.minCapUsd), [50_000_000, 50_000_000, 0]);
    assert.equal(e.window.effectiveDays, 14);
    assert.equal(l.window.effectiveMonths, 12);
    assert.equal(e.events[0].kind, "earnings");
    assert.equal(e.events[0].eventDate, earnings.eventDate);
    assert.equal(e.events[0].timeHint, "bmo");
    assert.equal(e.events[0].epsEstimate, 1.25);
    assert.equal(e.events[0].revenueEstimate, 2_000_000);
    assert.equal(e.events[0].quoteCurrency, "GBX", "native minor-unit quote currency must not be converted");
    assert.equal(e.events[0].estimateCurrency, null, "listing currency does not identify earnings-estimate currency");
    assert.equal(e.events[0].source, "yfinance");
    assert.equal(e.events[0].sourceFetchedAt, earnings.fetchedAt);
    assert.equal(d.events[0].kind, "ex_dividend");
    assert.equal(d.events[0].eventDate, exDividend.exDate);
    assert.equal(d.events[0].payDate, exDividend.payDate);
    assert.equal(d.events[0].amountPerShare, 0.5);
    assert.equal(d.events[0].quoteCurrency, "EUR");
    assert.equal(d.events[0].amountCurrency, null);
    assert.equal(l.events[0].kind, "recent_listing");
    assert.equal(l.events[0].firstTradeDate, listing.ipoDate);
    assert.equal(l.events[0].confirmedIpo, null);
    assert.equal(l.events[0].source, null);
    assert.equal(l.events[0].sourceFetchedAt, null);
    assert.equal(l.events[0].marketCapUsd, null);
    assert.match(payload.methodology.listings, /does not confirm an IPO/);
    assert.match(payload.methodology.coverage, /not a complete global event schedule/);
    assert.match(payload.methodology.sources, /retrieval time, not the source refresh time/);
    assert.match(payload.methodology.currencies, /do not assume they equal quoteCurrency/);
  });
});

test("search forwards bounded parameters and discloses backend window widening and contains matching", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: {
      q: "  jp morgan  ", days: 7, listingMonths: 2, minCapUsd: 0, limit: 100,
    } });
    assert.equal(result.structuredContent.query.q, "jp morgan");
    assert.match(result.structuredContent.query.matching, /contains/);
    assert.equal(result.structuredContent.calendars[0].window.requestedDays, 7);
    assert.equal(result.structuredContent.calendars[0].window.effectiveDays, 120);
    assert.equal(result.structuredContent.calendars[0].window.searchWidened, true);
    assert.equal(result.structuredContent.calendars[2].window.requestedMonths, 2);
    assert.equal(result.structuredContent.calendars[2].window.effectiveMonths, 60);
    assert.equal(result.structuredContent.calendars[2].window.searchWidened, true);
    assert.ok(result.structuredContent.warnings.some(warning => /not an exact ticker/.test(warning)));
    assert.ok(requests.every(url => url.searchParams.get("q") === "jp morgan" && url.searchParams.get("limit") === "100"
      && url.searchParams.get("minCapUsd") === "0"));
    assert.equal(requests.find(url => url.pathname.endsWith("/earnings")).searchParams.get("days"), "7");
    assert.equal(requests.find(url => url.pathname.endsWith("/listings")).searchParams.get("months"), "2");
  });
});

test("selected calendar types, duplicate selection and blank search bound fanout", async () => {
  reset();
  await withClient(async client => {
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: {
      include: ["earnings", "earnings"], q: "   ", days: 120, listingMonths: 60, limit: 1, minCapUsd: 90_000_000,
    } });
    assert.deepEqual(result.structuredContent.requestedTypes, ["earnings"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pathname, "/api/calendar/earnings");
    assert.equal(requests[0].searchParams.has("q"), false);
    assert.equal(result.structuredContent.calendars[0].window.effectiveDays, 120);
    assert.equal(result.structuredContent.calendars[0].window.searchWidened, false);
    assert.equal(result.structuredContent.calendars[0].minCapUsd, 90_000_000);
    assert.equal(result.structuredContent.calendars[0].mayBeTruncated, true);
    assert.ok(result.structuredContent.warnings.some(warning => /row limit/.test(warning)));
  });
});

test("invalid windows, limits and types are rejected before backend calls", async () => {
  reset();
  await withClient(async client => {
    for (const args of [
      { days: 0 }, { days: 121 }, { days: 1.5 }, { listingMonths: 0 }, { listingMonths: 61 },
      { limit: 0 }, { limit: 101 }, { minCapUsd: -1 }, { q: "x".repeat(101) },
      { include: [] }, { include: ["ipo"] }, { include: ["earnings", "ex_dividend", "listings", "earnings"] },
    ]) {
      const result = await client.callTool({ name: "get_corporate_calendar", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(requests.length, 0);
  });
});

test("partial and malformed-source failures retain useful events without leaking errors", async () => {
  await withClient(async client => {
    for (const nextMode of ["partial", "invalid"]) {
      reset(nextMode);
      const result = await client.callTool({ name: "get_corporate_calendar", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.calendars[0].status, "unavailable");
      assert.equal(result.structuredContent.calendars[1].events[0].amountPerShare, 0.5);
      assert.equal(JSON.stringify(result).includes("sensitive upstream detail"), false);
      assert.equal(JSON.stringify(result).includes("internal-host"), false);
      assert.equal(requests.length, 3);
    }
  });
});

test("empty and fully unavailable responses are errors with explicit unknown coverage", async () => {
  await withClient(async client => {
    for (const nextMode of ["empty", "all-failed"]) {
      reset(nextMode);
      const result = await client.callTool({ name: "get_corporate_calendar", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.calendars.length, 3);
      assert.ok(result.structuredContent.calendars.every(calendar => calendar.events.length === 0));
      assert.ok(result.structuredContent.warnings.some(warning => /No usable requested/.test(warning)));
      if (nextMode === "empty") {
        assert.ok(result.structuredContent.calendars.every(calendar => calendar.status === "empty"));
        assert.ok(result.structuredContent.warnings.some(warning => /coverage is unknown, not proof/.test(warning)));
      }
      assert.equal(JSON.stringify(result).includes("internal-host"), false);
    }
  });
});

test("malformed rows are omitted while valid date-bearing events remain usable", async () => {
  reset("invalid-rows");
  await withClient(async client => {
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent.calendars.every(calendar => calendar.returnedCount === 1));
    assert.ok(result.structuredContent.warnings.some(warning => /lacked a usable ticker\/date/.test(warning)));
    assert.equal(JSON.stringify(result).includes("2026-02-31"), false);
  });
});

test("large multi-calendar responses fit the marketplace result budget and report truncation", async () => {
  reset("huge");
  await withClient(async client => {
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: { limit: 100 } });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 3);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 200 * 1024);
    assert.ok(result.structuredContent.warnings.some(warning => /response size budget/.test(warning)));
    for (const calendar of result.structuredContent.calendars) {
      assert.ok(calendar.events.length >= 1 && calendar.events.length <= 100);
      assert.equal(calendar.returnedCount, calendar.events.length);
      assert.equal(calendar.mayBeTruncated, true);
      assert.ok(calendar.events.every(event => event.company.length <= 160));
    }
  });
});

test("timeout returns useful partial data within the configured deadline", async () => {
  reset("timeout");
  await withClient(async client => {
    const started = Date.now();
    const result = await client.callTool({ name: "get_corporate_calendar", arguments: {} });
    assert.ok(Date.now() - started < 750);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.calendars[0].status, "unavailable");
    assert.equal(result.structuredContent.calendars[1].status, "available");
  });
  await new Promise(resolve => setTimeout(resolve, 550));
});

test("market-data scope is required before any backend requests", async () => {
  reset();
  const result = await runWithAuth({ token: "fixture", scopes: ["read:portfolios"] }, () => capturedCallback({}));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read:market/);
  assert.equal(requests.length, 0);
});
