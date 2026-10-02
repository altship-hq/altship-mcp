import { useEffect, useMemo, useState } from "react";
import { Link, navigate } from "../../router.js";
import { PageHead } from "../../ui.js";
import {
  approvePlan,
  getCatalog,
  proposePlan,
  type AgentModel,
  type AgentPlan,
  type Catalog,
  type CatalogServer,
  type PlannedAgent,
  type PlannedTool,
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
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<null | "planning" | "approving">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCatalog()
      .then(setCatalog)
      .catch((err) => setError(`Couldn't load your MCP servers: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const servers = useMemo(() => new Map((catalog?.servers ?? []).map((s) => [s.name, s])), [catalog]);
  const focusServer = catalog?.servers.find((s) => s.deploymentId === focusDeploymentId);

  async function runPlanner(revise: boolean) {
    setBusy("planning");
    setError(null);
    try {
      const result = await proposePlan({
        name: plan?.name ?? name.trim(),
        description: description.trim(),
        focusDeploymentId,
        ...(revise && plan ? { previousPlan: plan, feedback: feedback.trim() } : {}),
      });
      setPlan(result.plan);
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
      const agent = await approvePlan(plan);
      navigate(`agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  function updateAgent(key: string, patch: Partial<PlannedAgent>) {
    setPlan((p) => p && { ...p, agents: p.agents.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  }

  if (!plan) {
    return (
      <>
        <PageHead
          title="New agent"
          description="Name your agent and describe what it should do. We'll propose the tools and flow for you to review — nothing is created until you approve."
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

          <CatalogNote catalog={catalog} focusServer={focusServer} />

          <div className="form-actions">
            <button
              className="btn"
              disabled={busy !== null || !name.trim() || !description.trim()}
              onClick={() => runPlanner(false)}
            >
              {busy === "planning" ? "Designing your agent…" : "Propose a plan"}
            </button>
            {busy === "planning" && <span className="hint">This takes up to a minute.</span>}
          </div>
        </div>
      </>
    );
  }

  const toolCount = plan.agents.reduce((n, a) => n + a.tools.length, 0);

  return (
    <>
      <PageHead
        title="Review the plan"
        description="Adjust anything below, then approve. Tools marked “Ask” pause for your approval every time they run."
      />
      {error && <div className="notice">{error}</div>}

      <div className="builder">
        <section className="select-step">
          <div className="plan-name">
            <label htmlFor="plan-name">Agent name</label>
            <input id="plan-name" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
            <p className="subtitle">
              {plan.flow === "single"
                ? "A single agent handles everything."
                : `A coordinator delegates to ${plan.agents.length - 1} specialist${plan.agents.length === 2 ? "" : "s"}.`}
            </p>
          </div>

          <div className="agent-cards">
            {plan.agents.map((agent) => (
              <AgentCard
                key={agent.key}
                agent={agent}
                team={plan.flow === "team"}
                servers={servers}
                onChange={(patch) => updateAgent(agent.key, patch)}
              />
            ))}
          </div>

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
          </div>

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
            <button className="secondary" disabled={busy !== null} onClick={() => setPlan(null)}>
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

function CatalogNote({ catalog, focusServer }: { catalog: Catalog | null; focusServer?: CatalogServer }) {
  if (!catalog) return <p className="hint">Loading your MCP servers…</p>;
  if (catalog.servers.length === 0) {
    return (
      <p className="hint">
        You don't have any MCP servers yet, so the agent won't have tools.{" "}
        <Link to="mcp/new" className="inline-link">
          Build one in MCP Creator
        </Link>{" "}
        first, or continue and add tools later.
      </p>
    );
  }
  return (
    <p className="hint">
      {focusServer ? (
        <>
          Starting from <strong>{focusServer.title}</strong>. The agent can also use tools from{" "}
        </>
      ) : (
        "The agent can use tools from "
      )}
      {catalog.servers.map((s) => s.title).join(", ")}.
      {catalog.unavailable.length > 0 && ` Not available yet: ${catalog.unavailable.map((u) => u.title).join(", ")}.`}
    </p>
  );
}

function AgentCard({
  agent,
  team,
  servers,
  onChange,
}: {
  agent: PlannedAgent;
  team: boolean;
  servers: Map<string, CatalogServer>;
  onChange: (patch: Partial<PlannedAgent>) => void;
}) {
  const setTool = (index: number, patch: Partial<PlannedTool>) =>
    onChange({ tools: agent.tools.map((t, i) => (i === index ? { ...t, ...patch } : t)) });

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
        {agent.tools.length === 0 && <div className="tool-empty">No tools — this agent can only reason and delegate.</div>}
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

      {addable.length > 0 && (
        <select
          className="add-tool"
          value=""
          onChange={(e) => {
            const pick = addable[Number(e.target.value)];
            if (!pick) return;
            onChange({
              tools: [
                ...agent.tools,
                { server: pick.server.name, tool: pick.tool.name, permission: pick.tool.destructive ? "ask" : "auto", reason: "Added by you." },
              ],
            });
          }}
          aria-label="Add a tool"
        >
          <option value="">+ Add a tool…</option>
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
