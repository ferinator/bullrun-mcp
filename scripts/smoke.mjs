/**
 * End-to-end smoke test: connect to a running bullrun-mcp over Streamable HTTP
 * using the real MCP client, list tools, and call each one. This is the same
 * handshake the MCP Inspector and Claude's custom connector perform.
 *
 *   node scripts/smoke.mjs                                  # public tools, http://localhost:8091/mcp
 *   MCP_URL=https://mcp.bull-run.org/mcp node scripts/smoke.mjs
 *   MCP_TOKEN=<access-token> node scripts/smoke.mjs         # also exercise the per-user tools
 *   MCP_TOKEN=<token> SMOKE_DRAFT=1 node scripts/smoke.mjs  # also create a portfolio draft (Pro)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8091/mcp";
const token = process.env.MCP_TOKEN;

const transport = new StreamableHTTPClientTransport(
  new URL(url),
  token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
);
const client = new Client({ name: "bullrun-mcp-smoke", version: "0.0.0" });

await client.connect(transport);
console.log(`connected to ${url}${token ? " (authenticated)" : " (anonymous)"}`);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

const text = (r) => r.content?.[0]?.text ?? JSON.stringify(r);

const screen = await client.callTool({
  name: "screen_stocks",
  arguments: { sector: "Technology", limit: 3, minMarketCap: 1e11, sortBy: "marketCap" },
});
console.log("\n--- screen_stocks(Technology, top 3 by market cap) ---");
console.log(text(screen).slice(0, 900));

const metrics = await client.callTool({
  name: "get_stock_metrics",
  arguments: { ticker: process.env.SMOKE_TICKER ?? "AAPL" },
});
console.log("\n--- get_stock_metrics ---");
console.log(text(metrics).slice(0, 1100));

const history = await client.callTool({
  name: "get_financial_history",
  arguments: { ticker: process.env.SMOKE_TICKER ?? "AAPL", periodType: "annual", years: 5 },
});
console.log("\n--- get_financial_history(annual, 5y) ---");
console.log(text(history).slice(0, 1400));

// Per-user tools need an OAuth access token; only run them when one is supplied.
if (token) {
  const list = await client.callTool({ name: "list_portfolios", arguments: {} });
  console.log("\n--- list_portfolios ---");
  console.log(text(list).slice(0, 900));

  let firstId = null;
  try {
    firstId = JSON.parse(list.content?.[0]?.text ?? "{}").portfolios?.[0]?.id ?? null;
  } catch { /* leave null */ }

  if (firstId != null) {
    const ctx = await client.callTool({ name: "get_portfolio_context", arguments: { portfolioId: firstId } });
    console.log(`\n--- get_portfolio_context(${firstId}) ---`);
    console.log(text(ctx).slice(0, 1200));
  }

  if (process.env.SMOKE_DRAFT === "1") {
    const draft = await client.callTool({
      name: "create_portfolio_draft",
      arguments: { prompt: process.env.SMOKE_DRAFT_PROMPT ?? "a diversified large-cap dividend portfolio", maxPositions: 6 },
    });
    console.log("\n--- create_portfolio_draft ---");
    console.log(text(draft).slice(0, 1200));
  }
}

await client.close();
console.log("\nOK");
