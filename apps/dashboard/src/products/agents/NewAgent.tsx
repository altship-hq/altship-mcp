import { useEffect, useMemo, useState } from "react";
import { Link, navigate } from "../../router.js";
import { LoadingOverlay, PageHead } from "../../ui.js";
import AppsPicker from "./AppsPicker.js";
import FlowEditor from "./FlowEditor.js";
import { useHistory } from "./useHistory.js";
import {
  approvePlan,
  blankPlan,
  getCatalog,
  isAppsServer,
  planToolCount,
  proposePlan,
  withFlow,
  type AgentModel,
  type AgentPlan,
  type Catalog,
  type CatalogServer,
  type PlannedAgent,
  type PlannedBuiltinTool,
  type PlannedTool,
  type ToolChoice,
  BUILTIN_GROUPS,
  BUILTIN_LABELS,
  toolCountOf,
} from "./api.js";

const MODELS: { id: AgentModel; label: string }[] = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const ROLE_LABEL: Record<PlannedAgent["role"], string> = {
  solo: "Agent",
  coordinator: "Coordinator",
  specialist: "Specialist",
};

/** Describe → review the proposed plan → approve. Nothing is created until Approve. */
export default function NewAgent() {
  const focusDeploymentId = new URLSearchParams(window.location.search).get("server") ?? undefined;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // The plan being reviewed, with undo and redo. Null until there is one.
  const history = useHistory<AgentPlan | null>(null);
  const plan = history.value;
  const setPlan = (next: AgentPlan) => history.set(next, sameKindOfEdit);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<null | "planning" | "approving">(null);
  const [error, setError] = useState<string | null>(null);
  // Tools the agent may use. No MCP server is required: web is on by default,
  // the sandbox off, and servers start unticked (except one you came from).
  const [useWeb, setUseWeb] = useState(true);
  const [useSandbox, setUseSandbox] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(focusDeploymentId ? [focusDeploymentId] : []));
  // Connected apps (Gmail, Slack, ...) ticked for this agent, by slug.
  const [pickedApps, setPickedApps] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    getCatalog()
      .then(setCatalog)
      .catch((err) => setError(`Couldn't load your MCP servers: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const toolChoice: ToolChoice = useMemo(
    () => ({
      serverDeploymentIds: (catalog?.servers ?? []).filter((s) => picked.has(s.deploymentId)).map((s) => s.deploymentId),
      builtinTools: [...(useWeb ? BUILTIN_GROUPS.web : []), ...(useSandbox ? BUILTIN_GROUPS.sandbox : [])],
      appToolkits: [...pickedApps].sort(),
    }),
    [catalog, picked, pickedApps, useWeb, useSandbox],
  );
  // Only the servers chosen for this agent can appear in its plan.
  const servers = useMemo(
    () => new Map((catalog?.servers ?? []).filter((s) => picked.has(s.deploymentId) || isAppsServer(s)).map((s) => [s.name, s])),
    [catalog, picked],
  );

  async function runPlanner(revise: boolean) {
    setBusy("planning");
    setError(null);
    try {
      const result = await proposePlan({
        name: plan?.name ?? name.trim(),
        description: description.trim(),
        focusDeploymentId,
        ...toolChoice,
        // The planner works from the agents; the flow is laid out again from its answer.
        ...(revise && plan ? { previousPlan: { ...plan, flowGraph: undefined }, feedback: feedback.trim() } : {}),
      });
      // The plan may use the ticked apps' tools, which come back as one more server.
      const appsServer = result.catalog.find(isAppsServer);
      setCatalog((current) => current && { ...current, servers: [...current.servers.filter((x) => !isAppsServer(x)), ...(appsServer ? [appsServer] : [])] });
      // A first proposal starts the history; a re-plan is a step you can undo.
      if (revise && plan) history.set(withFlow(result.plan));
      else history.reset(withFlow(result.plan));
      setFeedback("");
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!plan) return;
    setBusy("approving");
    setError(null);
    try {
      const agent = await approvePlan(plan, toolChoice);
      navigate(`agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
      window.scrollTo(0, 0);
    }
  }

  // Shown over the page while the planner or the create request runs.
  const overlay =
    busy === "planning" ? (
      <LoadingOverlay
        kicker="altship agents"
        title={plan ? "Reworking the plan" : "Designing your agent"}
        steps={["Reading what you asked for", "Looking through the tools you picked", "Choosing tools and permissions", "Laying out the flow"]}
        pace={9000}
      />
    ) : busy === "approving" ? (
      <LoadingOverlay
        kicker="altship agents"
        title="Creating your agent"
        steps={["Setting up the agent", "Connecting its tools", "Storing its access securely"]}
        note="This takes a few seconds"
      />
    ) : null;

  if (!plan) {
    return (
      <>
        {overlay}
        <PageHead
          title="New agent"
          description="Name your agent and describe what it should do. We'll propose the tools and flow for you to review and change, or you can build the flow yourself. Nothing is created until you approve."
        />
        {error && <div className="notice">{error}</div>}
        <div className="agent-form">
          <label htmlFor="agent-name">Name</label>
          <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Support triage" />

          <label htmlFor="agent-description">What should it do?</label>
          <textarea
            id="agent-description"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Read new support tickets, look up the customer's orders, and draft a reply. Refunds over $100 need a human."
          />

          <ToolPicker
            pickedApps={pickedApps}
            onToggleApp={(slug, on) =>
              setPickedApps((current) => {
                const next = new Set(current);
                if (on) next.add(slug);
                else next.delete(slug);
                return next;
              })
            }
            catalog={catalog}
            useWeb={useWeb}
            useSandbox={useSandbox}
            picked={picked}
            onWeb={setUseWeb}
            onSandbox={setUseSandbox}
            onToggleServer={(id) =>
              setPicked((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />

          <div className="form-actions">
            <button
              className="btn"
              disabled={busy !== null || !name.trim() || !description.trim()}
              onClick={() => runPlanner(false)}
            >
              {busy === "planning" ? "Designing your agent…" : "Propose a plan"}
            </button>
            <button
              className="secondary"
              disabled={busy !== null || !name.trim()}
              onClick={async () => {
                setError(null);
                try {
                  // The tools of the ticked apps have to be in the catalog before steps can use them.
                  if (toolChoice.appToolkits.length > 0) setCatalog(await getCatalog(toolChoice.appToolkits));
                  history.reset(blankPlan(name.trim(), description.trim()));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Build the flow myself
            </button>
            {busy === "planning" && <span className="hint">This takes up to a minute.</span>}
          </div>
        </div>
      </>
    );
  }

  const toolCount = planToolCount(plan);

  return (
    <>
      {overlay}
      <PageHead
        title="Review the flow"
        description="Add, change, connect or delete steps, then approve. Tools marked “Ask” pause for your approval every time they run."
      />
      {error && <div className="notice">{error}</div>}

      <div className="builder flow-builder">
        <section className="select-step">
          <div className="plan-name">
            <label htmlFor="plan-name">Agent name</label>
            <input id="plan-name" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          </div>

          <FlowEditor
            plan={plan}
            onChange={setPlan}
            servers={servers}
            allowedBuiltins={toolChoice.builtinTools}
            history={history}
            renderAgent={(agent, onChange) => (
              <AgentCard agent={agent} team servers={servers} allowedBuiltins={toolChoice.builtinTools} onChange={onChange} />
            )}
          />

          {plan.gaps.length > 0 && (
            <div className="plan-panel warn">
              <h3>Missing capabilities</h3>
              <ul>
                {plan.gaps.map((g) => (
                  <li key={g.capability}>
                    <strong>{g.capability}</strong> — {g.suggestion}
                  </li>
                ))}
              </ul>
              <Link to="mcp/new" className="panel-link">
                Build an MCP server in MCP Creator →
              </Link>
            </div>
          )}

          {/* Re-planning needs a description to plan from; a flow built by hand may not have one. */}
          {description.trim() && (
          <div className="plan-panel">
            <h3>{plan.assumptions.length > 0 ? "Assumptions to confirm" : "Anything to change?"}</h3>
            {plan.assumptions.length > 0 && (
              <ul>
                {plan.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
            <textarea
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Answer the assumptions or describe a change, e.g. “Refund limit is in USD; only draft replies, never send.”"
            />
            <button className="link" disabled={busy !== null || !feedback.trim()} onClick={() => runPlanner(true)}>
              {busy === "planning" ? "Re-planning…" : "Re-plan with this feedback"}
            </button>
            <p className="hint">Re-planning replaces the flow above, including changes you've made to it. Undo brings it back.</p>
          </div>
          )}

          {plan.testPrompts.length > 0 && (
            <div className="plan-panel">
              <h3>You'll be able to test it with</h3>
              <ul>
                {plan.testPrompts.map((p) => (
                  <li key={p}>“{p}”</li>
                ))}
              </ul>
            </div>
          )}

          <div className="action-bar">
            <button className="secondary" disabled={busy !== null} onClick={() => history.reset(null)}>
              ← Back
            </button>
            <span className="tool-count">
              {plan.agents.length} agent{plan.agents.length === 1 ? "" : "s"} · {toolCount} tool{toolCount === 1 ? "" : "s"}
            </span>
            <button disabled={busy !== null || !plan.name.trim()} onClick={approve}>
              {busy === "approving" ? "Creating…" : "Approve & create"}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * Whether two versions of a plan differ only in details (text, settings, a
 * step's position), not in what steps and connections exist. A run of such
 * edits made in quick succession is one undo step; adding or removing
 * something always gets its own.
 */
function sameKindOfEdit(previous: AgentPlan | null, next: AgentPlan | null): boolean {
  const shape = (p: AgentPlan | null) => {
    const flow = p?.flowGraph;
    const routes = (flow?.nodes ?? []).reduce((n, node) => n + (node.routes?.length ?? 0), 0);
    const tools = (p?.agents ?? []).reduce((n, a) => n + toolCountOf(a), 0);
    return `${p?.agents.length}|${flow?.nodes.length}|${flow?.edges.length}|${routes}|${tools}`;
  };
  return previous !== null && next !== null && shape(previous) === shape(next);
}

/** Which tools the agent may use: built-in ones (no MCP server needed) and any of your MCP servers. */
function ToolPicker({
  pickedApps,
  onToggleApp,
  catalog,
  useWeb,
  useSandbox,
  picked,
  onWeb,
  onSandbox,
  onToggleServer,
}: {
  pickedApps: Set<string>;
  onToggleApp: (slug: string, on: boolean) => void;
  catalog: Catalog | null;
  useWeb: boolean;
  useSandbox: boolean;
  picked: Set<string>;
  onWeb: (on: boolean) => void;
  onSandbox: (on: boolean) => void;
  onToggleServer: (deploymentId: string) => void;
}) {
  // The connected-apps server joins the catalog once apps are ticked; it has its own picker below.
  const ownServers = (catalog?.servers ?? []).filter((s) => !isAppsServer(s));
  return (
    <fieldset className="tool-picker">
      <legend>Tools it can use</legend>
      <p className="hint">Pick what this agent may use; the plan only proposes tools from here. None is fine for an agent that just talks.</p>

      <div className="tool-picker-group">
        <label className="tool-choice">
          <input type="checkbox" checked={useWeb} onChange={(e) => onWeb(e.target.checked)} />
          <span>
            <strong>Web</strong>
            <small>Search the web and read pages.</small>
          </span>
        </label>
        <label className="tool-choice">
          <input type="checkbox" checked={useSandbox} onChange={(e) => onSandbox(e.target.checked)} />
          <span>
            <strong>Code &amp; files</strong>
            <small>A private sandbox to run commands and code, and read and write files.</small>
          </span>
        </label>
      </div>

      <div className="tool-picker-label">Your MCP servers</div>
      {!catalog ? (
        <p className="hint">Loading your MCP servers…</p>
      ) : ownServers.length === 0 ? (
        <p className="hint">
          None yet. Agents don't need one;{" "}
          <Link to="mcp/new" className="inline-link">
            build one in MCP Creator
          </Link>{" "}
          to connect your own API.
        </p>
      ) : (
        <div className="tool-picker-group">
          {ownServers.map((s) => (
            <label key={s.deploymentId} className="tool-choice">
              <input type="checkbox" checked={picked.has(s.deploymentId)} onChange={() => onToggleServer(s.deploymentId)} />
              <span>
                <strong>{s.title}</strong>
                <small>
                  {s.tools.length} tool{s.tools.length === 1 ? "" : "s"}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      {catalog && catalog.unavailable.length > 0 && (
        <p className="hint">Can't be used by agents: {catalog.unavailable.map((u) => `${u.title} (${u.reason})`).join("; ")}</p>
      )}

      <AppsPicker picked={pickedApps} onToggle={onToggleApp} />
    </fieldset>
  );
}

function AgentCard({
  agent,
  team,
  servers,
  allowedBuiltins,
  onChange,
}: {
  agent: PlannedAgent;
  team: boolean;
  servers: Map<string, CatalogServer>;
  allowedBuiltins: ToolChoice["builtinTools"];
  onChange: (patch: Partial<PlannedAgent>) => void;
}) {
  const builtins = agent.builtinTools ?? [];
  const setTool = (index: number, patch: Partial<PlannedTool>) =>
    onChange({ tools: agent.tools.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  const setBuiltin = (index: number, patch: Partial<PlannedBuiltinTool>) =>
    onChange({ builtinTools: builtins.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  const addableBuiltins = allowedBuiltins.filter((tool) => !builtins.some((b) => b.tool === tool));

  const addable = [...servers.values()].flatMap((s) =>
    s.tools
      .filter((t) => !agent.tools.some((p) => p.server === s.name && p.tool === t.name))
      .map((t) => ({ server: s, tool: t })),
  );

  return (
    <div className={`agent-card role-${agent.role}`}>
      <div className="agent-card-head">
        <span className="role-tag">{ROLE_LABEL[agent.role]}</span>
        <input className="agent-name-input" value={agent.name} onChange={(e) => onChange({ name: e.target.value })} aria-label="Agent name" />
        <select value={agent.model} onChange={(e) => onChange({ model: e.target.value as AgentModel })} aria-label="Model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {team && (
        <input
          className="agent-description-input"
          value={agent.description}
          onChange={(e) => onChange({ description: e.target.value })}
          aria-label="What this agent is good at"
          placeholder="What this agent is good at"
        />
      )}

      <details className="instructions">
        <summary>Instructions</summary>
        <textarea rows={8} value={agent.instructions} onChange={(e) => onChange({ instructions: e.target.value })} />
      </details>

      <div className="tool-table">
        {toolCountOf(agent) === 0 && (
          <div className="tool-empty">No tools — this agent answers from its instructions{team ? " and delegates" : ""}.</div>
        )}
        {builtins.map((t, i) => (
          <div key={t.tool} className="tool-row is-selected plan-tool-row">
            <button
              type="button"
              className="tool-remove"
              onClick={() => onChange({ builtinTools: builtins.filter((_, j) => j !== i) })}
              aria-label={`Remove ${BUILTIN_LABELS[t.tool]}`}
              title="Remove this tool"
            >
              ×
            </button>
            <div className="tool-main">
              <div className="tool-name">{BUILTIN_LABELS[t.tool]}</div>
              {t.reason && <p className="tool-desc">{t.reason}</p>}
            </div>
            <div className="tool-side">
              <span className="tool-server">Built-in</span>
              <select
                value={t.permission}
                onChange={(e) => setBuiltin(i, { permission: e.target.value as PlannedBuiltinTool["permission"] })}
                aria-label={`Permission for ${BUILTIN_LABELS[t.tool]}`}
              >
                <option value="auto">Auto</option>
                <option value="ask">Ask</option>
              </select>
            </div>
          </div>
        ))}
        {agent.tools.map((t, i) => {
          const server = servers.get(t.server);
          const catalogTool = server?.tools.find((c) => c.name === t.tool);
          return (
            <div key={`${t.server}/${t.tool}`} className="tool-row is-selected plan-tool-row">
              <button
                type="button"
                className="tool-remove"
                onClick={() => onChange({ tools: agent.tools.filter((_, j) => j !== i) })}
                aria-label={`Remove ${t.tool}`}
                title="Remove this tool"
              >
                ×
              </button>
              <div className="tool-main">
                <div className="tool-name">
                  {t.tool}
                  {catalogTool?.destructive && <span className="flag destructive">Destructive</span>}
                  {catalogTool?.sensitive && <span className="flag sensitive">Sensitive</span>}
                </div>
                {t.reason && <p className="tool-desc">{t.reason}</p>}
              </div>
              <div className="tool-side">
                <span className="tool-server">{server?.title ?? t.server}</span>
                <select
                  value={t.permission}
                  disabled={catalogTool?.destructive}
                  onChange={(e) => setTool(i, { permission: e.target.value as PlannedTool["permission"] })}
                  aria-label={`Permission for ${t.tool}`}
                  title={catalogTool?.destructive ? "Destructive tools always ask" : undefined}
                >
                  <option value="auto">Auto</option>
                  <option value="ask">Ask</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {addable.length + addableBuiltins.length > 0 && (
        <select
          className="add-tool"
          value=""
          onChange={(e) => {
            if (e.target.value.startsWith("builtin:")) {
              const tool = e.target.value.slice("builtin:".length) as PlannedBuiltinTool["tool"];
              onChange({ builtinTools: [...builtins, { tool, permission: "auto", reason: "Added by you." }] });
              return;
            }
            const pick = addable[Number(e.target.value)];
            if (!pick) return;
            onChange({
              tools: [
                ...agent.tools,
                {
                  server: pick.server.name,
                  tool: pick.tool.name,
                  // Actions in someone's own apps wait for approval unless the tool only reads.
                  permission: pick.tool.destructive || (isAppsServer(pick.server) && pick.tool.sensitive) ? "ask" : "auto",
                  reason: "Added by you.",
                },
              ],
            });
          }}
          aria-label="Add a tool"
        >
          <option value="">+ Add a tool…</option>
          {addableBuiltins.map((tool) => (
            <option key={tool} value={`builtin:${tool}`}>
              {BUILTIN_LABELS[tool]} — Built-in
            </option>
          ))}
          {addable.map((a, i) => (
            <option key={`${a.server.name}/${a.tool.name}`} value={i}>
              {a.tool.name} — {a.server.title}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
