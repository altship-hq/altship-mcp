import { getJson } from "../../http.js";

/** One tool call on a managed MCP server. Arguments and responses are never recorded. */
export interface ToolCall {
  id: string;
  deploymentId: string;
  serverName: string;
  startedAt: string;
  tool: string;
  ok: boolean;
  /** unknown_tool | invalid_input | upstream_error | request_failed */
  errorType: string | null;
  /** The upstream API's HTTP status, when a request was made. */
  httpStatus: number | null;
  durationMs: number;
  /** The OpenTelemetry trace id the server exported the call under. */
  traceId: string | null;
  /** `id` is the key's hash prefix, the altship user id or the end-user connection id; `label` names it. */
  caller: { kind: string; id: string | null; label: string };
}

export interface LogPage {
  calls: ToolCall[];
  /** Pass as `before` for the next (older) page; null when there isn't one. */
  nextBefore: string | null;
  /** How many days of history the account's plan keeps. */
  retentionDays: number;
  plan: string;
}

/** One run of an agent, from the playground or its API endpoint. */
export interface AgentRunLog {
  sessionId: string;
  agentId: string;
  agentName: string;
  createdAt: string;
  source: "playground" | "endpoint" | "schedule";
  status: "running" | "requires_action" | "completed" | "failed";
  inputPreview: string | null;
  outputPreview: string | null;
  /** When it last settled; null while running or on older runs. */
  endedAt: string | null;
  /** Tool calls the agent made; null on older runs. */
  toolCalls: number | null;
}

export interface AgentRunPage {
  runs: AgentRunLog[];
  nextBefore: string | null;
  /** How many days of history the account's plan keeps. */
  retentionDays: number;
  plan: string;
}

export function listAgentRuns(options: { agentId?: string; before?: string; limit?: number } = {}): Promise<AgentRunPage> {
  const params = new URLSearchParams();
  if (options.agentId) params.set("agentId", options.agentId);
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return getJson<AgentRunPage>(`/api/agents/runs${query ? `?${query}` : ""}`);
}

export function listLogs(options: { deploymentId?: string; before?: string; limit?: number } = {}): Promise<LogPage> {
  const params = new URLSearchParams();
  if (options.deploymentId) params.set("deploymentId", options.deploymentId);
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return getJson<LogPage>(`/api/logs${query ? `?${query}` : ""}`);
}
