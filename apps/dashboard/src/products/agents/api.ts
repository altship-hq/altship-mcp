import { API_BASE, getJson, postJson } from "../../http.js";

// Mirrors apps/api/src/agents (router, events) and packages/agent-design types.

export type AgentModel = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";
export type ToolPermission = "auto" | "ask";

export interface PlannedTool {
  server: string;
  tool: string;
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

export function proposePlan(request: {
  name: string;
  description: string;
  feedback?: string;
  previousPlan?: AgentPlan;
  focusDeploymentId?: string;
}): Promise<{ plan: AgentPlan; catalog: CatalogServer[] }> {
  return postJson("/api/agents/plan", request);
}

export function approvePlan(plan: AgentPlan): Promise<AgentRecord> {
  return postJson<AgentRecord>("/api/agents", { plan });
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
 */
export function followPlaygroundSession(
  id: string,
  sessionId: string,
  handlers: { onEvent: (event: AgentUiEvent) => void; onDone: (status: RunStatus) => void; onError: (message: string) => void },
): () => void {
  const source = new EventSource(`${API_BASE}/api/agents/${id}/sessions/${sessionId}/stream`);
  source.onmessage = (e) => handlers.onEvent(JSON.parse(e.data) as AgentUiEvent);
  source.addEventListener("done", (e) => {
    source.close();
    handlers.onDone((JSON.parse((e as MessageEvent).data) as { status: RunStatus }).status);
  });
  source.addEventListener("failure", (e) => {
    source.close();
    handlers.onError((JSON.parse((e as MessageEvent).data) as { error: string }).error);
  });
  source.onerror = () => {
    // A dropped connection (not a server-reported failure): the browser would
    // retry forever; stop and let the caller resume on the next action.
    if (source.readyState === EventSource.CLOSED || source.readyState === EventSource.CONNECTING) {
      source.close();
      handlers.onError("Lost the connection to the agent. Send another message or refresh to resume.");
    }
  };
  return () => source.close();
}

export function endpointUrl(id: string): string {
  const base = API_BASE || window.location.origin;
  return `${base}/api/agents/${id}/run`;
}

export function flowLabel(agent: { plan: { agents: unknown[] } }): string {
  const n = agent.plan.agents.length;
  return n === 1 ? "Single agent" : `Team of ${n}`;
}
