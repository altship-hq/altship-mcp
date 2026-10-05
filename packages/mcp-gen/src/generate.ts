import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenAPIV3 } from "openapi-types";
import type { ToolDefinition } from "@altship/tool-design";
import { deriveAuthBinding, type AuthBinding } from "./auth.js";
import { envSlug, slugify } from "./slug.js";
import {
  accessTemplate,
  authTemplate,
  clientTemplate,
  configTemplate,
  dockerfileTemplate,
  docsModuleTemplate,
  docsPageTemplate,
  envExampleTemplate,
  mcpFactoryTemplate,
  packageJsonTemplate,
  readmeTemplate,
  serverTemplate,
  telemetryTemplate,
  toolsDataTemplate,
  tsconfigTemplate,
  typesTemplate,
  vercelGitignoreTemplate,
  vercelHealthHandlerTemplate,
  vercelConfigTemplate,
  vercelMcpHandlerTemplate,
  vercelOAuthMetadataHandlerTemplate,
  vercelPackageJsonTemplate,
  vercelReadmeTemplate,
  vercelTsconfigTemplate,
} from "./templates.js";

export interface GenerateOptions {
  document: OpenAPIV3.Document;
  tools: ToolDefinition[];
  outDir: string;
  /** Forward each caller's own bearer token to the upstream API instead of one shared credential. Only takes effect for http-bearer schemes. */
  authMode?: "static" | "passthrough";
  /**
   * Each person connecting signs in with their own credential for the
   * upstream API, delivered (encrypted) inside their access token -- for
   * servers a SaaS offers to its own customers. Replaces the shared env var.
   */
  perUserCredential?: boolean;
}

export interface GenerateResult {
  outDir: string;
  filesWritten: string[];
  warnings: string[];
}

interface DerivedMeta {
  apiTitle: string;
  pkgSlug: string;
  baseUrlEnvVar: string;
  defaultBaseUrl: string;
  binding: AuthBinding;
  warnings: string[];
}

function deriveMeta(document: OpenAPIV3.Document, authMode?: "static" | "passthrough"): DerivedMeta {
  const apiTitle = document.info?.title ?? "Generated API";
  const pkgSlug = slugify(apiTitle) || "generated-api";
  const apiEnvSlug = envSlug(apiTitle) || "API";
  const baseUrlEnvVar = `${apiEnvSlug}_BASE_URL`;
  const defaultBaseUrl = document.servers?.[0]?.url ?? "https://api.example.com";

  const { binding, warning } = deriveAuthBinding(document, apiEnvSlug, { passthrough: authMode === "passthrough" });

  return { apiTitle, pkgSlug, baseUrlEnvVar, defaultBaseUrl, binding, warnings: warning ? [warning] : [] };
}

async function writeFiles(outDir: string, files: Record<string, string>): Promise<string[]> {
  const filesWritten: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(outDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    filesWritten.push(relativePath);
  }
  return filesWritten;
}

/** Generates a self-contained Node server: stdio by default, or Streamable HTTP when run with MCP_TRANSPORT=http (e.g. in a container). */
export async function generateServer(options: GenerateOptions): Promise<GenerateResult> {
  const { document, tools, outDir, authMode, perUserCredential } = options;
  const { apiTitle, pkgSlug, baseUrlEnvVar, defaultBaseUrl, binding, warnings } = deriveMeta(document, authMode);

  const files: Record<string, string> = {
    "package.json": packageJsonTemplate(`${pkgSlug}-mcp`),
    "tsconfig.json": tsconfigTemplate(),
    "Dockerfile": dockerfileTemplate(),
    ".env.example": envExampleTemplate(binding, baseUrlEnvVar, perUserCredential),
    "README.md": readmeTemplate(apiTitle, binding, tools.length, `${pkgSlug}-mcp`, perUserCredential),
    "src/types.ts": typesTemplate(),
    "src/config.ts": configTemplate(baseUrlEnvVar, defaultBaseUrl),
    "src/auth.ts": authTemplate(binding, perUserCredential),
    "src/access.ts": accessTemplate(binding),
    "src/client.ts": clientTemplate(),
    "src/telemetry.ts": telemetryTemplate(`${pkgSlug}-mcp`),
    "src/tools.ts": toolsDataTemplate(tools),
    "src/mcp-factory.ts": mcpFactoryTemplate(`${pkgSlug}-mcp`),
    "src/docs.ts": docsModuleTemplate(docsPageTemplate(apiTitle, tools, "/mcp")),
    "src/server.ts": serverTemplate(),
  };

  const filesWritten = await writeFiles(outDir, files);
  return { outDir, filesWritten, warnings };
}

/** Generates a Vercel-deployable project: api/mcp.ts + api/health.ts as serverless functions, sharing lib/ with the Node target's logic. */
export async function generateVercelServer(options: GenerateOptions): Promise<GenerateResult> {
  const { document, tools, outDir, authMode, perUserCredential } = options;
  const { apiTitle, pkgSlug, baseUrlEnvVar, defaultBaseUrl, binding, warnings } = deriveMeta(document, authMode);

  const files: Record<string, string> = {
    "package.json": vercelPackageJsonTemplate(`${pkgSlug}-mcp`),
    "tsconfig.json": vercelTsconfigTemplate(),
    ".gitignore": vercelGitignoreTemplate(),
    ".env.example": envExampleTemplate(binding, baseUrlEnvVar, perUserCredential),
    "README.md": vercelReadmeTemplate(apiTitle, binding, tools.length, perUserCredential),
    "lib/types.ts": typesTemplate(),
    "lib/config.ts": configTemplate(baseUrlEnvVar, defaultBaseUrl),
    "lib/auth.ts": authTemplate(binding, perUserCredential),
    "lib/access.ts": accessTemplate(binding),
    "lib/client.ts": clientTemplate(),
    "lib/telemetry.ts": telemetryTemplate(`${pkgSlug}-mcp`),
    "lib/tools.ts": toolsDataTemplate(tools),
    "lib/mcp-factory.ts": mcpFactoryTemplate(`${pkgSlug}-mcp`),
    "api/mcp.ts": vercelMcpHandlerTemplate(),
    "api/health.ts": vercelHealthHandlerTemplate(),
    "api/oauth-protected-resource.ts": vercelOAuthMetadataHandlerTemplate(),
    "vercel.json": vercelConfigTemplate(),
    "public/index.html": docsPageTemplate(apiTitle, tools, "/api/mcp"),
  };

  const filesWritten = await writeFiles(outDir, files);
  return { outDir, filesWritten, warnings };
}

/**
 * The generation of the server code this package writes. Bumped when the
 * generated logic gains something an already-deployed server would need an
 * upgrade to get (2: caller identity and tool-call telemetry).
 */
export const GENERATOR_VERSION = 2;

/** Files that are the same for every Vercel server, or depend only on its package name and auth mode. */
const VERCEL_LOGIC_FILES = [
  "package.json",
  "tsconfig.json",
  "vercel.json",
  "lib/types.ts",
  "lib/access.ts",
  "lib/client.ts",
  "lib/telemetry.ts",
  "lib/mcp-factory.ts",
  "api/mcp.ts",
  "api/health.ts",
  "api/oauth-protected-resource.ts",
] as const;

export class UpgradeError extends Error {}

/**
 * Brings an already-deployed Vercel server's files up to the current
 * generation without its OpenAPI spec: the shared logic (access checks,
 * telemetry, the MCP handler) is replaced with what's generated today, and
 * everything derived from the spec (its tools, base URL, how it authenticates
 * upstream, its docs) is kept exactly as it was.
 */
export function upgradeVercelServerFiles(files: Record<string, string>, options: { authMode?: "static" | "passthrough" } = {}): Record<string, string> {
  for (const required of ["package.json", "lib/tools.ts", "lib/auth.ts", "lib/config.ts"]) {
    if (typeof files[required] !== "string") throw new UpgradeError(`This doesn't look like a generated server: ${required} is missing.`);
  }
  let pkgName: unknown;
  try {
    pkgName = (JSON.parse(files["package.json"]) as { name?: unknown }).name;
  } catch {
    pkgName = undefined;
  }
  if (typeof pkgName !== "string" || !pkgName) throw new UpgradeError("This server's package.json has no name.");
  // The spec-derived files rely on these two exports, which every generation has had.
  if (!/export function applyAuth\(/.test(files["lib/auth.ts"]) || !/export function assertAuthConfigured\(/.test(files["lib/auth.ts"])) {
    throw new UpgradeError("This server's auth module isn't one this upgrade understands.");
  }

  // The access module only needs to know whether Authorization carries the caller's own token.
  const binding = { kind: options.authMode === "passthrough" ? "passthrough" : "none" } as AuthBinding;
  const logic: Record<(typeof VERCEL_LOGIC_FILES)[number], string> = {
    "package.json": vercelPackageJsonTemplate(pkgName),
    "tsconfig.json": vercelTsconfigTemplate(),
    "vercel.json": vercelConfigTemplate(),
    "lib/types.ts": typesTemplate(),
    "lib/access.ts": accessTemplate(binding),
    "lib/client.ts": clientTemplate(),
    "lib/telemetry.ts": telemetryTemplate(pkgName),
    "lib/mcp-factory.ts": mcpFactoryTemplate(pkgName),
    "api/mcp.ts": vercelMcpHandlerTemplate(),
    "api/health.ts": vercelHealthHandlerTemplate(),
    "api/oauth-protected-resource.ts": vercelOAuthMetadataHandlerTemplate(),
  };
  return { ...files, ...logic };
}
