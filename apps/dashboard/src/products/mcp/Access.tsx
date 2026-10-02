import { useEffect, useState, type FormEvent } from "react";
import {
  createAccessKey,
  listAccessKeys,
  mcpUrl,
  revokeAccessKey,
  type AccessKey,
  type DeploymentRecord,
} from "./api.js";
import { Link } from "../../router.js";
import { PageHead } from "../../ui.js";

// How clients connect to a managed MCP server: its endpoint, access keys
// (shown in full once, when created), and OAuth sign-in for chat apps.

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <div className="copy-row">
        <code>{value}</code>
        <button type="button" className="copy-button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** A key that was just created: shown in full this once. */
export function NewKeyNotice({ accessKey }: { accessKey: string }) {
  return (
    <div className="key-notice">
      <strong>Copy this access key now.</strong> You won't be able to see it again.
      <CopyField label="Access key" value={accessKey} />
    </div>
  );
}

/** Endpoint plus how to authenticate, for code/SDK clients and for chat apps. */
export function ConnectPanel({ deployment, accessKey }: { deployment: DeploymentRecord; accessKey?: string }) {
  const endpoint = mcpUrl(deployment);
  const perUser = deployment.authMode === "passthrough";
  const keyHeader = perUser ? `"X-MCP-Access-Key": "${accessKey ?? "<access key>"}"` : `"Authorization": "Bearer ${accessKey ?? "<access key>"}"`;
  const config = `{
  "mcpServers": {
    "${deployment.projectName}": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { ${keyHeader} }
    }
  }
}`;

  return (
    <div className="connect">
      <CopyField label="MCP endpoint" value={endpoint} />
      {accessKey && <NewKeyNotice accessKey={accessKey} />}

      <h3>From code, SDKs and dev tools</h3>
      <p>
        Send an access key with every request
        {perUser ? (
          <>
            {" "}
            in the <code>X-MCP-Access-Key</code> header. <code>Authorization</code> carries each caller's own token for your API.
          </>
        ) : (
          <>
            {" "}
            as <code>Authorization: Bearer &lt;key&gt;</code>.
          </>
        )}{" "}
        For example, in an MCP client config:
      </p>
      <pre className="snippet">{config}</pre>

      {!perUser && (
        <>
          <h3>From claude.ai, ChatGPT and other chat apps</h3>
          <p>
            Add <code>{endpoint}</code> as a custom connector. The app sends you to altship to sign in and approve it; no key
            needed. Only you (the server's owner) can connect this way for now.
          </p>
        </>
      )}
    </div>
  );
}

/** /mcp/servers/<id>: one server's endpoint and access keys. */
export function ServerPage({ deploymentId, deployments, loading }: { deploymentId: string; deployments: DeploymentRecord[]; loading: boolean }) {
  const deployment = deployments.find((d) => d.id === deploymentId);
  const [keys, setKeys] = useState<AccessKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (!deployment) return;
    listAccessKeys(deployment.id)
      .then(setKeys)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [deployment?.id]);

  if (loading) return <div className="empty">Loading…</div>;
  if (!deployment) {
    return (
      <div className="empty">
        <p>This MCP server doesn't exist, or isn't yours.</p>
        <Link className="btn" to="mcp/servers">
          Back to MCP servers
        </Link>
      </div>
    );
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { key, ...record } = await createAccessKey(deployment!.id, name.trim() || "Untitled key");
      setKeys((current) => [...(current ?? []), record]);
      setCreated(key);
      setName("");
      setChanged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function revoke(key: AccessKey) {
    if (!window.confirm(`Revoke "${key.name}"? Clients using it will stop working within about a minute.`)) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAccessKey(deployment!.id, key.id);
      setKeys((current) => (current ?? []).filter((k) => k.id !== key.id));
      setChanged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <>
      <PageHead title={deployment.apiTitle} description={`${deployment.toolNames.length} tools · ${deployment.projectName}`} />
      {error && <div className="notice">{error}</div>}

      <section className="dash-section">
        <h2>Connect</h2>
        <ConnectPanel deployment={deployment} />
      </section>

      <section className="dash-section">
        <div className="section-row">
          <h2>Access keys</h2>
        </div>
        <p className="section-copy">
          Give each client its own key so you can revoke one without affecting the rest. Changes take about a minute to apply
          while the server updates.
        </p>
        {changed && <p className="section-copy">Updating the server with your key changes…</p>}
        {created && <NewKeyNotice accessKey={created} />}

        {keys === null ? (
          <div className="empty">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="empty">
            <p>No access keys. Only OAuth sign-in can reach this server.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="servers">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <strong>{k.name}</strong>
                    </td>
                    <td>
                      <code>{k.prefix}</code>
                    </td>
                    <td className="date">{new Date(k.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td className="row-action">
                      <button type="button" className="link-danger" disabled={busy} onClick={() => revoke(k)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="key-form" onSubmit={create}>
          <input
            type="text"
            placeholder="Key name, e.g. Claude Desktop"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Working…" : "Create key"}
          </button>
        </form>
      </section>
    </>
  );
}
