import { AGENT_PLAN_SCHEMA, validatePlan, type AgentPlan, type ToolCatalog } from "@altship/agent-design";
import { getAnthropic } from "./anthropic.js";

export interface PlanRequest {
  name: string;
  description: string;
  /** Answers to a previous plan's assumptions, or other follow-up direction. */
  feedback?: string;
  previousPlan?: AgentPlan;
  /** MCP server the user started from ("Create agent with this server"). */
  focusServer?: string;
}

export class PlannerError extends Error {}

const SYSTEM_PROMPT = `You design AI agents for altship's Agent Creator. The user names an agent and describes what it should do; you propose a plan they will review and approve before anything is created.

The plan's agents run on Claude and can only use tools from the catalog of MCP servers you are given. Rules:
- Use only tools that appear in the catalog, referenced by the exact server name and tool name. Never invent tools. If the description needs something no catalog tool provides, list it under gaps with a short suggestion instead.
- Least privilege: give each agent only the tools its job needs, and say in one sentence why it needs each one.
- Set permission "ask" for anything that deletes, modifies, sends, pays or is otherwise hard to undo; "auto" for reads. Destructive catalog tools always need "ask".
- Prefer a single agent (flow "single", role "solo"). Use a team (flow "team": one "coordinator" plus "specialist"s) only when the work splits into distinct responsibilities that benefit from separate instructions or tools. The coordinator delegates to specialists by name and description, so describe each specialist's strengths clearly.
- Models: "claude-opus-5" for the solo agent or coordinator; "claude-sonnet-5" for specialists that need judgment; "claude-haiku-4-5" for simple lookup or reading-heavy specialists.
- Instructions are each agent's system prompt: say what it does, how to use its tools, when to stop and ask, and how to format answers. Be concrete and brief.
- Assumptions: list anything you had to assume that the user should confirm (limits, tone, what counts as done). Keep it short; leave empty if nothing is unclear.
- testPrompts: 3 to 5 realistic messages a user would send, including at least one edge case.
- Agent keys are short lowercase slugs; names are short and human-readable, unique within the plan, and never "self".`;

/** One structured-output Claude call: description + catalog in, validated AgentPlan out. */
export async function planAgent(request: PlanRequest, catalog: ToolCatalog): Promise<AgentPlan> {
  const catalogForPrompt = catalog.map((s) => ({
    server: s.name,
    title: s.title,
    tools: s.tools.map((t) => ({
      tool: t.name,
      description: t.description,
      ...(t.destructive ? { destructive: true } : {}),
      ...(t.sensitive ? { sensitive: true } : {}),
    })),
  }));

  const parts = [
    `<catalog>\n${JSON.stringify(catalogForPrompt, null, 2)}\n</catalog>`,
    `<agent_name>${request.name}</agent_name>`,
    `<agent_description>${request.description}</agent_description>`,
  ];
  if (request.focusServer) {
    parts.push(`The user started from the "${request.focusServer}" server, so it is very likely relevant.`);
  }
  if (request.previousPlan) {
    parts.push(`<previous_plan>\n${JSON.stringify(request.previousPlan, null, 2)}\n</previous_plan>`);
  }
  if (request.feedback) {
    parts.push(`<user_feedback>${request.feedback}</user_feedback>\nRevise the previous plan to reflect this feedback.`);
  }

  const response = await getAnthropic().beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: AGENT_PLAN_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });

  if (response.stop_reason === "refusal") {
    throw new PlannerError("The planner declined this description. Try rephrasing what the agent should do.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new PlannerError("The plan was too long to finish. Try a narrower description.");
  }

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PlannerError("The planner returned an unreadable plan. Try again.");
  }
  return validatePlan(raw, catalog);
}
