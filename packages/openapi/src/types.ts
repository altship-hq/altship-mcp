import type { OpenAPIV3 } from "openapi-types";

export type IssueSeverity = "error" | "warning";
export type IssueCategory = "structural" | "quality";

export interface ValidationIssue {
  severity: IssueSeverity;
  category: IssueCategory;
  code: string;
  message: string;
  /** JSON-pointer-ish path to the offending node, e.g. paths./pets.get */
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** The fully dereferenced document, if parsing succeeded. */
  document?: OpenAPIV3.Document;
}
