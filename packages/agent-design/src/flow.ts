import { AGENT_MODELS, type AgentFlow, type AgentModel, type AgentPlan, type FlowEdge, type FlowNode, type PlannedAgent } from "./types.js";

// Execution flows: checking one the user drew, and turning it into the agents
// that run it. A flow runs as a coordinator whose instructions are the flow
// written out step by step; the agents in it are the coordinator's specialists,
// and the tools its tool steps call are the coordinator's own tools.

export const MAX_FLOW_NODES = 60;
export const MAX_ROUTES = 12;

/** Thrown for a flow that can't run as drawn; the message says what to fix. */
export class FlowError extends Error {}

const NODE_TYPES = new Set<FlowNode["type"]>(["input", "output", "agent", "router", "tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** What a step is called in messages and in the coordinator's instructions. */
function nodeName(node: FlowNode, agents: Map<string, PlannedAgent>): string {
  switch (node.type) {
    case "input":
      return "Input";
    case "output":
      return "Output";
    case "agent":
      return agents.get(node.agentKey ?? "")?.name ?? "Agent";
    case "router":
      return node.label || "Router";
    case "tool":
      return node.label || node.tool?.tool || node.builtinTool?.tool || "Tool";
  }
}

/**
 * Checks the structure of a flow (treat it as untrusted) and returns a
 * normalized copy. `agentKeys` are the plan's agents; tool steps are checked
 * against the catalog by the caller (validatePlan), which owns that logic.
 */
export function normalizeFlow(raw: unknown, agentKeys: Set<string>): AgentFlow {
  if (!isRecord(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new FlowError("The flow must have nodes and edges.");
  }
  if (raw.nodes.length > MAX_FLOW_NODES) throw new FlowError(`A flow can have at most ${MAX_FLOW_NODES} steps.`);

  const ids = new Set<string>();
  const nodes: FlowNode[] = raw.nodes.map((n, i) => {
    if (!isRecord(n)) throw new FlowError(`Step ${i + 1} isn't valid.`);
    const id = text(n.id, 64);
    const type = n.type as FlowNode["type"];
    if (!id || ids.has(id)) throw new FlowError("Every step needs its own id.");
    if (!NODE_TYPES.has(type)) throw new FlowError(`Step ${i + 1} has an unknown type.`);
    ids.add(id);

    const position = isRecord(n.position) ? n.position : {};
    const node: FlowNode = {
      id,
      type,
      position: { x: Number.isFinite(position.x) ? Number(position.x) : 0, y: Number.isFinite(position.y) ? Number(position.y) : 0 },
    };
    if (type === "agent") {
      node.agentKey = text(n.agentKey, 64);
      if (!agentKeys.has(node.agentKey)) throw new FlowError("An agent step points at an agent that isn't in the plan.");
    }
    if (type === "router") {
      node.label = text(n.label, 80) || "Router";
      node.rule = text(n.rule, 2000);
      const routeIds = new Set<string>();
      node.routes = (Array.isArray(n.routes) ? n.routes : []).slice(0, MAX_ROUTES).map((r) => {
        const route = { id: text(isRecord(r) ? r.id : "", 64), label: text(isRecord(r) ? r.label : "", 200) };
        if (!route.id || routeIds.has(route.id)) throw new FlowError(`Router "${node.label}" has a route without its own id.`);
        if (!route.label) throw new FlowError(`Every route of router "${node.label}" needs a label saying when to take it.`);
        routeIds.add(route.id);
        return route;
      });
      if (node.routes.length < 2) throw new FlowError(`Router "${node.label}" needs at least two routes.`);
      if (!node.rule) throw new FlowError(`Router "${node.label}" needs a rule saying how to choose a route.`);
    }
    if (type === "tool") {
      node.label = text(n.label, 80);
      // Kept as given; validatePlan replaces them with catalog-checked copies.
      if (isRecord(n.tool)) node.tool = n.tool as unknown as FlowNode["tool"];
      else if (isRecord(n.builtinTool)) node.builtinTool = n.builtinTool as unknown as FlowNode["builtinTool"];
      else throw new FlowError("A tool step needs a tool to call.");
    }
    return node;
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenEdges = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const e of raw.edges) {
    if (!isRecord(e)) throw new FlowError("A connection isn't valid.");
    const source = byId.get(text(e.source, 64));
    const target = byId.get(text(e.target, 64));
    if (!source || !target) throw new FlowError("A connection points at a step that doesn't exist.");
    if (source.type === "output") throw new FlowError("Nothing can come after an Output.");
    if (target.type === "input") throw new FlowError("Nothing can lead into the Input.");
    if (source.id === target.id) throw new FlowError("A step can't connect to itself.");
    const route = source.type === "router" ? text(e.route, 64) : undefined;
    if (source.type === "router" && !source.routes!.some((r) => r.id === route)) {
      throw new FlowError(`A connection from router "${source.label}" isn't attached to one of its routes.`);
    }
    const key = `${source.id}>${route ?? ""}>${target.id}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ id: text(e.id, 64) || `e${edges.length + 1}`, source: source.id, target: target.id, ...(route ? { route } : {}) });
  }

  const inputs = nodes.filter((n) => n.type === "input");
  if (inputs.length !== 1) throw new FlowError("A flow needs exactly one Input.");
  if (!nodes.some((n) => n.type === "output")) throw new FlowError("A flow needs an Output.");

  const noAgents = new Map<string, PlannedAgent>();
  for (const node of nodes) {
    if (node.type === "output") continue;
    const outgoing = edges.filter((e) => e.source === node.id);
    if (node.type === "router") {
      const unconnected = node.routes!.find((r) => !outgoing.some((e) => e.route === r.id));
      if (unconnected) throw new FlowError(`Route "${unconnected.label}" of router "${node.label}" isn't connected to anything.`);
    } else if (outgoing.length === 0) {
      throw new FlowError(`"${nodeName(node, noAgents)}" isn't connected to a next step. Connect it, or to an Output.`);
    }
  }

  // Everything must be reachable from the Input, or it would never run.
  const reached = new Set<string>([inputs[0].id]);
  for (const queue = [inputs[0].id]; queue.length > 0; ) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.source === id && !reached.has(e.target)) {
        reached.add(e.target);
        queue.push(e.target);
      }
    }
  }
  const stranded = nodes.find((n) => !reached.has(n.id));
  if (stranded) throw new FlowError(`"${nodeName(stranded, noAgents)}" can't be reached from the Input. Connect it or remove it.`);
  if (!nodes.some((n) => n.type === "output" && reached.has(n.id))) throw new FlowError("The flow never reaches an Output.");

  const runner = isRecord(raw.runner) ? raw.runner : {};
  return {
    nodes,
    edges,
    runner: {
      model: AGENT_MODELS.includes(runner.model as AgentModel) ? (runner.model as AgentModel) : AGENT_MODELS[0],
      instructions: text(runner.instructions, 8000),
    },
  };
}

/** The flow's steps in the order they're numbered: breadth-first from the Input. */
function orderedSteps(flow: AgentFlow): FlowNode[] {
  const input = flow.nodes.find((n) => n.type === "input")!;
  const order: FlowNode[] = [];
  const seen = new Set<string>([input.id]);
  for (const queue = [input]; queue.length > 0; ) {
    const node = queue.shift()!;
    order.push(node);
    for (const edge of flow.edges.filter((e) => e.source === node.id)) {
      const next = flow.nodes.find((n) => n.id === edge.target)!;
      if (!seen.has(next.id)) {
        seen.add(next.id);
        queue.push(next);
      }
    }
  }
  return order;
}

/** The flow written out as the coordinator's instructions: one numbered step per node. */
export function flowInstructions(flow: AgentFlow, agents: PlannedAgent[]): string {
  const agentsByKey = new Map(agents.map((a) => [a.key, a]));
  const steps = orderedSteps(flow).filter((n) => n.type !== "input");
  const number = new Map(steps.map((n, i) => [n.id, i + 1]));
  const input = flow.nodes.find((n) => n.type === "input")!;
  const ref = (id: string) => `step ${number.get(id)}`;

  const takes = (node: FlowNode): string => {
    const sources = [...new Set(flow.edges.filter((e) => e.target === node.id).map((e) => e.source))];
    const parts = sources.map((id) => (id === input.id ? "the user's request" : `the result of ${ref(id)}`));
    if (parts.length === 0) return "the user's request";
    return parts.length === 1 ? parts[0] : `whichever of these you have: ${parts.join("; ")}`;
  };
  const then = (node: FlowNode): string => {
    const targets = flow.edges.filter((e) => e.source === node.id).map((e) => ref(e.target));
    return targets.length === 1 ? `Then go to ${targets[0]}.` : `Then do each of these with the result: ${targets.join(", ")}.`;
  };

  const lines = steps.map((node) => {
    const head = `Step ${number.get(node.id)}`;
    switch (node.type) {
      case "agent": {
        const agent = agentsByKey.get(node.agentKey!)!;
        return `${head}. Hand ${takes(node)} to the agent "${agent.name}" and wait for its answer. ${then(node)}`;
      }
      case "tool": {
        const tool = node.tool ? `"${node.tool.tool}" (from the ${node.tool.server} server)` : `"${node.builtinTool!.tool}"`;
        return `${head}. Call the tool ${tool} yourself, building its input from ${takes(node)}. ${then(node)}`;
      }
      case "router": {
        const routes = node.routes!.map((route) => {
          const targets = flow.edges.filter((e) => e.source === node.id && e.route === route.id).map((e) => ref(e.target));
          return `  - ${route.label}: go to ${targets.join(" and ")}, passing along what you were given.`;
        });
        return `${head}. Decide which way to go, looking at ${takes(node)}. Rule: ${node.rule}\n${routes.join("\n")}\n  Take exactly one route. If none fits, tell the user which choice you couldn't make and stop.`;
      }
      default:
        return `${head}. Finish: reply to the user with ${takes(node)}, without adding steps of your own.`;
    }
  });

  const first = flow.edges.filter((e) => e.source === input.id).map((e) => ref(e.target));
  return [
    "You run a fixed workflow. Follow the steps below exactly: don't skip, reorder or add steps, and don't do an agent's work yourself.",
    `Start with ${first.length === 1 ? first[0] : `each of these: ${first.join(", ")}`}, using the user's request.`,
    "",
    ...lines,
    "",
    "If a step fails or an agent can't do its part, stop and tell the user which step failed and why.",
    ...(flow.runner.instructions ? ["", "Additional guidance:", flow.runner.instructions] : []),
  ].join("\n");
}

/** True when the flow is just Input → one agent → Output: that agent can run on its own. */
function isSingleAgentFlow(flow: AgentFlow): boolean {
  if (flow.nodes.length !== 3 || flow.edges.length !== 2) return false;
  const agent = flow.nodes.find((n) => n.type === "agent");
  const input = flow.nodes.find((n) => n.type === "input");
  const output = flow.nodes.find((n) => n.type === "output");
  if (!agent || !input || !output) return false;
  return flow.edges.some((e) => e.source === input.id && e.target === agent.id) && flow.edges.some((e) => e.source === agent.id && e.target === output.id);
}

/**
 * The agents that run a plan. A plan without a flow is returned as is. With
 * one, the result is a coordinator whose instructions are the flow, with the
 * flow's agents as its specialists and its tool steps' tools as its own
 * (or just the one agent, when the flow is Input → agent → Output).
 */
export function compileFlow(plan: AgentPlan): AgentPlan {
  const flow = plan.flowGraph;
  if (!flow) return plan;
  const { flowGraph: _flow, ...rest } = plan;

  const used = new Set(flow.nodes.filter((n) => n.type === "agent").map((n) => n.agentKey!));
  const specialists = plan.agents.filter((a) => used.has(a.key)).map((a) => ({ ...a, role: "specialist" as const }));
  if (isSingleAgentFlow(flow)) {
    return { ...rest, flow: "single", agents: [{ ...specialists[0], role: "solo" }] };
  }

  const tools = new Map<string, NonNullable<FlowNode["tool"]>>();
  const builtinTools = new Map<string, NonNullable<FlowNode["builtinTool"]>>();
  for (const node of flow.nodes) {
    if (node.tool) tools.set(`${node.tool.server}/${node.tool.tool}`, node.tool);
    if (node.builtinTool) builtinTools.set(node.builtinTool.tool, node.builtinTool);
  }

  const taken = (value: string, field: "key" | "name") => specialists.some((a) => a[field].toLowerCase() === value.toLowerCase());
  let key = "flow-coordinator";
  for (let n = 2; taken(key, "key"); n++) key = `flow-coordinator-${n}`;
  let name = `${plan.name} coordinator`;
  for (let n = 2; taken(name, "name"); n++) name = `${plan.name} coordinator ${n}`;

  const coordinator: PlannedAgent = {
    key,
    name,
    role: specialists.length > 0 ? "coordinator" : "solo",
    model: flow.runner.model,
    description: plan.description || `Runs the ${plan.name} workflow.`,
    instructions: flowInstructions(flow, specialists),
    tools: [...tools.values()],
    builtinTools: [...builtinTools.values()],
  };
  return { ...rest, flow: specialists.length > 0 ? "team" : "single", agents: [coordinator, ...specialists] };
}
