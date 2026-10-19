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
    for (const name of ["search_stocks", "screen_stock_presets", "find_stock_peers", "get_stock_price_history", "get_company_news", "get_company_data_coverage", "compare_stocks"]) {
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
