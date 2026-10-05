import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer } from "./generate.js";

const execFileAsync = promisify(execFile);
// Generated servers only answer callers with an access key (see access.ts).
const ACCESS_KEY = "test-access-key-123";
const ACCESS_KEY_SHA256 = createHash("sha256").update(ACCESS_KEY).digest("hex");

const fixture = (name: string) => path.resolve(import.meta.dirname, "../../../fixtures", name);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(port: number, deadline = Date.now() + 10_000): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server on port ${port} never became healthy`);
}

describe("generated server (Streamable HTTP transport)", () => {
  let projectDir: string;
  let mockServer: http.Server;
  let mockBaseUrl: string;
  let serverProcess: ChildProcess;
  let port: number;
  // Stands in for an OpenTelemetry collector: keeps what the server exports.
  let collector: http.Server;
  const exported: Array<{ authorization: string | undefined; body: any }> = [];

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: 1, name: "Rex", tag: "dog" }]));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    mockBaseUrl = `http://localhost:${(mockServer.address() as AddressInfo).port}`;

    collector = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.url === "/v1/traces") exported.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, resolve));

    projectDir = await mkdtemp(path.join(tmpdir(), "mcp-gen-http-e2e-"));
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const tools = designTools(document!).filter((t) => t.name === "pets.list");
    await generateServer({ document: document!, tools, outDir: projectDir });

    await execFileAsync("npm", ["install"], { cwd: projectDir });
    await execFileAsync("npm", ["run", "build"], { cwd: projectDir });

    port = await getFreePort();
    serverProcess = spawn("node", ["dist/server.js"], {
      cwd: projectDir,
      env: {
        ...process.env,
        MCP_TRANSPORT: "http",
        PORT: String(port),
        SWAGGER_PETSTORE_BASE_URL: mockBaseUrl,
        MCP_ACCESS_KEY_SHA256: ACCESS_KEY_SHA256,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${(collector.address() as AddressInfo).port}`,
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20collector-token",
      },
      stdio: "ignore",
    });

    await waitForHealth(port);
  }, 120_000);

  afterAll(async () => {
    serverProcess?.kill();
    await new Promise((resolve) => mockServer?.close(resolve));
    await new Promise((resolve) => collector?.close(resolve));
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("serves GET /health", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects GET /mcp with a JSON-RPC method-not-allowed error", async () => {
    const res = await fetch(`http://localhost:${port}/mcp`);
    expect(res.status).toBe(405);
  });

  it("rejects MCP requests without a valid access key", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const missing = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers, body });
    expect(missing.status).toBe(401);
    const wrong = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
    expect(wrong.status).toBe(401);
  });

  it("serves MCP tools/list and tools/call over Streamable HTTP", async () => {
    const client = new Client({ name: "http-e2e-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ACCESS_KEY}` } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["pets.list"]);

    const result = await client.callTool({ name: "pets.list", arguments: {} });
    expect(result.isError).toBe(false);
    expect((result.content as Array<{ text?: string }>)[0].text).toContain("Rex");

    await client.close();
  });

  it("exports each tool call as an OpenTelemetry span: tool, caller and outcome, but no arguments or key", async () => {
    exported.length = 0;
    const client = new Client({ name: "http-e2e-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ACCESS_KEY}` } },
    });
    await client.connect(transport);
    await client.callTool({ name: "pets.list", arguments: { limit: 7 } });
    await client.callTool({ name: "pets.list", arguments: { limit: "not a number" } });
    await client.close();

    expect(exported).toHaveLength(2);
    expect(exported[0].authorization).toBe("Bearer collector-token");
    const spans = exported.map((e) => e.body.resourceSpans[0].scopeSpans[0].spans[0]);
    const attrs = (span: any) =>
      Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.boolValue]));

    expect(spans[0].name).toBe("tools/call pets.list");
    expect(spans[0].status.code).toBe(1);
    expect(attrs(spans[0])).toMatchObject({
      "gen_ai.tool.name": "pets.list",
      "mcp.caller.kind": "key",
      "enduser.id": ACCESS_KEY_SHA256.slice(0, 12),
      "http.response.status_code": "200",
    });
    expect(BigInt(spans[0].endTimeUnixNano) >= BigInt(spans[0].startTimeUnixNano)).toBe(true);

    expect(spans[1].status.code).toBe(2);
    expect(attrs(spans[1])["error.type"]).toBe("invalid_input");

    const everything = JSON.stringify(exported.map((e) => e.body));
    expect(everything).not.toContain(ACCESS_KEY);
    expect(everything).not.toContain("not a number");
  });
});
