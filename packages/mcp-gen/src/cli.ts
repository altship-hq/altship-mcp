#!/usr/bin/env node
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer } from "./generate.js";

const args = process.argv.slice(2).filter((a) => a !== "--vercel");
const useVercel = process.argv.includes("--vercel");
const [spec, outDir] = args;

if (!spec || !outDir) {
  console.error("Usage: altship-mcp-gen <path-or-url-to-openapi-spec> <output-dir> [--vercel]");
  process.exit(1);
}

const validation = await validateSpec(spec);
if (!validation.document) {
  console.error(`Spec failed to parse:\n${validation.issues.map((i) => `  ${i.message}`).join("\n")}`);
  process.exit(1);
}

const tools = designTools(validation.document);
const generate = useVercel ? generateVercelServer : generateServer;
const result = await generate({ document: validation.document, tools, outDir });

console.log(`Generated ${result.filesWritten.length} files into ${result.outDir}:`);
for (const file of result.filesWritten) console.log(`  ${file}`);
if (result.warnings.length > 0) {
  console.log("\nWarnings:");
  for (const w of result.warnings) console.log(`  ${w}`);
}
