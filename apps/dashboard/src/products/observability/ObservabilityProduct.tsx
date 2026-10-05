import { useEffect, useState, type ReactNode } from "react";
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

/** The exact time, for a record's details. */
function formatExact(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

const ERROR_DETAILS: Record<string, string> = {
  unknown_tool: "The caller asked for a tool this server doesn't have.",
  invalid_input: "The arguments didn't match the tool's input schema, so the API wasn't called.",
  upstream_error: "The API answered with an error status.",
  request_failed: "The request to the API couldn't be made (network error, timeout or a missing credential).",
};

const CALLER_KINDS: Record<string, string> = {
  key: "Access key",
  user: "Signed-in altship account",
  "end-user": "End user of a customers server",
  local: "Local (stdio)",
  anonymous: "Unauthenticated",
};

/** A summary row that opens its details when clicked, like a log stream. */
function LogRow({ open, onToggle, cells, columns, children }: { open: boolean; onToggle: () => void; cells: ReactNode; columns: number; children: ReactNode }) {
  return (
    <>
      <tr className={open ? "log-row is-open" : "log-row"} onClick={onToggle}>
        <td className="log-toggle">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </td>
        {cells}
      </tr>
      {open && (
        <tr className="log-detail">
          <td colSpan={columns + 1}>
            <dl>{children}</dl>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
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
  // The one call whose details are showing.
  const [openId, setOpenId] = useState<string | null>(null);

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
                <th>
                  <span className="visually-hidden">Details</span>
                </th>
                <th>Time</th>
                {!deploymentId && <th>Server</th>}
                <th>Tool</th>
                <th>Result</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <LogRow
                  key={c.id}
                  open={openId === c.id}
                  onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                  columns={deploymentId ? 4 : 5}
                  cells={
                    <>
                      <td className="date">{formatTime(c.startedAt)}</td>
                      {!deploymentId && <td>{c.serverName}</td>}
                      <td>
                        <code>{c.tool}</code>
                      </td>
                      <td>
                        <span className={c.ok ? "log-result" : "log-result log-failed"}>{c.ok ? "OK" : (ERRORS[c.errorType ?? ""] ?? "Failed")}</span>
                      </td>
                      <td className="date">{formatDuration(c.durationMs)}</td>
                    </>
                  }
                >
                  <Detail label="Called by">
                    {c.caller.label}
                    <small>
                      {CALLER_KINDS[c.caller.kind] ?? c.caller.kind}
                      {c.caller.id && (
                        <>
                          {" · id "}
                          <code>{c.caller.id}</code>
                        </>
                      )}
                    </small>
                  </Detail>
                  <Detail label="Server">
                    <Link to={`mcp/servers/${c.deploymentId}`}>{c.serverName || "View server"}</Link>
                  </Detail>
                  <Detail label="Tool">
                    <code>{c.tool}</code>
                  </Detail>
                  <Detail label="Result">
                    {c.ok ? "OK" : (ERRORS[c.errorType ?? ""] ?? "Failed")}
                    {!c.ok && c.errorType && ERROR_DETAILS[c.errorType] && <small>{ERROR_DETAILS[c.errorType]}</small>}
                  </Detail>
                  <Detail label="API status">{c.httpStatus ?? "No request was made"}</Detail>
                  <Detail label="Started">{formatExact(c.startedAt)}</Detail>
                  <Detail label="Duration">{c.durationMs} ms</Detail>
                  {c.traceId && (
                    <Detail label="Trace id">
                      <code>{c.traceId}</code>
                    </Detail>
                  )}
                  <Detail label="Call id">
                    <code>{c.id}</code>
                  </Detail>
                </LogRow>
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
  // The one run whose details are showing.
  const [openId, setOpenId] = useState<string | null>(null);
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
                <th>
                  <span className="visually-hidden">Details</span>
                </th>
                <th>Started</th>
                {!agentId && <th>Agent</th>}
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const duration = r.endedAt ? formatDuration(Math.max(Date.parse(r.endedAt) - Date.parse(r.createdAt), 0)) : null;
                return (
                  <LogRow
                    key={r.sessionId}
                    open={openId === r.sessionId}
                    onToggle={() => setOpenId(openId === r.sessionId ? null : r.sessionId)}
                    columns={agentId ? 3 : 4}
                    cells={
                      <>
                        <td className="date">{formatTime(r.createdAt)}</td>
                        {!agentId && <td>{r.agentName}</td>}
                        <td>
                          <span className={`status-tag ${r.status}`}>{RUN_STATUS[r.status]}</span>
                        </td>
                        <td className="date">{duration ?? "—"}</td>
                      </>
                    }
                  >
                    <Detail label="Agent">
                      <Link to={`agents/${r.agentId}/runs`}>{r.agentName || "View agent"}</Link>
                    </Detail>
                    <Detail label="Called from">{r.source === "endpoint" ? "API endpoint" : "Playground (you)"}</Detail>
                    <Detail label="Status">{RUN_STATUS[r.status]}</Detail>
                    <Detail label="Tool calls">{r.toolCalls ?? "Not recorded"}</Detail>
                    <Detail label="Started">{formatExact(r.createdAt)}</Detail>
                    <Detail label={r.status === "running" ? "Last settled" : "Finished"}>{r.endedAt ? formatExact(r.endedAt) : "Not recorded"}</Detail>
                    <Detail label="Run id">
                      <code>{r.sessionId}</code>
                    </Detail>
                    <div className="log-detail-wide">
                      <dt>Input</dt>
                      <dd className="log-text">{r.inputPreview ?? "—"}</dd>
                    </div>
                    <div className="log-detail-wide">
                      <dt>Output</dt>
                      <dd className="log-text">{r.outputPreview ?? "—"}</dd>
                    </div>
                  </LogRow>
                );
              })}
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
