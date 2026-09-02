import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import type { ValidationIssue } from "./types.js";

/**
 * Parses and structurally validates an OpenAPI 3.x document (from a file
 * path or URL), resolving all $refs. swagger-parser throws on the first
 * problem it hits rather than collecting a list, so a failure here becomes
 * a single structural issue — good enough to unblock the customer, not a
 * full multi-error report.
 */
export async function parseSpec(pathOrUrl: string): Promise<{
  document?: OpenAPIV3.Document;
  issues: ValidationIssue[];
}> {
  try {
    const document = (await SwaggerParser.validate(pathOrUrl)) as OpenAPIV3.Document;

    if (!document.openapi?.startsWith("3.")) {
      return {
        issues: [
          {
            severity: "error",
            category: "structural",
            code: "unsupported-version",
            message: `Only OpenAPI 3.x is supported (got "${document.openapi ?? "unknown"}").`,
          },
        ],
      };
    }

    return { document, issues: [] };
  } catch (err) {
    return {
      issues: [
        {
          severity: "error",
          category: "structural",
          code: "parse-failed",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
