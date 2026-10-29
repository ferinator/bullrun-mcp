import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer as ModernMcpServer, type ServerContext, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createMcpServer, type McpServerOptions } from "./mcpServer.js";

/**
 * The catalog's Zod 3 validators remain authoritative during the SDK migration.
 * Standard Schema keeps their defaults/refinements, while JSON Schema advertises
 * the same inputs to v2. No v1 protocol or transport objects enter the v2 server.
 */
export function standardSchema(schemaOrShape: unknown): StandardSchemaWithJSON {
  const schema = schemaOrShape instanceof z.ZodType
    ? schemaOrShape : z.object(schemaOrShape as z.ZodRawShape);
  let json: Record<string, unknown> | undefined;
  const jsonSchema = () => json ??= zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "bullrun-zod3",
      validate: async (value) => {
        const result = await schema.safeParseAsync(value);
        return result.success ? { value: result.data } : { issues: result.error.issues };
      },
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  };
}

type Registration = (name: string, config: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => unknown;
type ClientIdentity = { name: string; version: string };
const requestClient = new AsyncLocalStorage<ClientIdentity | undefined>();

function clientIdentity(ctx: ServerContext): ClientIdentity | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = envelope?.["io.modelcontextprotocol/clientInfo"];
  if (info && typeof info === "object" && "name" in info && typeof info.name === "string"
      && "version" in info && typeof info.version === "string") return { name: info.name, version: info.version };
  return undefined;
}

/** Register one shared catalog on the current SDK, including its accounting wrappers. */
export function createModernMcpServer(options: McpServerOptions = {}): ModernMcpServer {
  let modern: ModernMcpServer | undefined;
  createMcpServer(options, (identity, serverOptions) => {
    modern = new ModernMcpServer(identity, serverOptions);
    const server = modern;
    const getClientVersion = server.server.getClientVersion.bind(server.server);
    server.server.getClientVersion = () => requestClient.getStore() ?? getClientVersion();
    for (const [method, schemaKeys] of [["registerTool", ["inputSchema", "outputSchema"]],
      ["registerPrompt", ["argsSchema"]]] as const) {
      const register = server[method].bind(server) as unknown as Registration;
      const adapted: Registration = (name, config, callback) => {
        const converted = { ...config };
        for (const key of schemaKeys) if (config[key] !== undefined) converted[key] = standardSchema(config[key]);
        return register(name, converted, (...args: unknown[]) => {
          const ctx = args[args.length - 1] as ServerContext;
          return requestClient.run(clientIdentity(ctx), () => callback(...args));
        });
      };
      // The facade only adapts registration. connect/dispatch always use the real v2 instance.
      (server as unknown as Record<string, unknown>)[method] = adapted;
    }
    return server as unknown as LegacyMcpServer;
  });
  if (!modern) throw new Error("MCP catalog did not construct its server");
  return modern;
}
