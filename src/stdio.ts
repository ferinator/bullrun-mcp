import { serveStdio } from "@modelcontextprotocol/server/stdio";

// Directory builds use the same catalog as the hosted service. Set the public
// API default before importing modules whose configuration is read at load time.
process.env.BULLRUN_API_BASE ??= "https://bull-run.org";
const { createModernMcpServer } = await import("./sdkV2.js");
serveStdio(() => createModernMcpServer({ legacyTools: process.argv.includes("--legacy-tools") }));
