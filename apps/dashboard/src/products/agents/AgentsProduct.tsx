import { useEffect, useState } from "react";
import { Link } from "../../router.js";
import { PageHead } from "../../ui.js";
import { flowLabel, listAgents, type AgentRecord, toolCountOf } from "./api.js";
import NewAgent from "./NewAgent.js";
import AgentDetail from "./AgentDetail.js";

// Agent Creator's pages: /agents, /agents/new, /agents/<id>[/flow|/deploy|/runs].

export default function AgentsProduct({ subpath }: { subpath: string }) {
  if (subpath === "new") return <NewAgent />;
  if (subpath.startsWith("agt_")) {
    const [id, tab] = subpath.split("/");
    return <AgentDetail id={id} tab={tab === "deploy" || tab === "runs" || tab === "flow" ? tab : "playground"} />;
  }
  return <Overview />;
}

const newAgentButton = (
  <Link className="btn" to="agents/new">
    + New agent
  </Link>
);

function Overview() {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setAgents([]);
      });
  }, []);

  return (
    <>
      <PageHead
        title="Agent Creator"
        description="Describe an agent in plain language. We propose the tools and flow, you approve, then test and deploy it."
        action={newAgentButton}
      />
      {error && <div className="notice">Couldn't load your agents: {error}</div>}

      {agents === null ? (
        <div className="empty">Loading…</div>
      ) : agents.length === 0 ? (
        <div className="empty">
          <p>No agents yet. Describe one and we'll suggest the tools and flow it needs.</p>
          <Link className="btn" to="agents/new">
            Create your first agent
          </Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="servers">
            <thead>
              <tr>
                <th>Name</th>
                <th>Flow</th>
                <th>Tools</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="server-name">
                    <Link to={`agents/${a.id}`} className="row-link">
                      <strong>{a.name}</strong>
                    </Link>
                    <span className="row-sub">{a.description}</span>
                  </td>
                  <td>{flowLabel(a)}</td>
                  <td>{a.plan.agents.reduce((n, ag) => n + toolCountOf(ag), 0)}</td>
                  <td className="date">{new Date(a.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
