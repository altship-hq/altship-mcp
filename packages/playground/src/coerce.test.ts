import { describe, expect, it } from "vitest";
import { coerceArgs } from "./coerce.js";

const schema = {
  type: "object" as const,
  properties: {
    id: { type: "integer" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    name: { type: "string" },
  },
};

describe("coerceArgs", () => {
  it("coerces raw strings to their declared types", () => {
    expect(
      coerceArgs(schema, { id: "42", active: "true", tags: "a, b, c", name: "Rex" }),
    ).toEqual({ id: 42, active: true, tags: ["a", "b", "c"], name: "Rex" });
  });

  it("drops empty fields rather than passing blank strings", () => {
    expect(coerceArgs(schema, { id: "1", name: "" })).toEqual({ id: 1 });
  });
});
