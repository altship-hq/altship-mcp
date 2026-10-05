import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer, upgradeVercelServerFiles, UpgradeError } from "./generate.js";

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

    expect(result.filesWritten).toContain("src/docs.ts");
    const docsSource = await readFile(path.join(outDir, "src/docs.ts"), "utf8");
    expect(docsSource).toContain("pets.get");
    expect(docsSource).toContain("Swagger Petstore");
  });

  it("writes a public docs page for the Vercel target", async () => {
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const tools = designTools(document!);
    const vercelDir = path.join(outDir, "vercel-target");
    const result = await generateVercelServer({ document: document!, tools, outDir: vercelDir });

    expect(result.filesWritten).toContain("public/index.html");
    const html = await readFile(path.join(vercelDir, "public/index.html"), "utf8");
    expect(html).toContain("pets.get");
    expect(html).toContain("/api/mcp");
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

describe("upgradeVercelServerFiles", () => {
  let outDir: string;
  let fresh: Record<string, string>;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "mcp-gen-upgrade-"));
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const result = await generateVercelServer({ document: document!, tools: designTools(document!), outDir });
    fresh = {};
    for (const file of result.filesWritten) fresh[file] = await readFile(path.join(outDir, file), "utf8");
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  // A server from before access checks and telemetry existed: those files are missing or older.
  const old = () => {
    const files = { ...fresh, "api/mcp.ts": "// an older handler", "lib/mcp-factory.ts": "// an older factory" };
    for (const gone of ["lib/access.ts", "lib/telemetry.ts", "api/oauth-protected-resource.ts", "vercel.json"]) delete (files as Record<string, string>)[gone];
    return files as Record<string, string>;
  };

  it("brings an older server's logic up to what's generated today", () => {
    expect(upgradeVercelServerFiles(old())).toEqual(fresh);
  });

  it("keeps everything derived from the spec exactly as it was", () => {
    const files: Record<string, string> = { ...old(), "lib/tools.ts": "// this server's own tools", "lib/auth.ts": fresh["lib/auth.ts"] + "\n// its own auth", "public/index.html": "<p>its docs</p>" };
    const upgraded = upgradeVercelServerFiles(files);
    for (const kept of ["lib/tools.ts", "lib/auth.ts", "lib/config.ts", "public/index.html", "README.md"]) expect(upgraded[kept]).toBe(files[kept]);
  });

  it("keeps the server's own name and its per-user auth mode", () => {
    const files = { ...old(), "package.json": JSON.stringify({ name: "my-own-mcp" }) };
    const upgraded = upgradeVercelServerFiles(files, { authMode: "passthrough" });
    expect(JSON.parse(upgraded["package.json"]).name).toBe("my-own-mcp");
    expect(upgraded["lib/mcp-factory.ts"]).toContain('"my-own-mcp"');
    expect(upgraded["lib/access.ts"]).toContain("const PASSTHROUGH = true;");
    expect(upgradeVercelServerFiles(files)["lib/access.ts"]).toContain("const PASSTHROUGH = false;");
  });

  it("refuses files that aren't a generated server", () => {
    expect(() => upgradeVercelServerFiles({ "package.json": "{}" })).toThrow(UpgradeError);
    expect(() => upgradeVercelServerFiles({ ...old(), "lib/auth.ts": "export const nothing = 1;" })).toThrow(UpgradeError);
    expect(() => upgradeVercelServerFiles({ ...old(), "package.json": "not json" })).toThrow(UpgradeError);
  });
});
