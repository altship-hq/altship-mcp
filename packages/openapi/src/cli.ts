#!/usr/bin/env node
import { validateSpec } from "./validate.js";
import type { ValidationIssue } from "./types.js";

const target = process.argv[2];

if (!target) {
  console.error("Usage: altship-openapi <path-or-url-to-openapi-spec>");
  process.exit(1);
}

const result = await validateSpec(target);

const errors = result.issues.filter((i) => i.severity === "error");
const warnings = result.issues.filter((i) => i.severity === "warning");

console.log(`\n${target}`);
console.log(result.valid ? "✓ valid" : "✗ invalid");

if (result.document) {
  const opCount = Object.values(result.document.paths ?? {}).reduce(
    (sum, item) => sum + Object.keys(item ?? {}).filter((k) => ["get", "put", "post", "delete", "patch"].includes(k)).length,
    0,
  );
  console.log(`${result.document.info?.title ?? "Untitled API"} — ${opCount} operations discovered\n`);
}

printGroup("Errors", errors);
printGroup("Warnings", warnings);

if (errors.length === 0 && warnings.length === 0) {
  console.log("No issues found.");
}

process.exit(result.valid ? 0 : 1);

function printGroup(label: string, issues: ValidationIssue[]) {
  if (issues.length === 0) return;
  console.log(`${label} (${issues.length}):`);
  for (const issue of issues) {
    console.log(`  [${issue.code}] ${issue.message}${issue.path ? `\n      at ${issue.path}` : ""}`);
  }
  console.log("");
}
