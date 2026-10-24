import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";

let upstream;
let runWithAuth;
let definitions = new Map();
let requests = [];
let saved = new Map();
const auth = (userId, scopes = ["read:shortlist", "write:shortlist"]) => ({ token: `user-${userId}`, userId, scopes });
const payload = result => JSON.parse(result.content[0].text);
const call = (name, args = {}, caller) => {
  const { config, handler } = definitions.get(name);
  return runWithAuth(caller, () => handler(z.object(config.inputSchema).parse(args)));
};

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    requests.push({ path: url.pathname, auth: req.headers.authorization, method: req.method });
    const identity = req.headers.authorization;
    const rows = saved.get(identity) ?? [];
    if (req.method === "GET" && url.pathname === "/api/short-list") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
      return;
    }
    const ticker = decodeURIComponent(url.pathname.split("/").at(-1));
    if (ticker === "FAIL") {
      res.writeHead(503).end("private diagnostic at http://internal.example.test");
      return;
    }
    if (!["AAPL", "EUNL.DE"].includes(ticker)) {
      res.writeHead(404).end("unknown ticker");
      return;
    }
    let row = rows.find(row => row.ticker === ticker);
    if (!row) {
      row = { id: rows.length + 1, ticker, company: ticker, addedAt: "2026-10-20T10:00:00Z", lastClose: 10, lastTradeDate: "2026-10-19" };
      rows.push(row);
      saved.set(identity, rows);
    }
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(row));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ runWithAuth } = await import("../dist/auth/context.js"));
  const { registerResearchShortlist } = await import("../dist/tools/researchShortlist.js");
  registerResearchShortlist({ registerTool: (name, config, handler) => definitions.set(name, { config, handler }) });
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});
beforeEach(() => { requests = []; saved = new Map(); });

test("personal shortlist requires identity and explicit read/write consent before any request", async () => {
  for (const [name, args] of [["list_research_shortlist", {}], ["save_research_shortlist", { tickers: ["AAPL"] }]]) {
    for (const caller of [undefined, { token: "missing-user", scopes: ["read:shortlist", "write:shortlist"] }, auth(1, ["read:market", "write:drafts"])]) {
      const reply = await call(name, args, caller);
      assert.equal(reply.isError, true);
      assert.ok(reply.content[0].text.includes("https://bull-run.org/mcp#mcp-connect"));
      assert.ok(!reply.content[0].text.includes("https://mcp.bull-run.org/account/mcp"));
      assert.ok(reply.content[0].text.split(/\s+/).length < 50);
    }
  }
  assert.equal((await call("save_research_shortlist", { tickers: ["AAPL"] }, auth(1, ["read:shortlist"]))).isError, true);
  assert.equal((await call("list_research_shortlist", {}, auth(1, ["write:shortlist"]))).isError, true);
  assert.equal(requests.length, 0);
});

test("exact stock/ETF selections save idempotently and callers retain separate research queues", async () => {
  const save = payload(await call("save_research_shortlist", { tickers: [" aapl ", "AAPL", "EUNL.DE"] }, auth(1)));
  assert.equal(save.savedCount, 2);
  assert.deepEqual(save.requested, ["AAPL", "EUNL.DE"]);
  assert.equal(save.partial, false);
  await call("save_research_shortlist", { tickers: ["AAPL"] }, auth(1));
  assert.equal(payload(await call("list_research_shortlist", {}, auth(1))).count, 2);
  assert.equal(payload(await call("list_research_shortlist", {}, auth(2))).count, 0);
  assert.deepEqual(new Set(requests.map(request => request.auth)), new Set(["Bearer user-1", "Bearer user-2"]));
  assert.ok(requests.every(request => request.path.startsWith("/api/short-list")));
});

test("unknown tickers and upstream outages retain confirmed partial saves and disclose failures", async () => {
  const result = await call("save_research_shortlist", { tickers: ["AAPL", "UNKNOWN", "FAIL"] }, auth(1));
  assert.notEqual(result.isError, true);
  const partial = payload(result);
  assert.equal(partial.partial, true);
  assert.equal(partial.savedCount, 1);
  assert.deepEqual(partial.failures.map(row => row.ticker), ["UNKNOWN", "FAIL"]);
  assert.match(partial.failures[0].message, /404/);
  assert.match(partial.failures[1].message, /503/);
  assert.equal(JSON.stringify(partial).includes("private diagnostic"), false);
  assert.equal(JSON.stringify(partial).includes("internal.example"), false);
  const failed = await call("save_research_shortlist", { tickers: ["UNKNOWN"] }, auth(1));
  assert.equal(failed.isError, true);
  assert.equal(payload(failed).saved, false);
});

test("schema rejects empty selections, overlong batches and URLs before a write", async () => {
  for (const tickers of [[], Array(21).fill("AAPL"), [""], ["https://evil.test/AAPL"], ["AAPL?userId=2"], ["../AAPL"]]) {
    assert.throws(() => call("save_research_shortlist", { tickers }, auth(1)));
  }
  assert.equal(requests.length, 0);
});
