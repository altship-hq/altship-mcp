import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer } from "./generate.js";

const fixture = (name: string) => path.resolve(import.meta.dirname, "../../../fixtures", name);

describe("generateServer", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "mcp-gen-test-"));
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes a complete project and warns about missing auth", async () => {
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const tools = designTools(document!);
    const result = await generateServer({ document: document!, tools, outDir });

    expect(result.filesWritten).toContain("src/server.ts");
    expect(result.filesWritten).toContain("src/tools.ts");
    expect(result.warnings).toContainEqual(expect.stringContaining("No security scheme"));

    const toolsSource = await readFile(path.join(outDir, "src/tools.ts"), "utf8");
    expect(toolsSource).toContain('"name": "pets.get"');
    expect(toolsSource).toContain('"source": "path"');
  });

  it("wires up an apiKey auth binding when the spec declares one", async () => {
    const { document } = await validateSpec(fixture("payments.yaml"));
    document!.components = {
      securitySchemes: { apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } },
    };
    document!.security = [{ apiKeyAuth: [] }];

    const tools = designTools(document!);
    const authDir = path.join(outDir, "with-auth");
    const result = await generateServer({ document: document!, tools, outDir: authDir });

    expect(result.warnings).toEqual([]);
    const authSource = await readFile(path.join(authDir, "src/auth.ts"), "utf8");
    expect(authSource).toContain("PAYMENTS_API_APIKEYAUTH");
    expect(authSource).toContain('headers["X-API-Key"]');

    const envExample = await readFile(path.join(authDir, ".env.example"), "utf8");
    expect(envExample).toContain("PAYMENTS_API_APIKEYAUTH=");
  });
});
