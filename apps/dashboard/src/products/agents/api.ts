import { API_BASE, apiFetch, deleteJson, getJson, postJson } from "../../http.js";

// Mirrors apps/api/src/agents (router, events) and packages/agent-design types.

export type AgentModel = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";
export type ToolPermission = "auto" | "ask";

export interface PlannedTool {
  server: string;
  tool: string;
  permission: ToolPermission;
  reason: string;
}

/** Built-in tools any agent can be given, no MCP server needed (packages/agent-design BUILTIN_TOOLS). */
export type BuiltinTool = "web_search" | "web_fetch" | "bash" | "read" | "write" | "edit" | "glob" | "grep";

/** How built-in tools are switched on: by group. */
export const BUILTIN_GROUPS: Record<"web" | "sandbox", BuiltinTool[]> = {
  web: ["web_search", "web_fetch"],
  sandbox: ["bash", "read", "write", "edit", "glob", "grep"],
};

export const BUILTIN_LABELS: Record<BuiltinTool, string> = {
  web_search: "Web search",
  web_fetch: "Read web pages",
  bash: "Run commands",
  read: "Read files",
  write: "Write files",
  edit: "Edit files",
  glob: "Find files",
  grep: "Search files",
};

export interface PlannedBuiltinTool {
  tool: BuiltinTool;
  permission: ToolPermission;
  reason: string;
}

export interface PlannedAgent {
  key: string;
  name: string;
  role: "solo" | "coordinator" | "specialist";
  model: AgentModel;
  description: string;
  instructions: string;
  tools: PlannedTool[];
  /** Missing on agents created before built-in tools existed. */
  builtinTools?: PlannedBuiltinTool[];
}

/** A step in an execution flow (packages/agent-design FlowNode). */
export interface FlowNode {
  id: string;
  type: "input" | "output" | "agent" | "router" | "tool";
  position: { x: number; y: number };
  /** agent: which of the plan's agents this step hands work to. */
  agentKey?: string;
  /** router, tool: the step's name. */
  label?: string;
  /** router: how to choose a route. */
  rule?: string;
  routes?: { id: string; label: string }[];
  /** tool: the tool this step calls (one of the two). */
  tool?: PlannedTool;
  builtinTool?: PlannedBuiltinTool;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** From a router: which route this connection is for. */
  route?: string;
}

/** The execution flow drawn on the canvas. A coordinator (`runner`) follows it and hands work to its agents. */
export interface AgentFlow {
  nodes: FlowNode[];
  edges: FlowEdge[];
  runner: { model: AgentModel; instructions: string };
}

export interface AgentPlan {
  name: string;
  description: string;
  flow: "single" | "team";
  /** With a flowGraph: the agents its steps use. */
  agents: PlannedAgent[];
  /** Missing on agents created before flows existed. */
  flowGraph?: AgentFlow;
  gaps: { capability: string; suggestion: string }[];
  assumptions: string[];
  testPrompts: string[];
}

export interface CatalogTool {
  name: string;
  description: string;
  destructive: boolean;
  sensitive: boolean;
}

export interface CatalogServer {
  deploymentId: string;
  name: string;
  title: string;
  url: string;
  tools: CatalogTool[];
}

export interface Catalog {
  servers: CatalogServer[];
  unavailable: { deploymentId: string; title: string; reason: string }[];
}

export interface AgentRecord {
  id: string;
  createdAt: string;
  name: string;
  description: string;
  plan: AgentPlan;
}

export type RunStatus = "running" | "requires_action" | "completed" | "failed";

export interface AgentRun {
  sessionId: string;
  createdAt: string;
  source: "playground" | "endpoint";
  status: RunStatus;
  inputPreview: string | null;
  outputPreview: string | null;
}

export type AgentUiEvent =
  | { kind: "user"; id: string; text: string; at: string | null }
  | { kind: "message"; id: string; text: string; at: string | null }
  | {
      kind: "tool_call";
      id: string;
      server: string;
      tool: string;
      input: Record<string, unknown>;
      permission: "allow" | "ask" | "deny";
      threadId: string | null;
      at: string | null;
    }
  | { kind: "tool_result"; id: string; toolCallId: string; text: string; isError: boolean; at: string | null }
  | { kind: "confirmation"; id: string; toolCallId: string; result: "allow" | "deny"; at: string | null }
  | { kind: "thread"; id: string; threadId: string; agent: string; at: string | null }
  | { kind: "delegation"; id: string; direction: "sent" | "received"; agent: string; text: string; at: string | null }
  | { kind: "status"; id: string; status: "running" | "idle" | "terminated"; stopReason: string | null; at: string | null }
  | { kind: "error"; id: string; message: string; at: string | null };

/** The user's MCP servers, plus their connected apps as one more server when `appToolkits` names any. */
export function getCatalog(appToolkits: string[] = []): Promise<Catalog> {
  return getJson<Catalog>(`/api/agents/catalog${appToolkits.length > 0 ? `?apps=${encodeURIComponent(appToolkits.join(","))}` : ""}`);
}

/** Whether a catalog server is the user's connected apps rather than a server they built. */
export function isAppsServer(server: Pick<CatalogServer, "deploymentId">): boolean {
  return server.deploymentId.startsWith("apps:");
}

/** A third-party app (Gmail, Slack, ...) an agent can use once the user has signed in to it. */
export interface AppInfo {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
}

/**
 * A page of apps, widely used ones first. `search` narrows by name,
 * `connected` lists only the user's, and `cursor` (a previous page's
 * `nextCursor`) continues. `enabled` is false when connected apps aren't set
 * up on this altship.
 */
export function listApps(options: { search?: string; connected?: boolean; cursor?: string } = {}): Promise<{ enabled: boolean; apps: AppInfo[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.search) params.set("search", options.search);
  if (options.connected) params.set("connected", "true");
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  return getJson(`/api/apps${query ? `?${query}` : ""}`);
}

/** Starts signing in to an app: resolves to the page to open. */
export function connectApp(slug: string): Promise<{ url: string }> {
  return postJson(`/api/apps/${encodeURIComponent(slug)}/connect`, {});
}

export function disconnectApp(slug: string): Promise<{ ok: true }> {
  return deleteJson(`/api/apps/${encodeURIComponent(slug)}`);
}

/** The tools the user chose for an agent: MCP servers (may be none), built-in tools and connected apps. */
export interface ToolChoice {
  serverDeploymentIds: string[];
  builtinTools: BuiltinTool[];
  /** Slugs of the connected apps the agent may use. */
  appToolkits: string[];
}

export function proposePlan(
  request: {
    name: string;
    description: string;
    feedback?: string;
    previousPlan?: AgentPlan;
    focusDeploymentId?: string;
  } & ToolChoice,
): Promise<{ plan: AgentPlan; catalog: CatalogServer[] }> {
  return postJson("/api/agents/plan", request);
}

export function approvePlan(plan: AgentPlan, tools: ToolChoice): Promise<AgentRecord> {
  return postJson<AgentRecord>("/api/agents", { plan, ...tools });
}

/** Every tool an agent can use (MCP and built-in), e.g. for counts. */
export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const COLUMN = 250;
const ROW = 130;

/** A plan with nothing in it but an Input and an Output, for building a flow from scratch. */
export function blankPlan(name: string, description: string): AgentPlan {
  return {
    name,
    description,
    flow: "single",
    agents: [],
    gaps: [],
    assumptions: [],
    testPrompts: [],
    flowGraph: {
      nodes: [
        { id: "input", type: "input", position: { x: 0, y: 0 } },
        { id: "output", type: "output", position: { x: COLUMN * 2, y: 0 } },
      ],
      edges: [],
      runner: { model: "claude-opus-5", instructions: "" },
    },
  };
}

/**
 * Lays a plan out as a flow so it can be edited on the canvas. A single agent
 * becomes Input → agent → Output. A team becomes Input → a router that picks a
 * specialist → Output, since that's what its coordinator does; the
 * coordinator's own instructions become the flow's guidance. A coordinator
 * that has tools of its own stays as a first step, so they aren't lost.
 * Plans that already have a flow are returned unchanged.
 */
export function withFlow(plan: AgentPlan): AgentPlan {
  if (plan.flowGraph) return plan;
  const coordinator = plan.agents.find((a) => a.role === "coordinator");
  const edge = (source: string, target: string, route?: string): FlowEdge => ({ id: newId("e"), source, target, ...(route ? { route } : {}) });

  if (!coordinator || plan.agents.length === 1) {
    const agent = plan.agents[0];
    return {
      ...plan,
      agents: [{ ...agent, role: "specialist" }],
      flowGraph: {
        nodes: [
          { id: "input", type: "input", position: { x: 0, y: 0 } },
          { id: "step-1", type: "agent", agentKey: agent.key, position: { x: COLUMN, y: 0 } },
          { id: "output", type: "output", position: { x: COLUMN * 2, y: 0 } },
        ],
        edges: [edge("input", "step-1"), edge("step-1", "output")],
        runner: { model: agent.model, instructions: "" },
      },
    };
  }

  const specialists = plan.agents.filter((a) => a !== coordinator);
  const keepsCoordinator = toolCountOf(coordinator) > 0;
  const first = keepsCoordinator ? 1 : 0;
  const top = (-(specialists.length - 1) * ROW) / 2;
  const routes = specialists.map((s, i) => ({ id: `route-${i + 1}`, label: s.description || s.name }));
  const nodes: FlowNode[] = [
    { id: "input", type: "input", position: { x: 0, y: 0 } },
    ...(keepsCoordinator ? [{ id: "coordinator", type: "agent" as const, agentKey: coordinator.key, position: { x: COLUMN, y: 0 } }] : []),
    {
      id: "router",
      type: "router",
      label: "Choose a specialist",
      rule: "Pick the specialist whose strengths best match the request.",
      routes,
      position: { x: COLUMN * (first + 1), y: 0 },
    },
    ...specialists.map((s, i) => ({ id: `step-${i + 1}`, type: "agent" as const, agentKey: s.key, position: { x: COLUMN * (first + 2), y: top + i * ROW } })),
    { id: "output", type: "output", position: { x: COLUMN * (first + 3), y: 0 } },
  ];
  return {
    ...plan,
    agents: [...(keepsCoordinator ? [coordinator] : []), ...specialists].map((a) => ({ ...a, role: "specialist" as const })),
    flowGraph: {
      nodes,
      edges: [
        ...(keepsCoordinator ? [edge("input", "coordinator"), edge("coordinator", "router")] : [edge("input", "router")]),
        ...specialists.flatMap((_, i) => [edge("router", `step-${i + 1}`, `route-${i + 1}`), edge(`step-${i + 1}`, "output")]),
      ],
      runner: { model: coordinator.model, instructions: keepsCoordinator ? "" : coordinator.instructions },
    },
  };
}

/** Every tool a plan uses: its agents' tools plus its flow's tool steps. */
export function planToolCount(plan: AgentPlan): number {
  const steps = (plan.flowGraph?.nodes ?? []).filter((n) => n.type === "tool").length;
  return plan.agents.reduce((n, a) => n + toolCountOf(a), 0) + steps;
}

export function toolCountOf(agent: PlannedAgent): number {
  return agent.tools.length + (agent.builtinTools?.length ?? 0);
}

export function listAgents(): Promise<AgentRecord[]> {
  return getJson<AgentRecord[]>("/api/agents");
}

export function getAgent(id: string): Promise<AgentRecord> {
  return getJson<AgentRecord>(`/api/agents/${id}`);
}

export function listRuns(id: string): Promise<AgentRun[]> {
  return getJson<AgentRun[]>(`/api/agents/${id}/runs`);
}

export function startPlaygroundSession(id: string): Promise<{ sessionId: string }> {
  return postJson(`/api/agents/${id}/sessions`, {});
}

export function sendPlaygroundMessage(id: string, sessionId: string, text: string): Promise<{ ok: true }> {
  return postJson(`/api/agents/${id}/sessions/${sessionId}/messages`, { text });
}

export function confirmPlaygroundTool(id: string, sessionId: string, toolCallId: string, result: "allow" | "deny") {
  return postJson<{ ok: true }>(`/api/agents/${id}/sessions/${sessionId}/confirm`, { toolCallId, result });
}

/**
 * Follows a playground session over SSE. The server replays the session's
 * events so far, then streams live ones until the turn settles and sends
 * `done`; callers dedupe by event id. Returns a function that stops following.
 * Reads the stream with fetch (not EventSource) so it can send the user's token.
 */
export function followPlaygroundSession(
  id: string,
  sessionId: string,
  handlers: { onEvent: (event: AgentUiEvent) => void; onDone: (status: RunStatus) => void; onError: (message: string) => void },
): () => void {
  const abort = new AbortController();
  let finished = false;

  const dispatch = (event: string, data: string) => {
    if (event === "done") {
      finished = true;
      handlers.onDone((JSON.parse(data) as { status: RunStatus }).status);
    } else if (event === "failure") {
      finished = true;
      handlers.onError((JSON.parse(data) as { error: string }).error);
    } else {
      handlers.onEvent(JSON.parse(data) as AgentUiEvent);
    }
  };

  (async () => {
    const res = await apiFetch(`/api/agents/${id}/sessions/${sessionId}/stream`, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`Stream failed with ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length) dispatch(event, data.join("\n"));
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      // A dropped connection (not a server-reported failure): stop and let
      // the caller resume on the next action.
      if (!finished && !abort.signal.aborted) {
        handlers.onError("Lost the connection to the agent. Send another message or refresh to resume.");
      }
    });

  return () => abort.abort();
}

export function endpointUrl(id: string): string {
  const base = API_BASE || window.location.origin;
  return `${base}/api/agents/${id}/run`;
}

export function flowLabel(agent: { plan: { agents: unknown[]; flowGraph?: AgentFlow } }): string {
  const n = agent.plan.agents.length;
  const steps = agent.plan.flowGraph?.nodes.filter((node) => node.type !== "input" && node.type !== "output").length;
  if (steps !== undefined && steps > 1) return `Flow of ${steps} steps`;
  return n <= 1 ? "Single agent" : `Team of ${n}`;
}
