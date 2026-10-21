#!/usr/bin/env node
/** Live check of the public research catalog: every listed tool once, with its example call.
 * node scripts/check-research-catalog.mjs --endpoint https://mcp.bull-run.org/research/mcp
 * Optional: --only tool_a,tool_b   --pace-ms 4000   --max-bytes 102400
 * Exits nonzero when the catalog differs from the examples, a tool lacks its annotations,
 * or any call errors or returns more than --max-bytes of JSON.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESEARCH_EXAMPLES } from "./research-examples.mjs";

const TIMEOUT_MS = 60_000;
// Not a probe name: probes share one small pool, this run is charged to the caller's address.
const CLIENT_NAME = "bullrun-directory-check";

function options(args) {
  const config = { paceMs: 4000, maxBytes: 100 * 1024, only: null, endpoint: null };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === "--endpoint") config.endpoint = new URL(value);
    else if (flag === "--only") config.only = new Set(value.split(","));
    else if (flag === "--pace-ms") config.paceMs = Number(value);
    else if (flag === "--max-bytes") config.maxBytes = Number(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!config.endpoint) throw new Error("Usage: --endpoint https://mcp.bull-run.org/research/mcp");
  if (config.endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(config.endpoint.hostname)) {
    throw new Error("Use HTTPS or a loopback endpoint.");
  }
  return config;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstText = result => result.content?.find(block => block.type === "text")?.text ?? "";

async function run(config) {
  const transport = new StreamableHTTPClientTransport(config.endpoint, {
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  const problems = [];
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    const { tools } = await client.listTools({}, { timeout: TIMEOUT_MS });
    const listed = new Set(tools.map(tool => tool.name));
    const examples = new Set(RESEARCH_EXAMPLES.map(example => example.tool));
    const unlisted = [...examples].filter(name => !listed.has(name));
    const untested = [...listed].filter(name => !examples.has(name));
    if (unlisted.length || untested.length) problems.push({ check: "catalog", unlisted, untested });
    for (const tool of tools) {
      if (!tool.title && !tool.annotations?.title) problems.push({ check: "title", tool: tool.name });
      if (tool.annotations?.readOnlyHint !== true) problems.push({ check: "readOnlyHint", tool: tool.name });
    }
    console.log(JSON.stringify({ check: "catalog", server: client.getServerVersion(), tools: tools.length,
      instructionsChars: client.getInstructions()?.length ?? 0, unlisted, untested }));

    for (const example of RESEARCH_EXAMPLES) {
      if (config.only && !config.only.has(example.tool)) continue;
      if (!listed.has(example.tool)) continue;
      const started = Date.now();
      let row;
      try {
        const result = await client.callTool({ name: example.tool, arguments: example.args }, CallToolResultSchema, { timeout: TIMEOUT_MS });
        const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        row = { tool: example.tool, status: result.isError ? "error" : bytes > config.maxBytes ? "oversized" : "pass",
          bytes, elapsedMs: Date.now() - started,
          ...(result.isError ? { message: firstText(result).slice(0, 300) } : {}),
          platformLink: result.structuredContent?.platformLink?.url ?? null };
      } catch (error) {
        row = { tool: example.tool, status: "throw", elapsedMs: Date.now() - started, message: String(error?.message ?? error).slice(0, 300) };
      }
      if (row.status !== "pass") problems.push(row);
      console.log(JSON.stringify(row));
      await sleep(config.paceMs);
    }
  } finally {
    await client.close().catch(() => {});
  }
  console.log(JSON.stringify({ check: "summary", status: problems.length ? "fail" : "pass", problems }));
  return problems.length ? 1 : 0;
}

try {
  process.exitCode = await run(options(process.argv.slice(2)));
} catch (error) {
  console.log(JSON.stringify({ check: "summary", status: "fail", reason: String(error?.message ?? error).slice(0, 300) }));
  process.exitCode = 1;
}
