import { isIP } from "node:net";
import SwaggerParser from "@apidevtools/swagger-parser";
import yaml from "js-yaml";
import type { OpenAPIV3 } from "openapi-types";
import type { ValidationIssue } from "./types.js";

/** A spec to parse: a file path or URL, or the document's text (e.g. an uploaded file). */
export type SpecInput = string | { content: string };

export interface ParseOptions {
  /**
   * The input comes from someone else (e.g. the web API): only uploaded
   * content or public http(s) URLs are accepted, and $refs never resolve to
   * local files or private-network addresses. CLIs, which run on the user's
   * own machine, leave this off so local paths work.
   */
  untrusted?: boolean;
}

/** Largest uploaded spec accepted. */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;

/**
 * Parses and structurally validates an OpenAPI 3.x document, resolving all
 * $refs. swagger-parser throws on the first problem it hits rather than
 * collecting a list, so a failure here becomes a single structural issue —
 * good enough to unblock the customer, not a full multi-error report.
 */
export async function parseSpec(
  input: SpecInput,
  options: ParseOptions = {},
): Promise<{
  document?: OpenAPIV3.Document;
  issues: ValidationIssue[];
}> {
  const failed = (code: string, message: string) => ({
    issues: [{ severity: "error" as const, category: "structural" as const, code, message }],
  });

  let target: string | object;
  if (typeof input === "string") {
    if (options.untrusted && !isPublicHttpUrl(input)) {
      return failed("unsupported-source", "Use a public http(s) URL, or upload the spec file.");
    }
    target = input;
  } else {
    if (Buffer.byteLength(input.content, "utf8") > MAX_SPEC_BYTES) {
      return failed("too-large", `The spec is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB.`);
    }
    try {
      // YAML is a superset of JSON, so this reads both.
      const parsed = yaml.load(input.content);
      if (!parsed || typeof parsed !== "object") return failed("parse-failed", "The file isn't a YAML or JSON object.");
      target = parsed;
    } catch (err) {
      return failed("parse-failed", `The file isn't valid YAML or JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const document = (await SwaggerParser.validate(
      target as never,
      options.untrusted || typeof input !== "string"
        ? { resolve: { file: false, http: { canRead: (file: { url: string }) => isPublicHttpUrl(file.url) } } }
        : {},
    )) as OpenAPIV3.Document;

    if (!document.openapi?.startsWith("3.")) {
      return failed("unsupported-version", `Only OpenAPI 3.x is supported (got "${document.openapi ?? "unknown"}").`);
    }

    return { document, issues: [] };
  } catch (err) {
    return failed("parse-failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * An http(s) URL whose host isn't obviously local or private. A hostname
 * check only (not DNS-rebinding proof); the API's outbound network rules are
 * the backstop.
 */
export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (isIP(host) === 6) {
    return !(host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:"));
  }
  return true;
}
