import { useEffect, useState } from "react";
import { listDeployments, type DeploymentRecord } from "../mcp/api.js";
import { Link } from "../../router.js";
import { PageHead, Stat } from "../../ui.js";
import { listAgents, type AgentRecord } from "../agents/api.js";
import { listAgentRuns, listLogs, type AgentRunLog, type ToolCall } from "./api.js";

// Observability: the tool calls made on your managed MCP servers (each server
// exports them as OpenTelemetry spans; this lists what was received) and the
// runs of your agents.

const ERRORS: Record<string, string> = {
  unknown_tool: "Unknown tool",
  invalid_input: "Invalid input",
  upstream_error: "API error",
  request_failed: "Request failed",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** How much history is kept, shown above a full log. */
function RetentionNote({ days }: { days: number | null }) {
  if (days === null) return null;
  return (
    <p className="section-copy log-retention">
      Showing the last {days} day{days === 1 ? "" : "s"}. Older records are deleted; longer history will come with paid plans.
    </p>
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A table of tool calls, newest first: for one server (`deploymentId`) or all
 * of them. `summary` adds totals for the calls loaded so far.
 */
export function ToolCallLog({ deploymentId, pageSize = 50, summary = false }: { deploymentId?: string; pageSize?: number; summary?: boolean }) {
  const [calls, setCalls] = useState<ToolCall[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(before?: string) {
    setBusy(true);
    setError(null);
    try {
      const page = await listLogs({ deploymentId, before, limit: pageSize });
      setCalls((current) => (before ? [...(current ?? []), ...page.calls] : page.calls));
      setNextBefore(page.nextBefore);
      setRetentionDays(page.retentionDays ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  useEffect(() => {
    setCalls(null);
    load();
  }, [deploymentId, pageSize]);

  const failed = (calls ?? []).filter((c) => !c.ok).length;
  const typical = median((calls ?? []).map((c) => c.durationMs));

  return (
    <>
      {summary && <RetentionNote days={retentionDays} />}
      {summary && (
        <div className="stats">
          <Stat label={nextBefore ? "Calls loaded" : "Calls"} value={calls ? String(calls.length) : "—"} />
          <Stat label="Failed" value={calls ? String(failed) : "—"} />
          <Stat label="Median duration" value={typical === null ? "—" : formatDuration(typical)} />
        </div>
      )}
      {error && <div className="notice">{error}</div>}

      {calls === null ? (
        !error && <div className="empty">Loading…</div>
      ) : calls.length === 0 ? (
        <div className="empty">
          <p>
            No tool calls{retentionDays ? ` in the last ${retentionDays} days` : " recorded yet"}. Servers deployed before call logging was added don't record calls; deploy the server again
            to start.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="servers logs">
            <thead>
              <tr>
                <th>Time</th>
                {!deploymentId && <th>Server</th>}
                <th>Tool</th>
                <th>Called by</th>
                <th>Result</th>
                <th>API status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td className="date">{formatTime(c.startedAt)}</td>
                  {!deploymentId && (
                    <td>
                      <Link to={`mcp/servers/${c.deploymentId}`}>{c.serverName}</Link>
                    </td>
                  )}
                  <td>
                    <code>{c.tool}</code>
                  </td>
                  <td className="server-name">
                    <strong>{c.caller.label}</strong>
                    {c.caller.id && <small title={`${c.caller.kind} id`}>{c.caller.id}</small>}
                  </td>
                  <td>
                    <span className={c.ok ? "log-result" : "log-result log-failed"}>{c.ok ? "OK" : (ERRORS[c.errorType ?? ""] ?? "Failed")}</span>
                  </td>
                  <td>{c.httpStatus ?? "—"}</td>
                  <td className="date">{formatDuration(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {calls !== null && (
        <div className="log-actions">
          <button type="button" className="copy-button" disabled={busy} onClick={() => load()}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          {nextBefore && (
            <button type="button" className="copy-button" disabled={busy} onClick={() => load(nextBefore)}>
              Load older
            </button>
          )}
        </div>
      )}
    </>
  );
}

const RUN_STATUS: Record<AgentRunLog["status"], string> = {
  running: "Running",
  requires_action: "Needs approval",
  completed: "Completed",
  failed: "Failed",
};

/** A table of agent runs, newest first: for one agent (`agentId`) or all of them. */
function AgentRunLogTable({ agentId }: { agentId?: string }) {
  const [runs, setRuns] = useState<AgentRunLog[] | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(before?: string) {
    setBusy(true);
    setError(null);
    try {
      const page = await listAgentRuns({ agentId, before, limit: 50 });
      setRuns((current) => (before ? [...(current ?? []), ...page.runs] : page.runs));
      setNextBefore(page.nextBefore);
      setRetentionDays(page.retentionDays ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  useEffect(() => {
    setRuns(null);
    load();
  }, [agentId]);

  const durations = (runs ?? []).flatMap((r) => (r.endedAt ? [Date.parse(r.endedAt) - Date.parse(r.createdAt)] : []));
  const typical = median(durations);

  return (
    <>
      <RetentionNote days={retentionDays} />
      <div className="stats">
        <Stat label={nextBefore ? "Runs loaded" : "Runs"} value={runs ? String(runs.length) : "—"} />
        <Stat label="Failed" value={runs ? String(runs.filter((r) => r.status === "failed").length) : "—"} />
        <Stat label="Median duration" value={typical === null ? "—" : formatDuration(typical)} />
      </div>
      {error && <div className="notice">{error}</div>}

      {runs === null ? (
        !error && <div className="empty">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty">
          <p>No agent runs{retentionDays ? ` in the last ${retentionDays} days` : " yet"}. Try an agent in its Playground or call its endpoint.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="servers logs runs">
            <thead>
              <tr>
                <th>Started</th>
                {!agentId && <th>Agent</th>}
                <th>Called from</th>
                <th>Status</th>
                <th>Tool calls</th>
                <th>Duration</th>
                <th>Input</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.sessionId}>
                  <td className="date">{formatTime(r.createdAt)}</td>
                  {!agentId && (
                    <td>
                      <Link to={`agents/${r.agentId}/runs`}>{r.agentName}</Link>
                    </td>
                  )}
                  <td className="server-name">
                    <strong>{r.source === "endpoint" ? "API endpoint" : "Playground (you)"}</strong>
                    <small title="Run id">{r.sessionId}</small>
                  </td>
                  <td>
                    <span className={`status-tag ${r.status}`}>{RUN_STATUS[r.status]}</span>
                  </td>
                  <td>{r.toolCalls ?? "—"}</td>
                  <td className="date">{r.endedAt ? formatDuration(Math.max(Date.parse(r.endedAt) - Date.parse(r.createdAt), 0)) : "—"}</td>
                  <td className="run-text">{r.inputPreview ?? "—"}</td>
                  <td className="run-text">{r.outputPreview ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runs !== null && (
        <div className="log-actions">
          <button type="button" className="copy-button" disabled={busy} onClick={() => load()}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          {nextBefore && (
            <button type="button" className="copy-button" disabled={busy} onClick={() => load(nextBefore)}>
              Load older
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** /observability/agents: every agent run, optionally for one agent. */
function AgentRunsPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  return (
    <>
      <PageHead
        title="Agent runs"
        description="Every run of your agents, from the playground or their API endpoints: how it went, how long it took and how many tools it called. The tool calls themselves are under Tool calls."
        action={
          <select className="log-filter" aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        }
      />
      <AgentRunLogTable agentId={agentId || undefined} />
    </>
  );
}

/** /observability: every recorded tool call, optionally for one server; /observability/agents: agent runs. */
export default function ObservabilityProduct({ subpath }: { subpath: string }) {
  if (subpath === "agents") return <AgentRunsPage />;
  return <ToolCallsPage />;
}

function ToolCallsPage() {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [deploymentId, setDeploymentId] = useState("");

  useEffect(() => {
    listDeployments()
      .then(setDeployments)
      .catch(() => setDeployments([]));
  }, []);

  return (
    <>
      <PageHead
        title="Tool calls"
        description="Every tool call on your managed MCP servers: who called which tool, how it went and how long it took. Arguments and responses are never recorded."
        action={
          <select className="log-filter" aria-label="Server" value={deploymentId} onChange={(e) => setDeploymentId(e.target.value)}>
            <option value="">All servers</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        }
      />
      <ToolCallLog deploymentId={deploymentId || undefined} summary />
    </>
  );
}
