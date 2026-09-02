import { describe, expect, it } from "vitest";
import path from "node:path";
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
});
