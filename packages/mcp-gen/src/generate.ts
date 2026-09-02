import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenAPIV3 } from "openapi-types";
import type { ToolDefinition } from "@altship/tool-design";
import { deriveAuthBinding, type AuthBinding } from "./auth.js";
import { envSlug, slugify } from "./slug.js";
import {
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
  toolsDataTemplate,
  tsconfigTemplate,
  typesTemplate,
  vercelGitignoreTemplate,
  vercelHealthHandlerTemplate,
  vercelMcpHandlerTemplate,
  vercelPackageJsonTemplate,
  vercelReadmeTemplate,
  vercelTsconfigTemplate,
} from "./templates.js";

export interface GenerateOptions {
  document: OpenAPIV3.Document;
  tools: ToolDefinition[];
  outDir: string;
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

function deriveMeta(document: OpenAPIV3.Document): DerivedMeta {
  const apiTitle = document.info?.title ?? "Generated API";
  const pkgSlug = slugify(apiTitle) || "generated-api";
  const apiEnvSlug = envSlug(apiTitle) || "API";
  const baseUrlEnvVar = `${apiEnvSlug}_BASE_URL`;
  const defaultBaseUrl = document.servers?.[0]?.url ?? "https://api.example.com";

  const { binding, warning } = deriveAuthBinding(document, apiEnvSlug);

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
  const { document, tools, outDir } = options;
  const { apiTitle, pkgSlug, baseUrlEnvVar, defaultBaseUrl, binding, warnings } = deriveMeta(document);

  const files: Record<string, string> = {
    "package.json": packageJsonTemplate(`${pkgSlug}-mcp`),
    "tsconfig.json": tsconfigTemplate(),
    "Dockerfile": dockerfileTemplate(),
    ".env.example": envExampleTemplate(binding, baseUrlEnvVar),
    "README.md": readmeTemplate(apiTitle, binding, tools.length),
    "src/types.ts": typesTemplate(),
    "src/config.ts": configTemplate(baseUrlEnvVar, defaultBaseUrl),
    "src/auth.ts": authTemplate(binding),
    "src/client.ts": clientTemplate(),
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
  const { document, tools, outDir } = options;
  const { apiTitle, pkgSlug, baseUrlEnvVar, defaultBaseUrl, binding, warnings } = deriveMeta(document);

  const files: Record<string, string> = {
    "package.json": vercelPackageJsonTemplate(`${pkgSlug}-mcp`),
    "tsconfig.json": vercelTsconfigTemplate(),
    ".gitignore": vercelGitignoreTemplate(),
    ".env.example": envExampleTemplate(binding, baseUrlEnvVar),
    "README.md": vercelReadmeTemplate(apiTitle, binding, tools.length),
    "lib/types.ts": typesTemplate(),
    "lib/config.ts": configTemplate(baseUrlEnvVar, defaultBaseUrl),
    "lib/auth.ts": authTemplate(binding),
    "lib/client.ts": clientTemplate(),
    "lib/tools.ts": toolsDataTemplate(tools),
    "lib/mcp-factory.ts": mcpFactoryTemplate(`${pkgSlug}-mcp`),
    "api/mcp.ts": vercelMcpHandlerTemplate(),
    "api/health.ts": vercelHealthHandlerTemplate(),
    "public/index.html": docsPageTemplate(apiTitle, tools, "/api/mcp"),
  };

  const filesWritten = await writeFiles(outDir, files);
  return { outDir, filesWritten, warnings };
}
