import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenAPIV3 } from "openapi-types";
import type { ToolDefinition } from "@altship/tool-design";
import { deriveAuthBinding } from "./auth.js";
import { envSlug, slugify } from "./slug.js";
import {
  authTemplate,
  clientTemplate,
  configTemplate,
  dockerfileTemplate,
  envExampleTemplate,
  packageJsonTemplate,
  readmeTemplate,
  serverTemplate,
  toolsDataTemplate,
  tsconfigTemplate,
  typesTemplate,
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

export async function generateServer(options: GenerateOptions): Promise<GenerateResult> {
  const { document, tools, outDir } = options;

  const apiTitle = document.info?.title ?? "Generated API";
  const pkgSlug = slugify(apiTitle) || "generated-api";
  const apiEnvSlug = envSlug(apiTitle) || "API";
  const baseUrlEnvVar = `${apiEnvSlug}_BASE_URL`;
  const defaultBaseUrl = document.servers?.[0]?.url ?? "https://api.example.com";

  const { binding, warning } = deriveAuthBinding(document, apiEnvSlug);
  const warnings = warning ? [warning] : [];

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
    "src/server.ts": serverTemplate(`${pkgSlug}-mcp`),
  };

  const filesWritten: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(outDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    filesWritten.push(relativePath);
  }

  return { outDir, filesWritten, warnings };
}
