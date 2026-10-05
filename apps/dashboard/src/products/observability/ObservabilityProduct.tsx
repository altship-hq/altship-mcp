import { useEffect, useState } from "react";
import { listDeployments, type DeploymentRecord } from "../mcp/api.js";
import { Link } from "../../router.js";
import { PageHead, Stat } from "../../ui.js";
import { listLogs, type ToolCall } from "./api.js";

// Observability: the tool calls made on your managed MCP servers. Each
// server exports them as OpenTelemetry spans; this lists what was received.

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(before?: string) {
    setBusy(true);
    setError(null);
    try {
      const page = await listLogs({ deploymentId, before, limit: pageSize });
      setCalls((current) => (before ? [...(current ?? []), ...page.calls] : page.calls));
      setNextBefore(page.nextBefore);
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
            No tool calls recorded yet. Servers deployed before call logging was added don't record calls; deploy the server again
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

/** /observability: every recorded tool call, optionally for one server. */
export default function ObservabilityProduct() {
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
        title="Logs"
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
