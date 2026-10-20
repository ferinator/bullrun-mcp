import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcpServer.js";

async function withClient(run) {
  const server = createMcpServer();
  const client = new Client({ name: "research-workflow-contract-check", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

const body = result => result.messages.map(message => message.content.text ?? "").join("\n");

test("ML candidate workflow routes each basis to its supported annual model and bounds follow-up research", async () => {
  await withClient(async client => {
    const tools = (await client.listTools()).tools;
    const modelTool = tools.find(tool => tool.name === "screen_valuation_model");
    const models = modelTool.inputSchema.properties.model.enum;
    for (const [basis, expected] of [[undefined, "valuation_annual_1y"], ["forecast", "forecast_annual_1y"]]) {
      const result = await client.getPrompt({ name: "find_ml_candidates", arguments: { country: "Germany", ...(basis ? { basis } : {}) } });
      assert.ok(models.includes(expected));
      assert.match(body(result), new RegExp(`model="${expected}"`));
      assert.match(body(result), /limit=5/);
      assert.match(body(result), /at most three/);
      assert.match(body(result), /For one match use get_stock_metrics/);
      assert.match(body(result), /Do not save a shortlist or create a portfolio unless I explicitly/);
      assert.match(body(result), /not an expected return or buy signal/);
      assert.equal(result.messages[0].role, "user");
    }
    await assert.rejects(client.getPrompt({ name: "find_ml_candidates", arguments: { basis: "guaranteed_return" } }));
    await assert.rejects(client.getPrompt({ name: "find_ml_candidates", arguments: { country: "x".repeat(101) } }));
  });
});

test("UCITS workflow uses discoverable keys, valid comparison modules and explicit cost assumptions", async () => {
  await withClient(async client => {
    const tools = (await client.listTools()).tools;
    const comparison = tools.find(tool => tool.name === "compare_etfs");
    const allowed = comparison.inputSchema.properties.include.items.enum;
    assert.ok(allowed.includes("costs") && allowed.includes("overlap"));
    const text = body(await client.getPrompt({ name: "compare_ucits_costs", arguments: { index: "MSCI World", payout: "accumulating" } }));
    assert.match(text, /MSCI World/);
    assert.match(text, /never guess a key/);
    assert.match(text, /one listing per distinct fund ISIN/);
    assert.match(text, /partial holdings is a lower bound/);
    assert.match(text, /only if I supply an investment amount/);
    await assert.rejects(client.getPrompt({ name: "compare_ucits_costs", arguments: {} }));
    await assert.rejects(client.getPrompt({ name: "compare_ucits_costs", arguments: { index: "SP500", payout: "unknown" } }));
  });
});

test("saved shortlist briefing references available account tools and does not schedule or mutate", async () => {
  await withClient(async client => {
    const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
    const text = body(await client.getPrompt({ name: "research_shortlist_briefing", arguments: { focus: "ETF costs" } }));
    for (const name of ["list_research_shortlist", "save_research_shortlist", "compare_stocks", "compare_etfs", "get_company_news"]) {
      assert.ok(tools.has(name), `${name} referenced by briefing is absent`);
      assert.ok(text.includes(name));
    }
    assert.match(text, /https:\/\/mcp\.bull-run\.org\/account\/mcp/);
    assert.match(text, /up to five entries/);
    assert.match(text, /at most three selected equities/);
    assert.match(text, /Do not add\/remove entries, create a portfolio, schedule monitoring or send notifications/);
    assert.match(text, /do not pretend an empty response means/);
  });
});
