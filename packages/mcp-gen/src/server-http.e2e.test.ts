import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
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

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: 1, name: "Rex", tag: "dog" }]));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    mockBaseUrl = `http://localhost:${(mockServer.address() as AddressInfo).port}`;

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
      },
      stdio: "ignore",
    });

    await waitForHealth(port);
  }, 120_000);

  afterAll(async () => {
    serverProcess?.kill();
    await new Promise((resolve) => mockServer?.close(resolve));
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

  it("serves MCP tools/list and tools/call over Streamable HTTP", async () => {
    const client = new Client({ name: "http-e2e-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["pets.list"]);

    const result = await client.callTool({ name: "pets.list", arguments: {} });
    expect(result.isError).toBe(false);
    expect((result.content as Array<{ text?: string }>)[0].text).toContain("Rex");

    await client.close();
  });
});
