import { API_BASE, apiFetch, getJson, postJson } from "../../http.js";

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

export interface AgentPlan {
  name: string;
  description: string;
  flow: "single" | "team";
  agents: PlannedAgent[];
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

export function getCatalog(): Promise<Catalog> {
  return getJson<Catalog>("/api/agents/catalog");
}

/** The tools the user chose for an agent: MCP servers (may be none) and built-in tools. */
export interface ToolChoice {
  serverDeploymentIds: string[];
  builtinTools: BuiltinTool[];
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

export function flowLabel(agent: { plan: { agents: unknown[] } }): string {
  const n = agent.plan.agents.length;
  return n === 1 ? "Single agent" : `Team of ${n}`;
}
