// What an agent types vs how Bullrun stores the ticker. Tokyo is mostly NNNN.T but a
// few majors are bare codes (Toyota 7203); Europe is bare (BMW); Hong Kong is padded
// (0700.HK). Resolution must follow the stored form and never guess between listings.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

const STORED = {
  "6324.T": { ticker: "6324.T", company: "Harmonic Drive Systems Inc.", exchange: "TSE", country: "Japan" },
  "7203": { ticker: "7203", company: "Toyota Motor Corporation", exchange: "TSE", country: "Japan" },
  "2050.T": { ticker: "2050.T", company: "Some Tokyo Co", exchange: "TSE", country: "Japan" },
  "2050.HK": { ticker: "2050.HK", company: "Zhejiang Sanhua", exchange: "HK", country: "China" },
  "0700.HK": { ticker: "0700.HK", company: "Tencent Holdings Limited", exchange: null, country: "China" },
  "BMW": { ticker: "BMW", company: "Bayerische Motoren Werke", exchange: "XETRA", country: "Germany" },
  "ABC": { ticker: "ABC", company: "A US Company", exchange: "NASDAQ", country: "United States" },
  "OLD": { ticker: "NEW", company: "Renamed Co", exchange: "NYSE", country: "United States" },
};

let upstream;
let resolveStockTicker;
let mode = "normal";

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const ticker = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (mode === "down") return send(503, { error: "unavailable" });
    if (mode === "quota") return send(429, { error: "quota_exceeded" });
    if (url.pathname.startsWith("/api/stocks/") && STORED[ticker]) return send(200, STORED[ticker]);
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.BULLRUN_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  ({ resolveStockTicker } = await import("../dist/tools/stockIdentity.js"));
});

after(() => upstream.close());

test("a stored ticker resolves to itself", async () => {
  const r = await resolveStockTicker("7203");
  assert.equal(r.ticker, "7203");
  assert.equal(r.note, null);
});

test("a bare Tokyo code resolves to its only suffixed listing", async () => {
  const r = await resolveStockTicker("6324");
  assert.equal(r.ticker, "6324.T");
  assert.match(r.note, /6324 resolved to 6324\.T/);
});

test("a code stored under two markets is returned as candidates, not guessed", async () => {
  const r = await resolveStockTicker("2050");
  assert.equal(r.ticker, null);
  assert.deepEqual(r.candidates.map((s) => s.ticker).sort(), ["2050.HK", "2050.T"]);
});

test("an unpadded Hong Kong code is padded", async () => {
  assert.equal((await resolveStockTicker("700")).ticker, "0700.HK");
  assert.equal((await resolveStockTicker("700.HK")).ticker, "0700.HK");
});

test("a Yahoo suffix on a bare-stored listing resolves only when the venue agrees", async () => {
  assert.equal((await resolveStockTicker("7203.T")).ticker, "7203");
  assert.equal((await resolveStockTicker("BMW.DE")).ticker, "BMW");
  // ABC is a NASDAQ line: ABC.L must not become it.
  const london = await resolveStockTicker("ABC.L");
  assert.equal(london.ticker, null);
  assert.deepEqual(london.candidates, []);
});

test("a retired ticker resolves to its survivor and says so", async () => {
  const r = await resolveStockTicker("old");
  assert.equal(r.ticker, "NEW");
  assert.match(r.note, /retired ticker/);
});

test("an outage or quota error is reported, never read as not covered", async () => {
  mode = "down";
  await assert.rejects(resolveStockTicker("6324"), /not reachable right now.*not a coverage answer/);
  mode = "quota";
  await assert.rejects(resolveStockTicker("6324"), /quota.*not a coverage answer/);
  mode = "normal";
});
