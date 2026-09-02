import type { OpenAPIV3 } from "openapi-types";

export type AuthKind = "apiKey-header" | "apiKey-query" | "bearer" | "basic" | "none";

export interface AuthBinding {
  kind: AuthKind;
  /** Env var the generated server reads the credential from, e.g. ACME_API_TOKEN. */
  envVar: string;
  /** For apiKey schemes: the header or query parameter name credentials go in. */
  paramName?: string;
  schemeName?: string;
}

/**
 * V1 supports exactly one auth scheme per generated server (apiKey or
 * bearer/basic http auth) — the first one referenced by the spec's global
 * `security` requirement, falling back to the first securityScheme defined
 * at all. Multi-scheme / OAuth specs fall back to "none" with a warning;
 * per the product brief, OAuth is explicitly out of scope until the
 * platform matures.
 */
export function deriveAuthBinding(document: OpenAPIV3.Document, apiSlug: string): {
  binding: AuthBinding;
  warning?: string;
} {
  const schemes = document.components?.securitySchemes ?? {};
  const globalRequirement = document.security?.[0];
  const preferredName = globalRequirement ? Object.keys(globalRequirement)[0] : undefined;

  const schemeName = preferredName && schemes[preferredName] ? preferredName : Object.keys(schemes)[0];
  const scheme = schemeName ? schemes[schemeName] : undefined;

  if (!scheme || "$ref" in scheme) {
    return {
      binding: { kind: "none", envVar: `${apiSlug}_API_TOKEN` },
      warning: scheme
        ? `Security scheme "${schemeName}" is a $ref that should have been resolved; treating API as unauthenticated.`
        : "No security scheme found in the spec; generated server will make unauthenticated requests.",
    };
  }

  const envVar = `${apiSlug}_${toEnvSegment(schemeName!)}`;

  if (scheme.type === "apiKey") {
    return {
      binding: {
        kind: scheme.in === "query" ? "apiKey-query" : "apiKey-header",
        envVar,
        paramName: scheme.name,
        schemeName,
      },
    };
  }

  if (scheme.type === "http" && scheme.scheme === "bearer") {
    return { binding: { kind: "bearer", envVar, schemeName } };
  }

  if (scheme.type === "http" && scheme.scheme === "basic") {
    return { binding: { kind: "basic", envVar, schemeName } };
  }

  return {
    binding: { kind: "none", envVar },
    warning: `Security scheme "${schemeName}" (type "${scheme.type}") is not yet supported (only apiKey and http bearer/basic are). Generated server will make unauthenticated requests.`,
  };
}

function toEnvSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}
