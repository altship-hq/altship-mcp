import { describe, expect, it } from "vitest";
import { validatePlan, PlanError } from "./validate.js";
import { toManagedAgentParams, coordinatorRoster } from "./to-managed-agents.js";
import { compileFlow } from "./flow.js";
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

describe("built-in tools (no MCP server needed)", () => {
  const webAgent = agent({
    builtinTools: [
      { tool: "web_search", permission: "auto", reason: "find sources" },
      { tool: "web_fetch", permission: "auto", reason: "read them" },
      { tool: "bash", permission: "auto", reason: "crunch numbers" },
      { tool: "web_search", permission: "ask", reason: "duplicate" },
    ],
  });

  it("keeps only the built-in tools the user enabled, reporting the rest as gaps", () => {
    const validated = validatePlan(plan([webAgent]), [], { allowedBuiltins: ["web_search", "web_fetch"] });
    expect(validated.agents[0].builtinTools.map((t) => t.tool)).toEqual(["web_search", "web_fetch"]);
    expect(validated.gaps).toContainEqual(expect.objectContaining({ capability: "Run commands" }));
  });

  it("accepts an agent with no MCP servers and no tools at all", () => {
    const validated = validatePlan(plan([agent()]), []);
    expect(validated.agents[0].tools).toEqual([]);
    expect(validated.agents[0].builtinTools).toEqual([]);
    const { primary } = toManagedAgentParams(validated, []);
    expect(primary.params.mcp_servers).toEqual([]);
    expect(primary.params.tools).toEqual([]);
  });

  it("loads plans saved before built-in tools existed", () => {
    const old = plan([agent({ tools: [{ server: "petstore", tool: "user.get", permission: "auto", reason: "" }] })]);
    delete (old.agents[0] as Record<string, unknown>).builtinTools;
    expect(validatePlan(old, catalog).agents[0].builtinTools).toEqual([]);
  });

  it("emits one allowlisted agent toolset and no MCP servers for a web-only agent", () => {
    const validated = validatePlan(plan([webAgent]), [], { allowedBuiltins: ["web_search", "web_fetch", "bash"] });
    validated.agents[0].builtinTools[2].permission = "ask";
    const { primary } = toManagedAgentParams(validated, []);
    expect(primary.params.mcp_servers).toEqual([]);
    expect(primary.params.tools).toEqual([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "web_search", enabled: true, permission_policy: { type: "always_allow" } },
          { name: "web_fetch", enabled: true, permission_policy: { type: "always_allow" } },
          { name: "bash", enabled: true, permission_policy: { type: "always_ask" } },
        ],
      },
    ]);
  });

  it("combines built-in tools with MCP tools", () => {
    const validated = validatePlan(
      plan([agent({
        tools: [{ server: "petstore", tool: "user.get", permission: "auto", reason: "" }],
        builtinTools: [{ tool: "web_search", permission: "auto", reason: "" }],
      })]),
      catalog,
      { allowedBuiltins: ["web_search"] },
    );
    const types = toManagedAgentParams(validated, catalog).primary.params.tools.map((t) => t.type);
    expect(types).toEqual(["agent_toolset_20260401", "mcp_toolset"]);
  });
});


describe("execution flows", () => {
  const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, ...extra });
  const edge = (source: string, target: string, route?: string) => ({ id: `${source}-${target}`, source, target, ...(route ? { route } : {}) });
  const runner = { model: "claude-sonnet-5", instructions: "Answer in English." };

  // Input → Extract → Router → (India | Japan) → Output, plus a tool step before the output.
  const routed = () =>
    plan(
      [
        agent({ key: "extract", name: "Extract" }),
        agent({ key: "india", name: "India Agent" }),
        agent({ key: "japan", name: "Japan Agent" }),
        agent({ key: "unused", name: "Unused" }),
      ],
      {
        flowGraph: {
          runner,
          nodes: [
            node("in", "input"),
            node("a", "agent", { agentKey: "extract" }),
            node("r", "router", {
              label: "Country",
              rule: "Use the country the request is about.",
              routes: [
                { id: "r1", label: "India" },
                { id: "r2", label: "Japan" },
              ],
            }),
            node("b", "agent", { agentKey: "india" }),
            node("c", "agent", { agentKey: "japan" }),
            node("t", "tool", { tool: { server: "petstore", tool: "user.delete", permission: "auto", reason: "" } }),
            node("out", "output"),
          ],
          edges: [edge("in", "a"), edge("a", "r"), edge("r", "b", "r1"), edge("r", "c", "r2"), edge("b", "t"), edge("c", "out"), edge("t", "out")],
        },
      },
    );

  it("keeps the flow, drops agents it doesn't use, and makes destructive tool steps ask", () => {
    const result = validatePlan(routed(), catalog);
    expect(result.agents.map((a) => a.key)).toEqual(["extract", "india", "japan"]);
    expect(result.agents.every((a) => a.role === "specialist")).toBe(true);
    expect(result.flowGraph!.runner).toEqual(runner);
    expect(result.flowGraph!.nodes.find((n) => n.id === "t")!.tool).toMatchObject({ tool: "user.delete", permission: "ask" });
  });

  it("compiles to a coordinator that follows the flow, with the agents as specialists and tool steps as its tools", () => {
    const compiled = compileFlow(validatePlan(routed(), catalog));
    expect(compiled.flowGraph).toBeUndefined();
    expect(compiled.flow).toBe("team");
    const [coordinator, ...specialists] = compiled.agents;
    expect(coordinator).toMatchObject({ role: "coordinator", model: "claude-sonnet-5" });
    expect(specialists.map((a) => a.name)).toEqual(["Extract", "India Agent", "Japan Agent"]);
    expect(coordinator.tools.map((t) => t.tool)).toEqual(["user.delete"]);

    const text = coordinator.instructions;
    expect(text).toContain("Start with step 1");
    expect(text).toContain('Step 1. Hand the user\'s request to the agent "Extract"');
    expect(text).toContain("Rule: Use the country the request is about.");
    expect(text).toMatch(/- India: go to step 3/);
    expect(text).toMatch(/- Japan: go to step 4/);
    expect(text).toContain('Call the tool "user.delete" (from the petstore server) yourself');
    expect(text).toContain("Answer in English.");

    const params = toManagedAgentParams(compiled, catalog);
    expect(params.primary.key).toBe(coordinator.key);
    expect(params.specialists).toHaveLength(3);
  });

  it("runs Input → agent → Output as that agent alone", () => {
    const simple = plan([agent()], {
      flowGraph: { runner, nodes: [node("in", "input"), node("a", "agent", { agentKey: "helper" }), node("out", "output")], edges: [edge("in", "a"), edge("a", "out")] },
    });
    const compiled = compileFlow(validatePlan(simple, catalog));
    expect(compiled.flow).toBe("single");
    expect(compiled.agents).toHaveLength(1);
    expect(compiled.agents[0]).toMatchObject({ key: "helper", role: "solo", instructions: "Help the user." });
  });

  it("runs a flow with no agents as the coordinator on its own", () => {
    const toolOnly = plan([], {
      flowGraph: {
        runner,
        nodes: [node("in", "input"), node("t", "tool", { tool: { server: "petstore", tool: "user.get", permission: "auto", reason: "" } }), node("out", "output")],
        edges: [edge("in", "t"), edge("t", "out")],
      },
    });
    const compiled = compileFlow(validatePlan(toolOnly, catalog));
    expect(compiled.agents).toHaveLength(1);
    expect(compiled.agents[0].role).toBe("solo");
    expect(compiled.agents[0].tools.map((t) => t.tool)).toEqual(["user.get"]);
  });

  it("follows an agent's key when it is normalized", () => {
    const renamed = plan([agent({ key: "My Helper!" })], {
      flowGraph: { runner, nodes: [node("in", "input"), node("a", "agent", { agentKey: "My Helper!" }), node("out", "output")], edges: [edge("in", "a"), edge("a", "out")] },
    });
    const result = validatePlan(renamed, catalog);
    expect(result.flowGraph!.nodes[1].agentKey).toBe(result.agents[0].key);
  });

  it.each([
    ["no output", (f: any) => (f.nodes = f.nodes.filter((n: any) => n.type !== "output")) && (f.edges = f.edges.filter((e: any) => e.target !== "out")), /Output/],
    ["a step with nothing after it", (f: any) => (f.edges = f.edges.filter((e: any) => e.source !== "c")), /isn't connected to a next step/],
    ["an unconnected route", (f: any) => (f.edges = f.edges.filter((e: any) => e.route !== "r2")), /Route "Japan"/],
    ["an unreachable step", (f: any) => f.nodes.push(node("x", "output")), /can't be reached/],
    ["a router with no rule", (f: any) => (f.nodes.find((n: any) => n.id === "r").rule = " "), /needs a rule/],
    ["a tool that isn't in the catalog", (f: any) => (f.nodes.find((n: any) => n.id === "t").tool.tool = "user.explode"), /isn't on the MCP servers/],
    ["an agent step without its agent", (f: any) => (f.nodes.find((n: any) => n.id === "a").agentKey = "ghost"), /isn't in the plan/],
    ["a second input", (f: any) => f.nodes.push(node("in2", "input")), /exactly one Input/],
  ])("rejects a flow with %s", (_name, breakIt, message) => {
    const broken = routed();
    breakIt((broken as any).flowGraph);
    expect(() => validatePlan(broken, catalog)).toThrow(PlanError);
    expect(() => validatePlan(broken, catalog)).toThrow(message);
  });
});
