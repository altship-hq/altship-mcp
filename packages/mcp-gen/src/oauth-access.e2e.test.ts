import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
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

// OAuth sign-in: the server accepts tokens from its issuer only for the
// subjects in MCP_OAUTH_ALLOWED_SUBJECTS (a private server's owner and the
// people they've added).
describe("generated server (OAuth sign-in, allowed subjects)", () => {
  let projectDir: string;
  let issuerServer: http.Server;
  let issuer: string;
  let serverProcess: ChildProcess;
  let port: number;
  let sign: (subject: string, tokenIssuer?: string) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256", use: "sig" };
    issuerServer = http.createServer((req, res) => {
      if (req.url !== "/.well-known/jwks.json") return res.writeHead(404).end();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => issuerServer.listen(0, resolve));
    issuer = `http://localhost:${(issuerServer.address() as AddressInfo).port}`;
    sign = (subject, tokenIssuer = issuer) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .setIssuer(tokenIssuer)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    projectDir = await mkdtemp(path.join(tmpdir(), "mcp-gen-oauth-e2e-"));
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
        SWAGGER_PETSTORE_BASE_URL: "http://localhost:9",
        MCP_OAUTH_ISSUER: issuer,
        MCP_OAUTH_ALLOWED_SUBJECTS: "owner-id,member-id",
      },
      stdio: "ignore",
    });

    await waitForHealth(port);
  }, 120_000);

  afterAll(async () => {
    serverProcess?.kill();
    await new Promise((resolve) => issuerServer?.close(resolve));
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  async function listTools(token: string): Promise<Response> {
    return fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }

  it("accepts the owner and each added person", async () => {
    expect((await listTools(await sign("owner-id"))).status).toBe(200);
    expect((await listTools(await sign("member-id"))).status).toBe(200);
  });

  it("rejects a signed-in user who isn't on the list, pointing them at sign-in", async () => {
    const res = await listTools(await sign("stranger-id"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("rejects an allowed subject's token from another issuer", async () => {
    expect((await listTools(await sign("owner-id", "http://localhost:1"))).status).toBe(401);
  });
});
