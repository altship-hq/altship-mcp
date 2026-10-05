import { Router, type Request } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { oauthIssuer } from "../access-keys.js";
import { getDeploymentById, insertToolCalls, type DeploymentRecord } from "../store.js";
import { ACCESS_KEY_HEADER, memoryCaller, type MemoryCaller } from "./access.js";
import { MemoryError } from "./records.js";
import { MEMORY_TOOLS, collectionsOf, invalidInput, storeInstructions } from "./tools.js";

// Serves memory stores over MCP at <API_PUBLIC_URL>/memory/<id>/api/mcp: the
// same shape of address as a generated server, so everything that works with
// one (chat apps, Agent Creator, the dashboard's connect panel) works with
// these. Public; each request is checked by memory/access.ts.

export const memoryRouter = Router();

/** This API's public origin, where chat apps are sent to discover how to sign in. */
function origin(req: Request): string {
  return process.env.API_PUBLIC_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
}

async function memoryStore(id: string): Promise<DeploymentRecord | null> {
  const store = await getDeploymentById(id);
  return store?.kind === "memory" ? store : null;
}

// RFC 9728 protected-resource metadata: tells MCP clients where to sign in.
memoryRouter.get("/.well-known/oauth-protected-resource/memory/:id/api/mcp", async (req, res) => {
  if (!(await memoryStore(String(req.params.id)))) return res.status(404).end();
  res.json({
    resource: `${origin(req)}/memory/${req.params.id}/api/mcp`,
    authorization_servers: [oauthIssuer()],
    bearer_methods_supported: ["header"],
  });
});

/** Records a tool call for Observability: who, which tool, how it went and how long. Never the note's contents. */
async function record(store: DeploymentRecord, caller: MemoryCaller, tool: string, startedAt: number, errorType: string | null) {
  try {
    await insertToolCalls(store.id, [
      {
        startedAt: new Date(startedAt).toISOString(),
        tool: tool.slice(0, 200),
        ok: errorType === null,
        errorType,
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        callerKind: caller.kind,
        callerId: caller.id,
        traceId: null,
        spanId: null,
      },
    ]);
  } catch (err) {
    console.error("Couldn't record a memory tool call:", err instanceof Error ? err.message : "unknown error");
  }
}

function mcpServer(store: DeploymentRecord, caller: MemoryCaller, instructions: string): Server {
  const server = new Server({ name: store.projectName, version: "0.1.0" }, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MEMORY_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    const finish = async (text: string, errorType: string | null) => {
      await record(store, caller, String(name), startedAt, errorType);
      return { content: [{ type: "text" as const, text }], isError: errorType !== null };
    };

    const tool = MEMORY_TOOLS.find((t) => t.name === name);
    if (!tool) return finish(`Unknown tool: ${name}`, "unknown_tool");
    const problem = invalidInput(tool.name, args);
    if (problem) return finish(`Invalid input: ${problem}`, "invalid_input");

    try {
      return await finish(JSON.stringify(await tool.run(store, (args ?? {}) as Record<string, unknown>), null, 2), null);
    } catch (err) {
      // Only messages written for the caller are passed on; anything else stays in our logs.
      if (err instanceof MemoryError) return finish(err.message, "invalid_input");
      console.error("Memory tool failed:", err instanceof Error ? err.message : "unknown error");
      return finish("The memory store couldn't complete that. Try again.", "request_failed");
    }
  });

  return server;
}

memoryRouter.all("/memory/:id/api/mcp", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  }
  const store = await memoryStore(String(req.params.id));
  const caller = store && (await memoryCaller(store, { authorization: req.header("authorization"), accessKey: req.header(ACCESS_KEY_HEADER) }));
  if (!store || !caller) {
    // The same answer whether the store doesn't exist or the caller isn't allowed in.
    res.setHeader("www-authenticate", `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource/memory/${req.params.id}/api/mcp"`);
    return res
      .status(401)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid access key or token. Send it as Authorization: Bearer <key>." }, id: null });
  }

  const server = mcpServer(store, caller, storeInstructions(store, await collectionsOf(store)));
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling memory MCP request:", err instanceof Error ? err.message : "unknown error");
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
