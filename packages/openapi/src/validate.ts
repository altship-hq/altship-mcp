import { parseSpec } from "./parse.js";
import { checkQuality } from "./quality.js";
import type { ValidationResult } from "./types.js";

export async function validateSpec(pathOrUrl: string): Promise<ValidationResult> {
  const { document, issues } = await parseSpec(pathOrUrl);

  if (!document) {
    return { valid: false, issues };
  }

  const qualityIssues = checkQuality(document);
  const allIssues = [...issues, ...qualityIssues];
  const hasErrors = allIssues.some((issue) => issue.severity === "error");

  return { valid: !hasErrors, issues: allIssues, document };
}
