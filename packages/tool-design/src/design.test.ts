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

  it("names the resource, not a generic prefix like /api", () => {
    expect(deriveToolName("get", "/api/v1/users/{id}")).toBe("users.get");
    expect(deriveToolName("post", "/rest/api/v2/orders")).toBe("orders.create");
    // "api" stays when nothing else names a resource.
    expect(deriveToolName("get", "/api")).toBe("api.list");
    expect(deriveToolName("get", "/api/{id}")).toBe("api.get");
    expect(deriveToolName("get", "/{id}")).toBe("root.get");
  });

  it("uses the whole path, so nested operations get different names", () => {
    expect(deriveToolName("post", "/api/v1/auth/email-change/request")).toBe("auth.email_change_request");
    expect(deriveToolName("post", "/api/v1/auth/password-change/request")).toBe("auth.password_change_request");
    expect(deriveToolName("get", "/api/v1/admin/stripe/accounts/{ref}")).toBe("admin.get_stripe_accounts");
    expect(deriveToolName("get", "/api/v1/admin/stripe/payment-intents/{id}")).toBe("admin.get_stripe_payment_intents");
  });

  it("puts the method's verb in front of a sub-resource", () => {
    expect(deriveToolName("get", "/api/v1/users/me")).toBe("users.get_me");
    expect(deriveToolName("patch", "/v1/businessInformation/image")).toBe("business_information.update_image");
    expect(deriveToolName("delete", "/v1/appointments/{id}/addons")).toBe("appointments.delete_addons");
    expect(deriveToolName("post", "/v1/appointments/{id}/addons/{addonId}")).toBe("appointments.update_addons");
  });

  it("doesn't double up when the path already starts with a verb", () => {
    expect(deriveToolName("get", "/pet/findByStatus")).toBe("pet.find_by_status");
    expect(deriveToolName("get", "/user/login")).toBe("user.login");
    expect(deriveToolName("get", "/v1/reports/{id}/export")).toBe("reports.export");
    expect(deriveToolName("post", "/pet/{petId}/uploadImage")).toBe("pet.upload_image");
  });

  it("uses whether a list comes back to choose between list and get", () => {
    expect(deriveToolName("get", "/v1/businessInformation", { returnsList: false })).toBe("business_information.get");
    expect(deriveToolName("get", "/v1/businessInformation", { returnsList: true })).toBe("business_information.list");
    expect(deriveToolName("get", "/v1/businessInformation")).toBe("business_information.list");
    expect(deriveToolName("get", "/v1/users/{id}/orders", { returnsList: true })).toBe("users.list_orders");
    expect(deriveToolName("get", "/v1/users/{id}/orders")).toBe("users.get_orders");
  });

  it("keeps names to characters and a length MCP clients accept", () => {
    expect(deriveToolName("post", "/v1/files:batch.upload")).toBe("files_batch_upload.create");
    const long = deriveToolName("get", `/v1/reports/${"very-long-segment/".repeat(8)}summary`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9_.]+[a-z0-9]$/);
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

describe("designTools naming", () => {
  const document = (paths: Record<string, unknown>) => ({ openapi: "3.0.0", info: { title: "T", version: "1" }, paths }) as any;
  const ok = (schema?: unknown) => ({ responses: { "200": { description: "ok", ...(schema ? { content: { "application/json": { schema } } } : {}) } } });
  const names = (paths: Record<string, unknown>) => designTools(document(paths)).map((t) => t.name);

  it("tells clashing names apart by their path parameter before anything else", () => {
    expect(
      names({
        "/classes/public": { get: ok() },
        "/classes/{id}/public": { get: ok() },
      }),
    ).toEqual(["classes.get_public", "classes.get_public_by_id"]);
  });

  it("then by method, and numbers only what still clashes, reporting it", () => {
    // Two different versions of the same path: nothing but a number tells them apart.
    const tools = designTools(document({ "/v1/things": { get: ok() }, "/v2/things": { get: ok() }, "/v1/things/{id}": { get: ok() } }));
    expect(tools.map((t) => t.name)).toEqual(["things.list_1", "things.list_2", "things.get"]);
    expect(tools[0].issues.map((i) => i.code)).toContain("tool-name-collision");
    expect(tools[2].issues.map((i) => i.code)).not.toContain("tool-name-collision");
  });

  it("calls a single resource get and a wrapped list list", () => {
    expect(
      names({
        "/profile": { get: ok({ type: "object", properties: { name: { type: "string" } } }) },
        "/orders": { get: ok({ type: "object", properties: { data: { type: "array", items: { type: "object" } }, total: { type: "integer" } } }) },
        "/tags": { get: ok({ type: "array", items: { type: "string" } }) },
        "/unknown": { get: ok() },
      }),
    ).toEqual(["profile.get", "orders.list", "tags.list", "unknown.list"]);
  });

  it("never produces duplicate names", () => {
    const paths: Record<string, unknown> = {};
    for (const p of ["/api/v1/auth/me", "/api/v1/users/me", "/api/v1/users/{id}", "/api/v1/users/{email}", "/api/v2/users/{id}", "/api/v1/users"]) {
      paths[p] = { get: ok(), patch: ok() };
    }
    const all = names(paths);
    expect(new Set(all).size).toBe(all.length);
  });
});
