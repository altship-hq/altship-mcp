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
  /** `id` is the key's hash prefix, the altship user id or the end-user connection id; `label` names it. */
  caller: { kind: string; id: string | null; label: string };
}

export interface LogPage {
  calls: ToolCall[];
  /** Pass as `before` for the next (older) page; null when there isn't one. */
  nextBefore: string | null;
}

export function listLogs(options: { deploymentId?: string; before?: string; limit?: number } = {}): Promise<LogPage> {
  const params = new URLSearchParams();
  if (options.deploymentId) params.set("deploymentId", options.deploymentId);
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return getJson<LogPage>(`/api/logs${query ? `?${query}` : ""}`);
}
