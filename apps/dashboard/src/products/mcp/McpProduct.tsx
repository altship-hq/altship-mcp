import { useEffect, useState } from "react";
import Builder from "./Builder.js";
import { ServerPage } from "./Access.js";
import { NewMemoryStore } from "./Memory.js";
import { listDeployments, type DeploymentRecord } from "./api.js";
import { Link } from "../../router.js";
import { PageHead, Stat } from "../../ui.js";

// MCP Creator's pages inside the dashboard: /mcp, /mcp/servers,
// /mcp/servers/<id> (endpoint and access keys), /mcp/new.

const NEW_SERVER = "mcp/new";

const newServerButton = (
  <span className="head-actions">
    <Link className="btn ghost" to="mcp/memory/new">
      + New memory
    </Link>
    <Link className="btn" to={NEW_SERVER}>
      + New MCP server
    </Link>
  </span>
);

export default function McpProduct({ subpath }: { subpath: string }) {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refreshDeployments() {
    try {
      setDeployments(await listDeployments());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshDeployments();
  }, []);

  if (subpath === "new") {
    return (
      <>
        <PageHead
          title="New MCP server"
          description="Import an OpenAPI spec, choose the tools to expose, then generate the source or deploy it."
        />
        <div className="builder">
          <Builder onDeployed={refreshDeployments} />
        </div>
      </>
    );
  }

  if (subpath === "memory/new") {
    return (
      <>
        <PageHead
          title="New memory"
          description="An MCP server that remembers: notes by topic that your chat apps and agents can search and add to. Nothing to import or deploy."
        />
        <div className="builder">
          <NewMemoryStore onCreated={refreshDeployments} />
        </div>
      </>
    );
  }

  const serverId = subpath.match(/^servers\/([^/]+)$/)?.[1];

  return (
    <>
      {loadError && <div className="notice">Couldn't load your MCP servers: {loadError}</div>}
      {serverId ? (
        <ServerPage
          deploymentId={serverId}
          deployments={deployments}
          loading={loading}
          onUpdated={(updated) => setDeployments((current) => current.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)))}
        />
      ) : subpath === "servers" ? (
        <>
          <PageHead title="MCP servers" description="Servers you've deployed to a managed endpoint." action={newServerButton} />
          <ServerTable deployments={deployments} loading={loading} />
        </>
      ) : (
        <Overview deployments={deployments} loading={loading} />
      )}
    </>
  );
}

const QUICKSTART = [
  { title: "Import a spec", copy: "Point at an OpenAPI 3.x spec by URL or path. We validate it and flag what an agent would trip over." },
  { title: "Review the tools", copy: "Operations become named tools. Destructive and sensitive ones are flagged and start unselected." },
  { title: "Generate or deploy", copy: "Download a self-hosted server with a Dockerfile, or deploy to a live managed endpoint." },
];

function Overview({ deployments, loading }: { deployments: DeploymentRecord[]; loading: boolean }) {
  const toolCount = deployments.reduce((sum, d) => sum + d.toolNames.length, 0);
  const latest = deployments[0];

  return (
    <>
      <PageHead title="MCP Creator" description="Turn an OpenAPI spec into a production-ready MCP server." action={newServerButton} />

      <div className="stats">
        <Stat label="MCP servers" value={loading ? "—" : String(deployments.length)} />
        <Stat label="Tools exposed" value={loading ? "—" : String(toolCount)} />
        <Stat label="Last deployed" value={loading ? "—" : latest ? formatDate(latest.createdAt) : "Never"} />
      </div>

      <section className="dash-section">
        <h2>Get started</h2>
        <ol className="quickstart">
          {QUICKSTART.map((step, i) => (
            <li key={step.title}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="dash-section">
        <div className="section-row">
          <h2>Recent MCP servers</h2>
          {deployments.length > 0 && <Link to="mcp/servers">View all →</Link>}
        </div>
        <ServerTable deployments={deployments.slice(0, 5)} loading={loading} />
      </section>
    </>
  );
}

function ServerTable({ deployments, loading }: { deployments: DeploymentRecord[]; loading: boolean }) {
  if (loading) return <div className="empty">Loading…</div>;
  if (deployments.length === 0) {
    return (
      <div className="empty">
        <p>No MCP servers yet.</p>
        <Link className="btn" to={NEW_SERVER}>
          Build your first MCP server
        </Link>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="servers">
        <thead>
          <tr>
            <th>Name</th>
            <th>Tools</th>
            <th>Endpoint</th>
            <th>Created</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.id}>
              <td className="server-name">
                <Link to={`mcp/servers/${d.id}`}>
                  <strong>{d.name}</strong>
                </Link>
                <small>
                  {d.kind === "memory" && <span className="soon-tag kind-tag">Memory</span>}
                  {d.projectName}
                </small>
              </td>
              <td title={d.toolNames.join(", ")}>{d.toolNames.length}</td>
              <td>
                <a className="endpoint" href={d.url} target="_blank" rel="noreferrer">
                  {d.url.replace(/^https?:\/\//, "")}
                </a>
              </td>
              <td className="date">{formatDate(d.createdAt)}</td>
              <td className="row-action">
                <Link to={`mcp/servers/${d.id}`}>Keys &amp; connect</Link>
                <Link to={`agents/new?server=${d.id}`}>Create agent →</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
