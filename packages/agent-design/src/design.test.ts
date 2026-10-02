import { describe, expect, it } from "vitest";
import { validatePlan, PlanError } from "./validate.js";
import { toManagedAgentParams, coordinatorRoster } from "./to-managed-agents.js";
import type { ToolCatalog } from "./types.js";

const catalog: ToolCatalog = [
  {
    name: "petstore",
    title: "Swagger Petstore",
    url: "https://petstore.mcp.altship.io/api/mcp",
    tools: [
      { name: "user.get", description: "Get a user", destructive: false, sensitive: false },
      { name: "user.delete", description: "Delete a user", destructive: true, sensitive: false },
      { name: "store.get", description: "Get an order", destructive: false, sensitive: false },
    ],
  },
];

const agent = (overrides: Record<string, unknown> = {}) => ({
  key: "helper",
  name: "Helper",
  role: "solo",
  model: "claude-opus-5",
  description: "Looks things up",
  instructions: "Help the user.",
  tools: [],
  ...overrides,
});

const plan = (agents: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "Petstore helper",
  description: "Looks up users",
  flow: "single",
  agents,
  gaps: [],
  assumptions: [],
  testPrompts: [],
  ...extra,
});

describe("validatePlan", () => {
  it("drops tools that aren't in the catalog and reports them as gaps", () => {
    const result = validatePlan(
      plan([agent({ tools: [
        { server: "petstore", tool: "user.get", permission: "auto", reason: "look up users" },
        { server: "petstore", tool: "user.invent", permission: "auto", reason: "made up" },
        { server: "slack", tool: "chat.post", permission: "auto", reason: "notify" },
      ] })]),
      catalog,
    );

    expect(result.agents[0].tools.map((t) => t.tool)).toEqual(["user.get"]);
    expect(result.gaps.map((g) => g.capability)).toEqual(["user.invent (petstore)", "chat.post (slack)"]);
  });

  it("forces approval on destructive tools even if the plan says auto", () => {
    const result = validatePlan(
      plan([agent({ tools: [{ server: "petstore", tool: "user.delete", permission: "auto", reason: "cleanup" }] })]),
      catalog,
    );
    expect(result.agents[0].tools[0].permission).toBe("ask");
  });

  it("gives a team exactly one coordinator and unique names", () => {
    const result = validatePlan(
      plan([
        agent({ key: "a", name: "Lead", role: "specialist" }),
        agent({ key: "b", name: "Lead", role: "coordinator" }),
        agent({ key: "c", name: "Self", role: "coordinator" }),
      ]),
      catalog,
    );

    expect(result.flow).toBe("team");
    expect(result.agents.map((a) => a.role)).toEqual(["specialist", "coordinator", "specialist"]);
    expect(new Set(result.agents.map((a) => a.name.toLowerCase())).size).toBe(3);
    expect(result.agents.some((a) => a.name.toLowerCase() === "self")).toBe(false);
  });

  it("makes a one-agent plan single/solo and defaults unknown models", () => {
    const result = validatePlan(plan([agent({ role: "coordinator", model: "gpt-9" })], { flow: "team" }), catalog);
    expect(result.flow).toBe("single");
    expect(result.agents[0].role).toBe("solo");
    expect(result.agents[0].model).toBe("claude-opus-5");
  });

  it("rejects malformed input", () => {
    expect(() => validatePlan({ agents: [] }, catalog)).toThrow(PlanError);
    expect(() => validatePlan({ name: "x", agents: "nope" }, catalog)).toThrow(PlanError);
  });
});

describe("toManagedAgentParams", () => {
  it("declares MCP servers and an allowlisted toolset with per-tool permissions", () => {
    const validated = validatePlan(
      plan([agent({ tools: [
        { server: "petstore", tool: "user.get", permission: "auto", reason: "" },
        { server: "petstore", tool: "user.delete", permission: "auto", reason: "" },
      ] })]),
      catalog,
    );
    const { primary, specialists } = toManagedAgentParams(validated, catalog);

    expect(specialists).toEqual([]);
    expect(primary.params.mcp_servers).toEqual([
      { type: "url", name: "petstore", url: "https://petstore.mcp.altship.io/api/mcp" },
    ]);
    expect(primary.params.tools).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "petstore",
        default_config: { enabled: false },
        configs: [
          { name: "user.get", enabled: true, permission_policy: { type: "always_allow" } },
          { name: "user.delete", enabled: true, permission_policy: { type: "always_ask" } },
        ],
      },
    ]);
  });

  it("splits a team into specialists and a coordinator", () => {
    const validated = validatePlan(
      plan([agent({ key: "lead", name: "Lead", role: "coordinator" }), agent({ key: "orders", name: "Orders", role: "specialist" })]),
      catalog,
    );
    const { primary, specialists } = toManagedAgentParams(validated, catalog);

    expect(primary.key).toBe("lead");
    expect(specialists.map((s) => s.key)).toEqual(["orders"]);
    expect(coordinatorRoster([{ id: "agent_1", version: 1 }])).toEqual({
      type: "coordinator",
      agents: [{ type: "agent", id: "agent_1", version: 1 }],
    });
  });
});
