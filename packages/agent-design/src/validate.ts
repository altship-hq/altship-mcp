import {
  AGENT_MODELS,
  BUILTIN_GROUPS,
  BUILTIN_TOOLS,
  type AgentFlow,
  type AgentModel,
  type BuiltinTool,
  type AgentPlan,
  type CatalogTool,
  type PlanGap,
  type PlannedAgent,
  type PlannedBuiltinTool,
  type PlannedTool,
  type ToolCatalog,
} from "./types.js";
import { FlowError, normalizeFlow } from "./flow.js";

/** Managed Agents allows 1-20 roster entries on a coordinator. */
export const MAX_SPECIALISTS = 20;
export const MAX_TEST_PROMPTS = 5;

export class PlanError extends Error {}

/**
 * Checks a plan (from the planner or edited by the user — treat both as
 * untrusted) against the real tool catalog and returns a normalized copy:
 * - tools that aren't in the catalog are removed and reported as gaps
 * - built-in tools the user didn't enable are removed and reported as gaps
 * - destructive tools always require approval ("ask")
 * - unknown models fall back to the default model
 * - agent keys and names are unique; a team has exactly one coordinator
 * - a plan with a flow (flowGraph) has the flow checked too: its agents are the
 *   ones its steps use, and its tool steps follow the same rules as agent tools
 */
export interface ValidateOptions {
  /** Built-in tools the user enabled for this agent; others are dropped. */
  allowedBuiltins?: readonly BuiltinTool[];
}

export function validatePlan(raw: unknown, catalog: ToolCatalog, options: ValidateOptions = {}): AgentPlan {
  const allowedBuiltins = new Set(options.allowedBuiltins ?? []);
  const input = asObject(raw, "plan");
  const hasFlow = input.flowGraph !== undefined && input.flowGraph !== null;
  const agentsIn = asArray(input.agents, "plan.agents");
  // A flow can be made of tool steps and routers alone.
  if (agentsIn.length === 0 && !hasFlow) throw new PlanError("A plan needs at least one agent.");

  const gaps: PlanGap[] = asArray(input.gaps ?? [], "plan.gaps").map((g, i) => {
    const gap = asObject(g, `plan.gaps[${i}]`);
    return { capability: asString(gap.capability, "gap.capability"), suggestion: asString(gap.suggestion ?? "", "gap.suggestion") };
  });

  const usedKeys = new Set<string>();
  const usedNames = new Set<string>();
  // Keys can change when normalized; a flow's agent steps follow them.
  const renamedKeys = new Map<string, string>();
  let agents: PlannedAgent[] = agentsIn.map((a, i) => {
    const agent = asObject(a, `plan.agents[${i}]`);
    const name = uniqueName(asString(agent.name, "agent.name").trim() || `Agent ${i + 1}`, usedNames);
    const key = uniqueKey(slugify(asString(agent.key ?? "", "agent.key")) || slugify(name) || `agent-${i + 1}`, usedKeys);
    if (typeof agent.key === "string" && !renamedKeys.has(agent.key)) renamedKeys.set(agent.key, key);
    const tools = normalizeTools(asArray(agent.tools ?? [], `${name}.tools`), catalog, gaps);
    const builtinTools = normalizeBuiltinTools(asArray(agent.builtinTools ?? [], `${name}.builtinTools`), allowedBuiltins, gaps);
    return {
      key,
      name,
      role: agent.role === "coordinator" || agent.role === "specialist" ? agent.role : "solo",
      model: AGENT_MODELS.includes(agent.model as AgentModel) ? (agent.model as AgentModel) : AGENT_MODELS[0],
      description: asString(agent.description ?? "", "agent.description").trim(),
      instructions: asString(agent.instructions ?? "", "agent.instructions").trim(),
      tools,
      builtinTools,
    };
  });

  let flowGraph: AgentFlow | undefined;
  if (hasFlow) {
    flowGraph = validateFlow(input.flowGraph, renamedKeys, new Set(agents.map((a) => a.key)), catalog, allowedBuiltins);
    // Only the agents the flow uses are kept; its runner coordinates them.
    const used = new Set(flowGraph.nodes.map((n) => n.agentKey));
    agents = agents.filter((a) => used.has(a.key)).map((a) => ({ ...a, role: "specialist" }));
    if (agents.length > MAX_SPECIALISTS) throw new PlanError(`A flow can use at most ${MAX_SPECIALISTS} agents.`);
  } else if (agents.length === 1) {
    agents[0].role = "solo";
  } else {
    // Exactly one coordinator: the first one the plan named, else the first agent.
    const coordinatorIndex = Math.max(0, agents.findIndex((a) => a.role === "coordinator"));
    agents = agents.map((a, i) => ({ ...a, role: i === coordinatorIndex ? "coordinator" : "specialist" }));
    if (agents.length - 1 > MAX_SPECIALISTS) {
      throw new PlanError(`A team can have at most ${MAX_SPECIALISTS} specialists.`);
    }
  }

  return {
    name: asString(input.name, "plan.name").trim() || agents[0]?.name || "Agent",
    description: asString(input.description ?? "", "plan.description").trim(),
    flow: agents.length > 1 || (flowGraph && agents.length > 0) ? "team" : "single",
    agents,
    ...(flowGraph ? { flowGraph } : {}),
    gaps: dedupeGaps(gaps),
    assumptions: asArray(input.assumptions ?? [], "plan.assumptions").map((a) => asString(a, "assumption")),
    testPrompts: asArray(input.testPrompts ?? [], "plan.testPrompts")
      .map((p) => asString(p, "testPrompt"))
      .slice(0, MAX_TEST_PROMPTS),
  };
}

/**
 * Checks a flow against the plan's agents and the tool catalog. Unlike an
 * agent's tools, a tool step whose tool isn't available is an error, not a
 * gap: the flow can't run without that step.
 */
function validateFlow(
  raw: unknown,
  renamedKeys: Map<string, string>,
  agentKeys: Set<string>,
  catalog: ToolCatalog,
  allowedBuiltins: Set<BuiltinTool>,
): AgentFlow {
  const rawFlow = asObject(raw, "plan.flowGraph");
  const withKeys = {
    ...rawFlow,
    nodes: asArray(rawFlow.nodes, "plan.flowGraph.nodes").map((n) => {
      const node = asObject(n, "plan.flowGraph.nodes[]");
      return typeof node.agentKey === "string" ? { ...node, agentKey: renamedKeys.get(node.agentKey) ?? node.agentKey } : node;
    }),
  };

  let flow: AgentFlow;
  try {
    flow = normalizeFlow(withKeys, agentKeys);
  } catch (err) {
    if (err instanceof FlowError) throw new PlanError(err.message);
    throw err;
  }

  for (const node of flow.nodes) {
    if (node.type !== "tool") continue;
    const unavailable: PlanGap[] = [];
    if (node.tool) {
      const [tool] = normalizeTools([node.tool], catalog, unavailable);
      if (!tool) throw new PlanError(`A tool step uses "${String((node.tool as { tool?: unknown }).tool)}", which isn't on the MCP servers chosen for this agent.`);
      node.tool = tool;
    } else {
      const [tool] = normalizeBuiltinTools([node.builtinTool], allowedBuiltins, unavailable);
      if (!tool) throw new PlanError("A tool step uses a built-in tool that isn't turned on for this agent.");
      node.builtinTool = tool;
    }
  }
  return flow;
}

function normalizeTools(rawTools: unknown[], catalog: ToolCatalog, gaps: PlanGap[]): PlannedTool[] {
  const seen = new Set<string>();
  const tools: PlannedTool[] = [];

  for (const [i, raw] of rawTools.entries()) {
    const t = asObject(raw, `tools[${i}]`);
    const server = asString(t.server, "tool.server");
    const toolName = asString(t.tool, "tool.tool");
    const catalogTool = findTool(catalog, server, toolName);

    if (!catalogTool) {
      gaps.push({
        capability: `${toolName} (${server})`,
        suggestion: "Not available on your MCP servers. Connect a server that provides it, or build one in MCP Creator.",
      });
      continue;
    }

    const id = `${server}/${toolName}`;
    if (seen.has(id)) continue;
    seen.add(id);

    tools.push({
      server,
      tool: toolName,
      permission: catalogTool.destructive ? "ask" : t.permission === "ask" ? "ask" : "auto",
      reason: asString(t.reason ?? "", "tool.reason"),
    });
  }

  return tools;
}

const BUILTIN_LABELS: Record<BuiltinTool, string> = {
  web_search: "Web search",
  web_fetch: "Read web pages",
  bash: "Run commands",
  read: "Read files",
  write: "Write files",
  edit: "Edit files",
  glob: "Find files",
  grep: "Search files",
};

export function builtinLabel(tool: BuiltinTool): string {
  return BUILTIN_LABELS[tool];
}

function normalizeBuiltinTools(rawTools: unknown[], allowed: Set<BuiltinTool>, gaps: PlanGap[]): PlannedBuiltinTool[] {
  const seen = new Set<BuiltinTool>();
  const tools: PlannedBuiltinTool[] = [];

  for (const [i, raw] of rawTools.entries()) {
    const t = asObject(raw, `builtinTools[${i}]`);
    const tool = asString(t.tool, "builtinTool.tool") as BuiltinTool;
    if (!BUILTIN_TOOLS.includes(tool) || seen.has(tool)) continue;
    if (!allowed.has(tool)) {
      const group = (BUILTIN_GROUPS.web as readonly string[]).includes(tool) ? "Web" : "Code & files";
      gaps.push({ capability: BUILTIN_LABELS[tool], suggestion: `Turn on ${group} for this agent to let it do this.` });
      continue;
    }
    seen.add(tool);
    tools.push({ tool, permission: t.permission === "ask" ? "ask" : "auto", reason: asString(t.reason ?? "", "builtinTool.reason") });
  }

  return tools;
}

export function findTool(catalog: ToolCatalog, server: string, tool: string): CatalogTool | undefined {
  return catalog.find((s) => s.name === server)?.tools.find((t) => t.name === tool);
}

function dedupeGaps(gaps: PlanGap[]): PlanGap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const key = g.capability.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function uniqueKey(key: string, used: Set<string>): string {
  let candidate = key;
  for (let n = 2; used.has(candidate); n++) candidate = `${key}-${n}`;
  used.add(candidate);
  return candidate;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  // "self" is reserved in a Managed Agents roster.
  if (candidate.toLowerCase() === "self") candidate = `${name} agent`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PlanError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PlanError(`${label} must be an array.`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PlanError(`${label} must be a string.`);
  return value;
}
