import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer } from "@altship/mcp-gen";
import { PlaygroundSession } from "./session.js";

const execFileAsync = promisify(execFile);
const fixture = (name: string) => path.resolve(import.meta.dirname, "../../../fixtures", name);

describe("PlaygroundSession (end-to-end against a generated server)", () => {
  let projectDir: string;
  let mockServer: http.Server;
  let mockBaseUrl: string;
  let session: PlaygroundSession;

  beforeAll(async () => {
    // A tiny stand-in for the real Petstore API so this test doesn't depend
    // on network access or an actual upstream service.
    mockServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/pets") {
        res.end(JSON.stringify([{ id: 1, name: "Rex", tag: "dog" }]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, message: "not found" }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    mockBaseUrl = `http://localhost:${(mockServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "playground-e2e-"));
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const tools = designTools(document!);
    await generateServer({ document: document!, tools, outDir: projectDir });

    await execFileAsync("npm", ["install"], { cwd: projectDir });
    await execFileAsync("npm", ["run", "build"], { cwd: projectDir });

    session = await PlaygroundSession.connect({
      command: "node",
      args: ["dist/server.js"],
      cwd: projectDir,
      env: { SWAGGER_PETSTORE_BASE_URL: mockBaseUrl },
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await new Promise((resolve) => mockServer?.close(resolve));
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("lists the generated tools", async () => {
    const tools = await session.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["pets.create", "pets.delete", "pets.get", "pets.list"]);
  });

  it("calls a tool and gets a real response from the upstream mock", async () => {
    const outcome = await session.callTool("pets.list", {});
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("Rex");
    expect(outcome.durationMs).toBeGreaterThan(0);
  });

  it("surfaces an ajv validation failure without hitting the network", async () => {
    const outcome = await session.callTool("pets.get", {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("required property");
  });
});
