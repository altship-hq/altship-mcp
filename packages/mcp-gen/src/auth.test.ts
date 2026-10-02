import { describe, expect, it } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { deriveAuthBinding } from "./auth.js";

const doc = (extra: Partial<OpenAPIV3.Document>): OpenAPIV3.Document => ({
  openapi: "3.0.0",
  info: { title: "Test", version: "1" },
  paths: {},
  ...extra,
});

describe("deriveAuthBinding", () => {
  it("prefers a supported scheme over an unsupported one listed first (e.g. Swagger Petstore)", () => {
    const { binding } = deriveAuthBinding(
      doc({
        components: {
          securitySchemes: {
            petstore_auth: { type: "oauth2", flows: { implicit: { authorizationUrl: "https://x/auth", scopes: {} } } },
            api_key: { type: "apiKey", in: "header", name: "api_key" },
          },
        },
        paths: { "/pet": { get: { responses: {}, security: [{ petstore_auth: [] }] } } },
      }),
      "PETSTORE",
    );
    expect(binding).toMatchObject({ kind: "apiKey-header", paramName: "api_key", envVar: "PETSTORE_API_KEY" });
  });

  it("uses the global security requirement first", () => {
    const { binding } = deriveAuthBinding(
      doc({
        security: [{ bearer: [] }],
        components: {
          securitySchemes: {
            key: { type: "apiKey", in: "header", name: "X-Key" },
            bearer: { type: "http", scheme: "bearer" },
          },
        },
      }),
      "API",
    );
    expect(binding.kind).toBe("bearer");
  });

  it("warns when only unsupported schemes exist", () => {
    const { binding, warning } = deriveAuthBinding(
      doc({ components: { securitySchemes: { o: { type: "oauth2", flows: {} } } } }),
      "API",
    );
    expect(binding.kind).toBe("none");
    expect(warning).toContain("not yet supported");
  });
});
