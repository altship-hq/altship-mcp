import type { AgentFlow, AgentPlan, FlowNode, PlannedAgent } from "./types.js";

// Running a flow as drawn. The flow's coordinator is given one step at a
// time; whoever drives the run (the API) checks that the step really happened
// before working out the next one from the graph, and decides routers itself.
// So the order, the branching and which agent or tool does each step are the
// system's, not something a model is trusted to follow.
//
// This file is the part with no I/O: the run's state and how it moves, the
// message for each step, and the check that a step was carried out.

/** Most steps one pass through a flow may take; a flow that loops stops here. */
export const MAX_FLOW_STEPS = 40;
/** How a coordinator says it couldn't do a step. */
export const STEP_FAILED = "STEP FAILED:";
/** Longest step result kept in the run's state. */
const MAX_RESULT_LENGTH = 20_000;

const STEP_OPEN = "<altship-step>";
const STEP_CLOSE = "</altship-step>";
const REQUEST_LEAD = "The user's request:\n";

/** Where one pass through a flow has got to. Plain JSON, kept with the run. */
export interface FlowRunState {
  /** What the user asked for on this pass. */
  request: string;
  /** Steps waiting their turn, by node id. */
  queue: string[];
  /** The step that has been sent and not yet checked. */
  current: string | null;
  /** How many times `current` has been asked again. */
  attempts: number;
  /** What each finished step came back with, by node id. */
  results: Record<string, string>;
  /** The route taken at each router, by node id. */
  routes: Record<string, string>;
  /** A router decision the next step's message should mention. */
  note: { router: string; route: string } | null;
  steps: number;
  status: "running" | "done" | "failed";
  output: string | null;
  error: string | null;
}

export type FlowAction =
  /** Send this step to the coordinator. */
  | { kind: "step"; node: FlowNode }
  /** Decide which way this router goes. */
  | { kind: "route"; node: FlowNode }
  | { kind: "done"; output: string }
  | { kind: "failed"; error: string };

/** What a step's message says about itself, for whoever shows the run. */
export interface StepHeader {
  node: string;
  name: string;
  kind: FlowNode["type"];
  /** "Router: route taken" when a router led here. */
  route: string | null;
  retry: boolean;
  /** Length of the user's request carried in the message; 0 when it carries none. */
  request: number;
}

/** True when the flow is just Input → one agent → Output: that agent can run on its own. */
export function isSingleAgentFlow(flow: AgentFlow): boolean {
  if (flow.nodes.length !== 3 || flow.edges.length !== 2) return false;
  const agent = flow.nodes.find((n) => n.type === "agent");
  const input = flow.nodes.find((n) => n.type === "input");
  const output = flow.nodes.find((n) => n.type === "output");
  if (!agent || !input || !output) return false;
  return flow.edges.some((e) => e.source === input.id && e.target === agent.id) && flow.edges.some((e) => e.source === agent.id && e.target === output.id);
}

/** True when the plan runs step by step under the system's control (not a single agent, and not an agent saved before flows were enforced). */
export function runsAsFlow(plan: AgentPlan): plan is AgentPlan & { flowGraph: AgentFlow } {
  const flow = plan.flowGraph;
  return flow?.enforced === true && !isSingleAgentFlow(flow);
}

const nodeOf = (flow: AgentFlow, id: string) => flow.nodes.find((n) => n.id === id)!;
const inputOf = (flow: AgentFlow) => flow.nodes.find((n) => n.type === "input")!;

export function stepName(node: FlowNode, agents: PlannedAgent[]): string {
  switch (node.type) {
    case "input":
      return "Input";
    case "output":
      return "Output";
    case "agent":
      return agents.find((a) => a.key === node.agentKey)?.name ?? "Agent";
    case "router":
      return node.label || "Router";
    case "tool":
      return node.label || node.tool?.tool || node.builtinTool?.tool || "Tool";
  }
}

export function startFlow(flow: AgentFlow, request: string): FlowRunState {
  const input = inputOf(flow);
  return {
    request,
    queue: [...new Set(flow.edges.filter((e) => e.source === input.id).map((e) => e.target))],
    current: null,
    attempts: 0,
    results: { [input.id]: request },
    routes: {},
    note: null,
    steps: 0,
    status: "running",
    output: null,
    error: null,
  };
}

function reaches(flow: AgentFlow, from: string, to: string): boolean {
  const seen = new Set([from]);
  for (const queue = [from]; queue.length > 0; ) {
    const id = queue.shift()!;
    for (const edge of flow.edges) {
      if (edge.source !== id || seen.has(edge.target)) continue;
      if (edge.target === to) return true;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return false;
}

/**
 * The next step to take from the queue: the first one that nothing else
 * waiting still leads into, so a step fed by several others runs after them.
 * (Steps in a loop lead into each other; then the first waiting goes.)
 */
function pick(flow: AgentFlow, queue: string[]): string {
  return queue.find((id) => !queue.some((other) => other !== id && reaches(flow, other, id) && !reaches(flow, id, other))) ?? queue[0];
}

/** Results feeding a step, following routers back to what they passed along. */
function sourcesOf(flow: AgentFlow, state: FlowRunState, node: FlowNode, seen = new Set<string>()): string[] {
  seen.add(node.id);
  const ids: string[] = [];
  for (const edge of flow.edges.filter((e) => e.target === node.id)) {
    const source = nodeOf(flow, edge.source);
    if (!(source.id in state.results) || seen.has(source.id)) continue;
    // Only the route that was taken carried anything.
    if (source.type === "router" && state.routes[source.id] !== edge.route) continue;
    if (source.type === "router") ids.push(...sourcesOf(flow, state, source, seen));
    else ids.push(source.id);
  }
  return [...new Set(ids)];
}

const finish = (state: FlowRunState, patch: Partial<FlowRunState>): FlowRunState => ({ ...state, current: null, queue: [], ...patch });

/**
 * What to do next, and the state after any steps that needed no one (an
 * Output that just passes one result on). Call `beginStep` or `chooseRoute`
 * with the result when acting on it.
 */
export function nextAction(flow: AgentFlow, state: FlowRunState): { action: FlowAction; state: FlowRunState } {
  let next = state;
  for (;;) {
    if (next.status !== "running") {
      return { action: next.status === "done" ? { kind: "done", output: next.output ?? "" } : { kind: "failed", error: next.error ?? "The flow failed." }, state: next };
    }
    if (next.queue.length === 0) {
      // Finished: the answer is what reached the Output(s), or failing that the last result.
      const outputs = flow.nodes.filter((n) => n.type === "output" && n.id in next.results).map((n) => next.results[n.id]);
      const output = outputs.length > 0 ? outputs.join("\n\n") : (Object.values(next.results).at(-1) ?? "");
      next = finish(next, { status: "done", output });
      continue;
    }
    if (next.steps >= MAX_FLOW_STEPS) {
      next = finish(next, { status: "failed", error: `The flow took more than ${MAX_FLOW_STEPS} steps without finishing, so it was stopped. It may loop back on itself.` });
      continue;
    }
    const node = nodeOf(flow, pick(flow, next.queue));
    if (node.type === "router") return { action: { kind: "route", node }, state: next };
    if (node.type === "output") {
      const sources = sourcesOf(flow, next, node);
      // Several results arriving at one Output are put together by the coordinator.
      if (sources.length > 1) return { action: { kind: "step", node }, state: next };
      next = { ...next, queue: next.queue.filter((id) => id !== node.id), results: { ...next.results, [node.id]: sources[0] ? next.results[sources[0]] : "" } };
      continue;
    }
    return { action: { kind: "step", node }, state: next };
  }
}

/** The step has been sent to the coordinator. */
export function beginStep(state: FlowRunState, nodeId: string): FlowRunState {
  return { ...state, current: nodeId, attempts: 0, queue: state.queue.filter((id) => id !== nodeId), steps: state.steps + 1, note: null };
}

/** The step was asked again after it wasn't carried out. */
export function retryStep(state: FlowRunState): FlowRunState {
  return { ...state, attempts: state.attempts + 1 };
}

const enqueue = (queue: string[], ids: string[]) => [...queue, ...ids.filter((id, i) => !queue.includes(id) && ids.indexOf(id) === i)];

/** The current step was carried out and came back with `result`. */
export function completeStep(flow: AgentFlow, state: FlowRunState, result: string): FlowRunState {
  const id = state.current!;
  const targets = flow.edges.filter((e) => e.source === id).map((e) => e.target);
  return { ...state, current: null, attempts: 0, results: { ...state.results, [id]: result.slice(0, MAX_RESULT_LENGTH) }, queue: enqueue(state.queue, targets) };
}

/** The router goes down `routeId`; null when no route fits, which stops the flow. */
export function chooseRoute(flow: AgentFlow, state: FlowRunState, nodeId: string, routeId: string | null): FlowRunState {
  const node = nodeOf(flow, nodeId);
  const route = node.routes?.find((r) => r.id === routeId);
  if (!route) return finish(state, { status: "failed", error: `None of the routes at "${node.label}" fit this request, so the flow stopped there.` });
  const targets = flow.edges.filter((e) => e.source === nodeId && e.route === route.id).map((e) => e.target);
  return {
    ...state,
    queue: enqueue(state.queue.filter((id) => id !== nodeId), targets),
    results: { ...state.results, [nodeId]: "" },
    routes: { ...state.routes, [nodeId]: route.id },
    note: { router: node.label ?? "Router", route: route.label },
    steps: state.steps + 1,
  };
}

export function failFlow(state: FlowRunState, error: string): FlowRunState {
  return finish(state, { status: "failed", error });
}

/** In words, what a step works from. */
function takes(flow: AgentFlow, agents: PlannedAgent[], state: FlowRunState, node: FlowNode): string {
  const input = inputOf(flow);
  const parts = sourcesOf(flow, state, node).map((id) => (id === input.id ? "the user's request" : `the result of the step "${stepName(nodeOf(flow, id), agents)}"`));
  if (parts.length === 0) return "the user's request";
  return parts.length === 1 ? parts[0] : parts.join(" and ");
}

function withHeader(header: StepHeader, request: string, body: string): string {
  return `${STEP_OPEN}${JSON.stringify(header)}${STEP_CLOSE}\n${request ? `${REQUEST_LEAD}${request}\n\n` : ""}${body}`;
}

/**
 * The message that asks the coordinator to do one step. `withRequest` puts
 * the user's request in it, for the first step of a pass (the coordinator
 * hasn't seen it otherwise).
 */
export function stepMessage(flow: AgentFlow, agents: PlannedAgent[], state: FlowRunState, node: FlowNode, withRequest: boolean): string {
  const from = takes(flow, agents, state, node);
  const name = stepName(node, agents);
  const routed = state.note ? `The route chosen at "${state.note.router}" was: ${state.note.route}.\n` : "";
  let body: string;
  if (node.type === "agent") {
    body = `Hand ${from} to the agent "${name}" and wait for its answer. Do nothing else, and write nothing before handing it over. When it answers, reply with its answer exactly as it gave it, with no introduction or comment of your own, and stop.`;
  } else if (node.type === "tool") {
    const tool = node.tool ? `"${node.tool.tool}" (from the ${node.tool.server} server)` : `"${node.builtinTool!.tool}"`;
    body = `Call the tool ${tool} yourself, once, building its input from ${from}. Do nothing else, and write nothing before calling it. Then reply with what it returned, with no introduction or comment of your own, and stop.`;
  } else {
    body = `Reply to the user with ${from}, put together in that order, without leaving anything out or adding anything of your own.`;
  }
  const request = withRequest ? state.request : "";
  return withHeader({ node: node.id, name, kind: node.type, route: state.note ? `${state.note.router}: ${state.note.route}` : null, retry: false, request: request.length }, request, `${routed}${body}`);
}

/** Asks for the current step again, saying what was missing. */
export function retryMessage(node: FlowNode, agents: PlannedAgent[], why: string): string {
  const header: StepHeader = { node: node.id, name: stepName(node, agents), kind: node.type, route: null, retry: true, request: 0 };
  return withHeader(header, "", `That step wasn't carried out: ${why} Do it now, exactly as it was described, and reply with the result.`);
}

/** Reads a step message back: its header, the user's request it carried (if any) and the rest. Null for any other message. */
export function parseStepMessage(text: string): { header: StepHeader; request: string | null; body: string } | null {
  if (!text.startsWith(STEP_OPEN)) return null;
  const end = text.indexOf(STEP_CLOSE);
  if (end === -1) return null;
  try {
    const header = JSON.parse(text.slice(STEP_OPEN.length, end)) as StepHeader;
    if (typeof header.node !== "string" || typeof header.name !== "string") return null;
    let rest = text.slice(end + STEP_CLOSE.length).replace(/^\n/, "");
    let request: string | null = null;
    if (header.request > 0 && rest.startsWith(REQUEST_LEAD)) {
      request = rest.slice(REQUEST_LEAD.length, REQUEST_LEAD.length + header.request);
      rest = rest.slice(REQUEST_LEAD.length + header.request).replace(/^\n+/, "");
    }
    return { header, request, body: rest };
  } catch {
    return null;
  }
}

/** What the coordinator did in answer to a step, as seen in the session's events. */
export interface StepEvidence {
  /** Names of the agents it handed work to. */
  delegatedTo: string[];
  /** Names of the tools it called itself. */
  toolsCalled: string[];
  /** What agents answered it with, in order. */
  answers: { agent: string; text: string }[];
  /** Everything it wrote in reply, and the last thing alone. */
  reply: string;
  lastMessage: string;
}

/**
 * What a step came back with. For an agent step that's the agent's own
 * answer, word for word, not the coordinator's account of it; otherwise the
 * coordinator's closing message.
 */
export function stepResult(node: FlowNode, agents: PlannedAgent[], evidence: StepEvidence): string {
  if (node.type === "agent") {
    const name = stepName(node, agents).toLowerCase();
    const answer = evidence.answers.filter((a) => a.agent.toLowerCase() === name).at(-1);
    if (answer?.text.trim()) return answer.text;
  }
  return evidence.lastMessage || evidence.reply;
}

/** Whether the step was really carried out. `fatal` when the coordinator said it couldn't, which asking again won't fix. */
export function verifyStep(node: FlowNode, agents: PlannedAgent[], evidence: StepEvidence): { ok: true } | { ok: false; why: string; fatal: boolean } {
  if (evidence.reply.trimStart().startsWith(STEP_FAILED)) {
    return { ok: false, fatal: true, why: evidence.reply.trim().slice(STEP_FAILED.length).trim() || "The step couldn't be done." };
  }
  if (node.type === "agent") {
    const name = stepName(node, agents);
    if (!evidence.delegatedTo.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return { ok: false, fatal: false, why: `the work wasn't handed to the agent "${name}".` };
    }
  }
  if (node.type === "tool") {
    const tool = node.tool?.tool ?? node.builtinTool!.tool;
    if (!evidence.toolsCalled.includes(tool)) return { ok: false, fatal: false, why: `the tool "${tool}" wasn't called.` };
  }
  return { ok: true };
}

/** The coordinator's standing instructions when the system runs the flow: do the one step it's sent, nothing more. */
export function enforcedInstructions(plan: Pick<AgentPlan, "name" | "description">, flow: AgentFlow): string {
  return [
    `You carry out the "${plan.name}" workflow${plan.description ? ` (${plan.description})` : ""}, one step at a time. You don't decide the steps or their order: each arrives as a message that begins with ${STEP_OPEN}.`,
    "",
    "For each step message:",
    "- Do exactly what it says and nothing more. Don't start the next step, don't repeat an earlier one, and don't do an agent's work yourself: when a step says to hand something to an agent, hand it over and wait.",
    "- Earlier steps' results are above in this conversation; use the ones the step names.",
    "- When the step is done, reply with its result in full and stop. The next step will be sent to you.",
    `- If you can't do the step, reply with "${STEP_FAILED}" followed by why, and stop.`,
    "",
    `A message that doesn't begin with ${STEP_OPEN} is not a step: reply only "Ready." and wait.`,
    ...(flow.runner.instructions ? ["", "Additional guidance:", flow.runner.instructions] : []),
  ].join("\n");
}

/** What a router is deciding, for the model call that picks a route. */
export function routeQuestion(flow: AgentFlow, agents: PlannedAgent[], state: FlowRunState, node: FlowNode): { rule: string; routes: { id: string; label: string }[]; context: string } {
  const input = inputOf(flow);
  const sources = sourcesOf(flow, state, node);
  const parts = [`<request>\n${state.request}\n</request>`];
  for (const id of sources) {
    if (id !== input.id) parts.push(`<result step="${stepName(nodeOf(flow, id), agents)}">\n${state.results[id]}\n</result>`);
  }
  return { rule: node.rule ?? "", routes: node.routes ?? [], context: parts.join("\n\n") };
}
