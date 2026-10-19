import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Directory builds use the same catalog as the hosted service. Set the public
// API default before importing modules whose configuration is read at load time.
process.env.BULLRUN_API_BASE ??= "https://bull-run.org";
const { createMcpServer } = await import("./mcpServer.js");
await createMcpServer().connect(new StdioServerTransport());
