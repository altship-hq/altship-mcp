import type { OpenAPIV3 } from "openapi-types";

export type AuthKind = "apiKey-header" | "apiKey-query" | "bearer" | "basic" | "passthrough" | "none";

export interface AuthBinding {
  kind: AuthKind;
  /**
   * Env var the generated server reads the credential from, e.g. ACME_API_TOKEN.
   * Not used for "passthrough" — there's no server-side secret to configure.
   */
  envVar?: string;
  /** For apiKey schemes: the header or query parameter name credentials go in. */
  paramName?: string;
  schemeName?: string;
}

export interface DeriveAuthOptions {
  /**
   * Forward each caller's own bearer token to the upstream API instead of a
   * single shared server-side credential -- the MCP server acts as the
   * calling end-user rather than a global service account. Only meaningful
   * when the spec's scheme is http-bearer (that's the shape an OAuth access
   * token takes); ignored otherwise. We don't validate the token ourselves --
   * the upstream API does that anyway, so relaying it unmodified is a sound
   * default rather than reimplementing OAuth verification here.
   */
  passthrough?: boolean;
}

/**
 * V1 supports exactly one auth scheme per generated server (apiKey or
 * bearer/basic http auth) — the first one referenced by the spec's global
 * `security` requirement, falling back to the first securityScheme defined
 * at all. Multi-scheme specs fall back to "none" with a warning.
 */
export function deriveAuthBinding(
  document: OpenAPIV3.Document,
  apiSlug: string,
  options: DeriveAuthOptions = {},
): {
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
    if (options.passthrough) {
      return { binding: { kind: "passthrough", schemeName } };
    }
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
