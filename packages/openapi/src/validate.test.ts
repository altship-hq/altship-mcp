import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { validateSpec } from "./validate.js";

const fixture = (name: string) => path.resolve(import.meta.dirname, "../../../fixtures", name);

describe("validateSpec", () => {
  it("accepts a well-formed spec and flags a bad operationId", async () => {
    const result = await validateSpec(fixture("petstore-expanded.yaml"));

    expect(result.valid).toBe(true);
    expect(result.document?.info.title).toBe("Swagger Petstore");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-operation-id-format" }),
    );
  });

  it("rejects a spec with a dangling $ref", async () => {
    const result = await validateSpec(fixture("broken.yaml"));

    expect(result.valid).toBe(false);
    expect(result.document).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "parse-failed" }));
  });

  it("flags missing and duplicate operationIds", async () => {
    const result = await validateSpec(fixture("duplicate-op-ids.yaml"));

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "duplicate-operation-id" }));
  });

  it("accepts uploaded YAML content", async () => {
    const content = await readFile(fixture("petstore-expanded.yaml"), "utf8");
    const result = await validateSpec({ content }, { untrusted: true });
    expect(result.valid).toBe(true);
    expect(result.document?.info.title).toBe("Swagger Petstore");
  });

  it("accepts uploaded JSON content", async () => {
    const content = JSON.stringify({ openapi: "3.0.0", info: { title: "Tiny", version: "1" }, paths: {} });
    const result = await validateSpec({ content }, { untrusted: true });
    expect(result.document?.info.title).toBe("Tiny");
  });

  it("rejects uploaded content that isn't YAML or JSON", async () => {
    const result = await validateSpec({ content: "openapi: [unclosed" }, { untrusted: true });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "parse-failed" }));
  });

  it("doesn't let uploaded content $ref local files", async () => {
    const content = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Sneaky", version: "1" },
      paths: { "/x": { $ref: "/etc/passwd" } },
    });
    const result = await validateSpec({ content }, { untrusted: true });
    expect(result.document).toBeUndefined();
  });

  it("rejects local paths and private URLs from untrusted callers", async () => {
    for (const target of [fixture("petstore-expanded.yaml"), "file:///etc/passwd", "http://localhost:4000/spec", "http://169.254.169.254/latest", "http://10.0.0.5/openapi.json"]) {
      const result = await validateSpec(target, { untrusted: true });
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsupported-source" }));
    }
  });
});

