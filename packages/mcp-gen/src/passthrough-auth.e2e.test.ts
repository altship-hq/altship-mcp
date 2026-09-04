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
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server on port ${port} never became healthy`);
}

describe("passthrough auth (caller's own bearer token relayed upstream)", () => {
  let projectDir: string;
  let mockServer: http.Server;
  let receivedAuthHeaders: (string | undefined)[];
  let mockBaseUrl: string;
  let serverProcess: ChildProcess;
  let port: number;

  beforeAll(async () => {
    receivedAuthHeaders = [];
    mockServer = http.createServer((req, res) => {
      receivedAuthHeaders.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ paymentId: "pay_1", status: "captured" }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    mockBaseUrl = `http://localhost:${(mockServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "mcp-gen-passthrough-e2e-"));
    const { document } = await validateSpec(fixture("payments.yaml"));
    document!.components = {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    };
    document!.security = [{ bearerAuth: [] }];

    const tools = designTools(document!).filter((t) => t.name === "payments.get");
    await generateServer({ document: document!, tools, outDir: projectDir, authMode: "passthrough" });

    await execFileAsync("npm", ["install"], { cwd: projectDir });
    await execFileAsync("npm", ["run", "build"], { cwd: projectDir });

    port = await getFreePort();
    serverProcess = spawn("node", ["dist/server.js"], {
      cwd: projectDir,
      env: {
        ...process.env,
        MCP_TRANSPORT: "http",
        PORT: String(port),
        PAYMENTS_API_BASE_URL: mockBaseUrl,
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

  it("relays the calling client's own bearer token to the upstream API", async () => {
    const client = new Client({ name: "passthrough-e2e-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer end-user-token-abc123" } },
    });
    await client.connect(transport);

    const result = await client.callTool({ name: "payments.get", arguments: { payment_id: "pay_1" } });
    expect(result.isError).toBe(false);
    expect(receivedAuthHeaders).toContain("Bearer end-user-token-abc123");

    await client.close();
  });

  it("fails cleanly (not a crash) when the caller sends no token", async () => {
    const client = new Client({ name: "passthrough-e2e-test-notoken", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: "payments.get", arguments: { payment_id: "pay_1" } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0].text).toContain("caller's own bearer token");

    await client.close();
  });
});
