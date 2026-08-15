import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  env: {
    ...process.env,
    BULLRUN_API_BASE: "https://bull-run.org",
  },
  stderr: "pipe",
});
const client = new Client({ name: "bullrun-mcp-stdio-test", version: "0.0.0" });

await client.connect(transport);
const { tools } = await client.listTools();
const names = new Set(tools.map((tool) => tool.name));
const expected = [
  "search_etfs",
  "get_etf_snapshot",
  "get_etf_timeseries",
  "get_etf_holdings",
  "get_etf_exposures",
  "get_etf_risk",
  "compare_etfs",
  "analyze_etf_overlap",
  "analyze_portfolio_fit",
  "simulate_etf_cost",
];
const missing = expected.filter((name) => !names.has(name));

if (missing.length) {
  await client.close();
  console.error(`FAIL  stdio tools/list missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`PASS  stdio tools/list -> ${expected.length} ETF tools registered`);

if (process.env.MCP_LIVE_TEST === "1") {
  const result = await client.callTool({
    name: "search_etfs",
    arguments: { search: "SPY", indexKey: "SP500", limit: 3 },
  });
  const payload = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
  if (result.isError || !payload.results?.some((row) => row.ticker === "SPY" && row.indexKey === "SP500")) {
    await client.close();
    console.error(`FAIL  live stdio search_etfs contract: ${JSON.stringify(payload).slice(0, 500)}`);
    process.exit(1);
  }
  console.log("PASS  live stdio search_etfs -> production API contract");
}

await client.close();
