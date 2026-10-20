import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcpServer.js";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const registry = JSON.parse(await readFile(new URL("server.json", root), "utf8"));

test("release metadata, directory stdio and hosted factory expose the same catalog", async () => {
  assert.equal(registry.version, manifest.version);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const hosted = createMcpServer();
  const hostedClient = new Client({ name: "release-catalog-check", version: "1.0.0" });
  const directoryClient = new Client({ name: "directory-catalog-check", version: "1.0.0" });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("dist/stdio.js", root))],
    stderr: "pipe",
  });
  try {
    await hosted.connect(serverSide);
    await hostedClient.connect(clientSide);
    await directoryClient.connect(stdio);
    assert.equal(hostedClient.getServerVersion()?.version, manifest.version);
    assert.equal(directoryClient.getServerVersion()?.version, manifest.version);
    const hostedTools = (await hostedClient.listTools()).tools.map(tool => tool.name).sort();
    const directoryTools = (await directoryClient.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(directoryTools, hostedTools);
    assert.equal(new Set(hostedTools).size, hostedTools.length);
    assert.equal(hostedTools.length, 48);
    for (const name of ["screen_stock_presets", "analyze_etf_overlap", "analyze_portfolio_fit", "query_etfs"]) {
      assert.equal(hostedTools.includes(name), false, `${name} belongs only to the legacy catalog`);
    }
    for (const name of ["search_stocks", "screen_stocks", "find_stock_peers", "get_stock_price_history", "get_company_news", "get_company_data_coverage", "compare_stocks"]) {
      assert.ok(hostedTools.includes(name), `${name} is missing from the release`);
    }
    const readme = await readFile(new URL("PUBLIC_README.md", root), "utf8")
      .catch(() => readFile(new URL("README.md", root), "utf8"));
    for (const name of hostedTools) assert.ok(readme.includes(`\`${name}\``), `${name} missing from public documentation`);
    console.log(`Validated ${hostedTools.length} tools at v${manifest.version} across hosted and directory transports.`);
  } finally {
    await Promise.allSettled([directoryClient.close(), hostedClient.close(), hosted.close()]);
  }
});

test("legacy aliases are opt-in and research catalogs keep personal tools excluded", async () => {
  for (const [options, expectedCount] of [
    [{ legacyTools: true }, 52],
    [{ researchOnly: true }, 39],
    [{ researchOnly: true, legacyTools: true }, 42],
  ]) {
    const server = createMcpServer(options);
    const client = new Client({ name: "catalog-boundaries", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverSide);
      await client.connect(clientSide);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.equal(names.length, expectedCount);
      assert.equal(names.includes("query_etfs"), options.legacyTools === true);
      assert.equal(names.includes("screen_stock_presets"), options.legacyTools === true);
      assert.equal(names.includes("analyze_etf_overlap"), options.legacyTools === true);
      assert.equal(names.includes("analyze_portfolio_fit"), options.legacyTools === true && !options.researchOnly);
      if (options.researchOnly) {
        for (const name of ["get_portfolio_analytics", "list_portfolios", "get_capabilities", "create_portfolio_draft", "save_research_shortlist", "list_research_shortlist"]) {
          assert.equal(names.includes(name), false);
        }
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  }
});
