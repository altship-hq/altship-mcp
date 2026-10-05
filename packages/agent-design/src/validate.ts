import {
  AGENT_MODELS,
  BUILTIN_GROUPS,
  BUILTIN_TOOLS,
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
 */
export interface ValidateOptions {
  /** Built-in tools the user enabled for this agent; others are dropped. */
  allowedBuiltins?: readonly BuiltinTool[];
}

export function validatePlan(raw: unknown, catalog: ToolCatalog, options: ValidateOptions = {}): AgentPlan {
  const allowedBuiltins = new Set(options.allowedBuiltins ?? []);
  const input = asObject(raw, "plan");
  const agentsIn = asArray(input.agents, "plan.agents");
  if (agentsIn.length === 0) throw new PlanError("A plan needs at least one agent.");

  const gaps: PlanGap[] = asArray(input.gaps ?? [], "plan.gaps").map((g, i) => {
    const gap = asObject(g, `plan.gaps[${i}]`);
    return { capability: asString(gap.capability, "gap.capability"), suggestion: asString(gap.suggestion ?? "", "gap.suggestion") };
  });

  const usedKeys = new Set<string>();
  const usedNames = new Set<string>();
  let agents: PlannedAgent[] = agentsIn.map((a, i) => {
    const agent = asObject(a, `plan.agents[${i}]`);
    const name = uniqueName(asString(agent.name, "agent.name").trim() || `Agent ${i + 1}`, usedNames);
    const key = uniqueKey(slugify(asString(agent.key ?? "", "agent.key")) || slugify(name) || `agent-${i + 1}`, usedKeys);
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

  if (agents.length === 1) {
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
    name: asString(input.name, "plan.name").trim() || agents[0].name,
    description: asString(input.description ?? "", "plan.description").trim(),
    flow: agents.length === 1 ? "single" : "team",
    agents,
    gaps: dedupeGaps(gaps),
    assumptions: asArray(input.assumptions ?? [], "plan.assumptions").map((a) => asString(a, "assumption")),
    testPrompts: asArray(input.testPrompts ?? [], "plan.testPrompts")
      .map((p) => asString(p, "testPrompt"))
      .slice(0, MAX_TEST_PROMPTS),
  };
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
