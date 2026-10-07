import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../../router.js";
import { PageHead } from "../../ui.js";
import FlowEditor from "./FlowEditor.js";
import Markdown from "./Markdown.js";
import Schedule from "./Schedule.js";
import {
  confirmPlaygroundTool,
  endpointUrl,
  followPlaygroundSession,
  getAgent,
  listRuns,
  sendPlaygroundMessage,
  startPlaygroundSession,
  type AgentRecord,
  type AgentRun,
  type AgentUiEvent,
  type RunStatus,
  flowLabel,
  withFlow,
  toolCountOf,
} from "./api.js";

type Tab = "playground" | "flow" | "deploy" | "schedule" | "runs";

export default function AgentDetail({ id, tab }: { id: string; tab: Tab }) {
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAgent(null);
    getAgent(id)
      .then(setAgent)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) return <div className="notice">Couldn't load this agent: {error}</div>;
  if (!agent) return <div className="empty">Loading…</div>;

  const specialists = agent.plan.agents.filter((a) => a.role === "specialist");
  const toolCount = agent.plan.agents.reduce((n, a) => n + toolCountOf(a), 0);

  return (
    <>
      <PageHead title={agent.name} description={agent.description} />
      <p className="agent-summary">
        {flowLabel(agent)}
        {specialists.length > 0 && ` · specialists: ${specialists.map((s) => s.name).join(", ")}`} · {toolCount} tool
        {toolCount === 1 ? "" : "s"}
      </p>

      <nav className="tabs" aria-label="Agent">
        <Link to={`agents/${id}`} aria-current={tab === "playground" ? "page" : undefined}>
          Playground
        </Link>
        <Link to={`agents/${id}/flow`} aria-current={tab === "flow" ? "page" : undefined}>
          Flow
        </Link>
        <Link to={`agents/${id}/deploy`} aria-current={tab === "deploy" ? "page" : undefined}>
          Deploy
        </Link>
        <Link to={`agents/${id}/schedule`} aria-current={tab === "schedule" ? "page" : undefined}>
          Schedule
        </Link>
        <Link to={`agents/${id}/runs`} aria-current={tab === "runs" ? "page" : undefined}>
          Runs
        </Link>
      </nav>

      {tab === "playground" && <Playground agent={agent} />}
      {tab === "flow" && (
        <>
          <p className="agent-summary">How this agent works through a request. To change the flow, create a new agent.</p>
          <FlowEditor plan={withFlow(agent.plan)} />
        </>
      )}
      {tab === "deploy" && <Deploy agent={agent} />}
      {tab === "schedule" && <Schedule agent={agent} />}
      {tab === "runs" && <Runs agent={agent} />}
    </>
  );
}

// ---- Playground ---------------------------------------------------------

function Playground({ agent }: { agent: AgentRecord }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentUiEvent[]>([]);
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopFollowing = useRef<(() => void) | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => () => stopFollowing.current?.(), []);
  // Opened on one run (from the run log, a schedule or an email): show it, and carry on from there.
  useEffect(() => {
    const opened = new URLSearchParams(window.location.search).get("session");
    if (!opened) return;
    setSessionId(opened);
    follow(opened);
  }, [agent.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [events.length, working]);

  const follow = useCallback(
    (sid: string) => {
      stopFollowing.current?.();
      setWorking(true);
      stopFollowing.current = followPlaygroundSession(agent.id, sid, {
        onEvent: (event) => setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event])),
        onDone: (status: RunStatus) => {
          // "running" means the server stopped following before the turn ended; pick it back up.
          if (status === "running") follow(sid);
          else setWorking(false);
        },
        onError: (message) => {
          setError(message);
          setWorking(false);
        },
      });
    },
    [agent.id],
  );

  async function send(text: string) {
    const message = text.trim();
    if (!message || working) return;
    setError(null);
    setInput("");
    try {
      const sid = sessionId ?? (await startPlaygroundSession(agent.id)).sessionId;
      setSessionId(sid);
      await sendPlaygroundMessage(agent.id, sid, message);
      follow(sid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  }

  async function decide(toolCallId: string, result: "allow" | "deny") {
    if (!sessionId) return;
    setError(null);
    try {
      await confirmPlaygroundTool(agent.id, sessionId, toolCallId, result);
      follow(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function reset() {
    stopFollowing.current?.();
    setSessionId(null);
    setEvents([]);
    setWorking(false);
    setError(null);
  }

  const transcript = useTranscript(events);
  const awaitingApproval = transcript.some((item) => item.kind === "tool" && item.pending);

  return (
    <div className="playground">
      {transcript.length === 0 ? (
        <div className="playground-empty">
          <p>Send a message to start a conversation{agent.plan.testPrompts.length > 0 ? ", or try one of these:" : "."}</p>
          <div className="prompt-chips">
            {agent.plan.testPrompts.map((p) => (
              <button key={p} className="chip" onClick={() => send(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="transcript">
          {toTurns(transcript).map((turn, i, turns) => (
            <Turn
              key={turn.id}
              turn={turn}
              // Only the latest turn can still be in progress.
              live={working && !awaitingApproval && i === turns.length - 1}
              agentName={agent.name}
              onDecide={decide}
            />
          ))}
          <div ref={bottom} />
        </div>
      )}

      {error && <div className="notice">{error}</div>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={awaitingApproval ? "Approve or deny the pending tool call first" : `Message ${agent.name}…`}
          disabled={working}
          aria-label="Message"
        />
        <div className="composer-actions">
          {sessionId && (
            <button type="button" className="link" onClick={reset}>
              New conversation
            </button>
          )}
          <button type="submit" className="btn" disabled={working || !input.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

type TranscriptEntry =
  | { kind: "user" | "agent"; id: string; at: string | null; text: string }
  | { kind: "delegation"; id: string; at: string | null; direction: "sent" | "received"; agent: string; text: string }
  | { kind: "error"; id: string; at: string | null; text: string }
  | {
      kind: "tool";
      id: string;
      at: string | null;
      server: string;
      tool: string;
      input: Record<string, unknown>;
      thread: string | null;
      pending: boolean;
      decision: "allow" | "deny" | null;
      result: { text: string; isError: boolean } | null;
      durationMs: number | null;
    };

/** Folds raw events into the rows the transcript shows (tool calls merged with their results and approvals). */
function useTranscript(events: AgentUiEvent[]): TranscriptEntry[] {
  return useMemo(() => {
    const threads = new Map<string, string>();
    const results = new Map<string, Extract<AgentUiEvent, { kind: "tool_result" }>>();
    const decisions = new Map<string, { result: "allow" | "deny"; at: string | null }>();
    for (const e of events) {
      if (e.kind === "thread") threads.set(e.threadId, e.agent);
      if (e.kind === "tool_result") results.set(e.toolCallId, e);
      if (e.kind === "confirmation") decisions.set(e.toolCallId, { result: e.result, at: e.at });
    }

    const entries: TranscriptEntry[] = [];
    for (const e of events) {
      switch (e.kind) {
        case "user":
          entries.push({ kind: "user", id: e.id, at: e.at, text: e.text });
          break;
        case "message":
          if (e.text) entries.push({ kind: "agent", id: e.id, at: e.at, text: e.text });
          break;
        case "delegation":
          entries.push({ kind: "delegation", id: e.id, at: e.at, direction: e.direction, agent: e.agent, text: e.text });
          break;
        case "error":
          entries.push({ kind: "error", id: e.id, at: e.at, text: e.message });
          break;
        case "tool_call": {
          const result = results.get(e.id);
          const decision = decisions.get(e.id)?.result ?? null;
          // Time the call itself, not the wait for a human to approve it.
          const startedAt = decisions.get(e.id)?.at ?? e.at;
          entries.push({
            kind: "tool",
            id: e.id,
            at: result?.at ?? e.at,
            server: e.server,
            tool: e.tool,
            input: e.input,
            thread: e.threadId ? (threads.get(e.threadId) ?? "specialist") : null,
            pending: e.permission === "ask" && decision === null && !result,
            decision: e.permission === "ask" ? decision : null,
            result: result ? { text: result.text, isError: result.isError } : null,
            durationMs: result && startedAt && result.at ? new Date(result.at).getTime() - new Date(startedAt).getTime() : null,
          });
          break;
        }
      }
    }
    return entries;
  }, [events]);
}

type TranscriptMessage = Extract<TranscriptEntry, { kind: "user" | "agent" }>;

/** One exchange: what the user asked, what the agent did about it, and its answer. */
interface TranscriptTurn {
  id: string;
  user: TranscriptMessage | null;
  items: TranscriptEntry[];
}

function toTurns(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") turns.push({ id: entry.id, user: entry, items: [] });
    else if (turns.length === 0) turns.push({ id: entry.id, user: null, items: [entry] });
    else turns[turns.length - 1].items.push(entry);
  }
  return turns;
}

/**
 * A turn as a conversation, not a log: the agent's answer is the bubble, and
 * the work that led to it (its notes to itself along the way, tool calls,
 * delegations) is folded into one "worked through N steps" line that opens
 * on demand. Tool calls waiting for approval and errors always stay visible.
 */
function Turn({
  turn,
  live,
  agentName,
  onDecide,
}: {
  turn: TranscriptTurn;
  live: boolean;
  agentName: string;
  onDecide: (toolCallId: string, result: "allow" | "deny") => void;
}) {
  // The answer is the agent's last message once nothing else follows it. While
  // the agent is still working, a trailing message is just its latest note.
  const last = turn.items[turn.items.length - 1];
  const answer: TranscriptMessage | null = !live && last?.kind === "agent" ? last : null;
  const pending = turn.items.filter((item) => item.kind === "tool" && item.pending);
  const errors = turn.items.filter((item) => item.kind === "error");
  const steps = turn.items.filter((item) => item !== answer && item.kind !== "error" && !(item.kind === "tool" && item.pending));

  const latest = steps[steps.length - 1];
  const doing = !latest ? "Thinking…" : latest.kind === "tool" ? `Using ${latest.tool}…` : latest.kind === "agent" ? latest.text.split("\n")[0] : "Working…";
  const startedAt = turn.user?.at ?? turn.items[0]?.at;
  const endedAt = (answer ?? last)?.at;
  const took = startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null;

  return (
    <>
      {turn.user && <div className="bubble user">{turn.user.text}</div>}

      {(steps.length > 0 || live) && (
        <details className={live ? "steps is-live" : "steps"}>
          <summary>
            {live ? (
              <span className="working">{doing}</span>
            ) : (
              <>
                Worked through {steps.length} step{steps.length === 1 ? "" : "s"}
                {took !== null && took > 0 && ` in ${formatDuration(took)}`}
              </>
            )}
          </summary>
          <div className="steps-body">
            {steps.map((item) =>
              item.kind === "agent" ? (
                <p key={item.id} className="step-note">
                  {item.text}
                </p>
              ) : (
                <TranscriptItem key={item.id} item={item} agentName={agentName} onDecide={onDecide} />
              ),
            )}
          </div>
        </details>
      )}

      {pending.map((item) => (
        <TranscriptItem key={item.id} item={item} agentName={agentName} onDecide={onDecide} />
      ))}
      {errors.map((item) => (
        <TranscriptItem key={item.id} item={item} agentName={agentName} onDecide={onDecide} />
      ))}

      {answer && (
        <div className="bubble agent">
          <span className="bubble-author">{agentName}</span>
          <Markdown text={answer.text} />
        </div>
      )}
    </>
  );
}

function TranscriptItem({
  item,
  agentName,
  onDecide,
}: {
  item: TranscriptEntry;
  agentName: string;
  onDecide: (toolCallId: string, result: "allow" | "deny") => void;
}) {
  switch (item.kind) {
    case "user":
      return <div className="bubble user">{item.text}</div>;
    case "agent":
      return (
        <div className="bubble agent">
          <span className="bubble-author">{agentName}</span>
          {item.text}
        </div>
      );
    case "error":
      return <div className="notice">{item.text}</div>;
    case "delegation":
      return (
        <details className="delegation">
          <summary>
            {item.direction === "sent" ? `→ Delegated to ${item.agent}` : `← ${item.agent} reported back`}
          </summary>
          <p>{item.text}</p>
        </details>
      );
    case "tool":
      return (
        <div className={`tool-call${item.pending ? " pending" : ""}${item.result?.isError ? " failed" : ""}`}>
          <div className="tool-call-head">
            <code>{item.tool}</code>
            <span className="tool-call-meta">
              {item.thread && `${item.thread} · `}
              {item.server}
              {item.durationMs !== null && ` · ${formatDuration(item.durationMs)}`}
            </span>
            {item.decision && <span className={`decision ${item.decision}`}>{item.decision === "allow" ? "Approved" : "Denied"}</span>}
          </div>
          <details>
            <summary>Input</summary>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </details>
          {item.result && (
            <details>
              <summary>{item.result.isError ? "Error" : "Result"}</summary>
              <pre>{item.result.text}</pre>
            </details>
          )}
          {item.pending && (
            <div className="approval">
              <span>This tool needs your approval.</span>
              <button className="btn" onClick={() => onDecide(item.id, "allow")}>
                Approve
              </button>
              <button className="btn ghost" onClick={() => onDecide(item.id, "deny")}>
                Deny
              </button>
            </div>
          )}
        </div>
      );
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ---- Deploy -------------------------------------------------------------

function Deploy({ agent }: { agent: AgentRecord }) {
  const url = endpointUrl(agent.id);
  const runsUrl = url.replace(/\/run$/, "/runs");
  const example = agent.plan.testPrompts[0] ?? "Hello";

  return (
    <div className="deploy">
      <div className="notice">
        This endpoint has no authentication yet: anyone with the URL can run this agent on your Anthropic account.
      </div>

      <h3>Endpoint</h3>
      <pre className="code-block">POST {url}</pre>

      <h3>Run it</h3>
      <pre className="code-block">{`curl -X POST ${url} \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify({ input: example }).replace(/'/g, "'\\''")}'`}</pre>

      <h3>Response</h3>
      <pre className="code-block">{`{
  "status": "completed" | "requires_action" | "running" | "failed",
  "session_id": "sesn_…",
  "output": "The agent's reply (when completed)",
  "pending_approvals": [{ "tool_call_id": "sevt_…", "server": "…", "tool": "…", "input": {…} }]
}`}</pre>

      <h3>Approvals and long runs</h3>
      <p className="hint">
        Tools marked “Ask” pause the run with <code>requires_action</code>. Approve or deny each pending call, and the response
        continues the run:
      </p>
      <pre className="code-block">{`curl -X POST ${runsUrl}/<session_id>/confirm \\
  -H 'content-type: application/json' \\
  -d '{"toolCallId": "<tool_call_id>", "result": "allow"}'`}</pre>
      <p className="hint">
        A run still going after two minutes returns <code>running</code>; poll <code>GET {runsUrl}/&lt;session_id&gt;</code> for the
        result.
      </p>
    </div>
  );
}

// ---- Runs ---------------------------------------------------------------

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  requires_action: "Needs approval",
  completed: "Completed",
  failed: "Failed",
};

const SOURCE_LABEL: Record<AgentRun["source"], string> = { playground: "Playground", endpoint: "API", schedule: "Schedule" };

const started = (run: AgentRun) => new Date(run.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Runs({ agent }: { agent: AgentRecord }) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns(agent.id)
      .then(setRuns)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setRuns([]);
      });
  }, [agent.id]);

  if (error) return <div className="notice">Couldn't load runs: {error}</div>;
  if (runs === null) return <div className="empty">Loading…</div>;
  if (runs.length === 0) return <div className="empty">No runs yet. Try the agent in the Playground, call its endpoint, or put it on a schedule.</div>;

  return (
    <div className="table-wrap">
      <table className="servers runs">
        <thead>
          <tr>
            <th>Started</th>
            <th>Source</th>
            <th>Status</th>
            <th>Input</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.sessionId}>
              <td className="date">
                {/* A run that never started has nothing to open. */}
                {r.sessionId.startsWith("drun_") ? (
                  started(r)
                ) : (
                  <Link to={`agents/${agent.id}?session=${encodeURIComponent(r.sessionId)}`} className="row-link">
                    {started(r)}
                  </Link>
                )}
              </td>
              <td>{SOURCE_LABEL[r.source]}</td>
              <td>
                <span className={`status-tag ${r.status}`}>{STATUS_LABEL[r.status]}</span>
              </td>
              <td className="run-text">{r.inputPreview}</td>
              <td className="run-text">{r.outputPreview ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
