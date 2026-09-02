#!/usr/bin/env node
import { validateSpec } from "@altship/openapi";
import { designTools } from "./design.js";

const target = process.argv[2];

if (!target) {
  console.error("Usage: altship-tool-design <path-or-url-to-openapi-spec>");
  process.exit(1);
}

const result = await validateSpec(target);

if (!result.document) {
  console.error(`Spec failed to parse:\n${result.issues.map((i) => `  ${i.message}`).join("\n")}`);
  process.exit(1);
}

const tools = designTools(result.document);

console.log(`\n${result.document.info.title} — ${tools.length} proposed tools\n`);

for (const tool of tools) {
  const flags = [tool.destructive && "⚠ destructive", tool.sensitive && "⚠ sensitive"].filter(Boolean);
  console.log(`[x] ${tool.method.padEnd(6)} ${tool.path}`);
  console.log(`    → ${tool.name}${flags.length ? "  " + flags.join(" ") : ""}`);
  if (tool.description) console.log(`    "${truncate(tool.description, 90)}"`);
  const props = Object.keys(tool.inputSchema.properties);
  if (props.length > 0) console.log(`    input: { ${props.join(", ")} }`);
  for (const issue of tool.issues) console.log(`    ! [${issue.code}] ${issue.message}`);
  console.log("");
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
