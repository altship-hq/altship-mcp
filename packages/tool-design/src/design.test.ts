import { describe, expect, it } from "vitest";
import path from "node:path";
import { validateSpec } from "@altship/openapi";
import { designTools } from "./design.js";
import { deriveToolName } from "./naming.js";

const fixture = (name: string) => path.resolve(import.meta.dirname, "../../../fixtures", name);

describe("deriveToolName", () => {
  it("maps CRUD-shaped paths to resource.action", () => {
    expect(deriveToolName("get", "/v1/customers")).toBe("customers.list");
    expect(deriveToolName("get", "/v1/customers/{id}")).toBe("customers.get");
    expect(deriveToolName("post", "/v1/customers")).toBe("customers.create");
    expect(deriveToolName("put", "/v1/customers/{id}")).toBe("customers.update");
    expect(deriveToolName("delete", "/v1/customers/{id}")).toBe("customers.delete");
  });

  it("prefers a trailing static segment as an explicit action", () => {
    expect(deriveToolName("post", "/v1/payments/{paymentId}/refund")).toBe("payments.refund");
  });
});

describe("designTools", () => {
  it("builds a flattened input schema and flags destructive/sensitive tools", async () => {
    const { document } = await validateSpec(fixture("petstore-expanded.yaml"));
    const tools = designTools(document!);

    const create = tools.find((t) => t.name === "pets.create")!;
    expect(Object.keys(create.inputSchema.properties)).toEqual(["name", "tag"]);
    expect(create.inputSchema.required).toEqual(["name"]);

    const del = tools.find((t) => t.name === "pets.delete")!;
    expect(del.destructive).toBe(true);
  });

  it("flags sensitive tools by path keywords", async () => {
    const { document } = await validateSpec(fixture("payments.yaml"));
    const tools = designTools(document!);

    expect(tools.every((t) => t.sensitive)).toBe(true);
    const refund = tools.find((t) => t.name === "payments.refund")!;
    expect(Object.keys(refund.inputSchema.properties)).toEqual(["payment_id", "amount"]);
  });
});
