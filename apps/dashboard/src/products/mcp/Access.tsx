import { useEffect, useState, type FormEvent } from "react";
import {
  cancelInvite,
  createAccessKey,
  inviteMember,
  listAccessKeys,
  listConnections,
  listMembers,
  mcpUrl,
  removeMember,
  renameDeployment,
  revokeAccessKey,
  revokeConnection,
  type AccessKey,
  type DeploymentRecord,
  type EndUserConnection,
  type Invite,
  type Member,
} from "./api.js";
import { Link } from "../../router.js";
import { PageHead } from "../../ui.js";
import { ToolCallLog } from "../observability/ObservabilityProduct.js";

// How clients connect to a managed MCP server. Private servers: endpoint,
// access keys (shown in full once, when created) and OAuth sign-in for chat
// apps. Servers for customers: instructions to share with end users, and the
// people who've connected.

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
  if (deployment.audience === "customers") return <CustomerConnectPanel deployment={deployment} />;
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
            needed. You and anyone you invite under People can connect this way.
          </p>
        </>
      )}
    </div>
  );
}

/** For servers offered to customers: what the owner shares with their users. */
function CustomerConnectPanel({ deployment }: { deployment: DeploymentRecord }) {
  const endpoint = mcpUrl(deployment);
  const product = deployment.connectSettings?.displayName ?? deployment.apiTitle;
  const credential = deployment.connectSettings?.credentialKind === "basic" ? "username and password" : "API key";
  const docs = `## Use ${product} in Claude, ChatGPT and other AI apps

1. In your AI app, add a custom connector (MCP server) with this URL:
   ${endpoint}
2. When asked, enter your ${product} ${credential} and click Connect.

The app can then use ${product} for you, with your own account's access.`;

  return (
    <div className="connect">
      <CopyField label="MCP endpoint" value={endpoint} />
      <p>
        Share this URL with your users. When they add it in Claude, ChatGPT or another MCP client, they're asked for their own{" "}
        {product} {credential} on a {product}-branded page. They don't need an altship account, and each person only gets their
        own account's access.
      </p>
      <h3>For your docs</h3>
      <pre className="snippet">{docs}</pre>
      <CopyField label="Copy for your docs" value={docs} />
    </div>
  );
}

/** For servers offered to customers: the people who've connected, with revoke. */
function Connections({ deployment }: { deployment: DeploymentRecord }) {
  const [connections, setConnections] = useState<EndUserConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listConnections(deployment.id)
      .then(setConnections)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [deployment.id]);

  async function revoke(connection: EndUserConnection) {
    if (!window.confirm("Disconnect this user? Their app loses access within the hour, and they'd need to connect again.")) return;
    setBusy(true);
    setError(null);
    try {
      await revokeConnection(deployment.id, connection.id);
      setConnections((current) => (current ?? []).filter((c) => c.id !== connection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

  return (
    <section className="dash-section">
      <h2>Connected users</h2>
      {error && <div className="notice">{error}</div>}
      {connections === null ? (
        <div className="empty">Loading…</div>
      ) : connections.length === 0 ? (
        <div className="empty">
          <p>Nobody has connected yet. Share the endpoint above with your users.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="servers">
            <thead>
              <tr>
                <th>App</th>
                <th>Credential</th>
                <th>Connected</th>
                <th>Last used</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.clientName ?? "Unknown app"}</strong>
                  </td>
                  <td>
                    <code>{c.credentialHint}</code>
                  </td>
                  <td className="date">{date(c.createdAt)}</td>
                  <td className="date">{date(c.lastUsedAt)}</td>
                  <td className="row-action">
                    <button type="button" className="link-danger" disabled={busy} onClick={() => revoke(c)}>
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** For private servers: other altship users who may sign in, with invite, cancel and remove. */
function People({ deployment }: { deployment: DeploymentRecord }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [sent, setSent] = useState<(Invite & { emailed: boolean }) | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    listMembers(deployment.id)
      .then((people) => {
        setMembers(people.members);
        setInvites(people.invites);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [deployment.id]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const created = await inviteMember(deployment.id, email.trim());
      setInvites((current) => [...current.filter((i) => i.id !== created.id), created]);
      setSent(created);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function cancel(pending: Invite) {
    if (!window.confirm(`Cancel the invite for ${pending.email}? Their link will stop working.`)) return;
    setBusy(true);
    setError(null);
    try {
      await cancelInvite(deployment.id, pending.id);
      setInvites((current) => current.filter((i) => i.id !== pending.id));
      if (sent?.id === pending.id) setSent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function remove(member: Member) {
    if (!window.confirm(`Remove ${member.email}? They'll lose access within about a minute.`)) return;
    setBusy(true);
    setError(null);
    try {
      await removeMember(deployment.id, member.userId);
      setMembers((current) => (current ?? []).filter((m) => m.userId !== member.userId));
      setChanged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function copyLink(pending: Invite) {
    await navigator.clipboard.writeText(pending.link);
    setCopied(pending.id);
    setTimeout(() => setCopied(null), 1500);
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <section className="dash-section">
      <div className="section-row">
        <h2>People</h2>
      </div>
      <p className="section-copy">
        Invite someone by email so they can connect from claude.ai, ChatGPT and other chat apps by signing in as themselves. They
        accept with an altship account for that address, creating one if they need to. They use this server's API credential,
        and they don't see the server in their own dashboard.
      </p>
      {error && <div className="notice">{error}</div>}
      {changed && <p className="section-copy">Updating the server with your changes…</p>}
      {sent &&
        (sent.emailed ? (
          <p className="section-copy">Invite emailed to {sent.email}.</p>
        ) : (
          <div className="key-notice">
            <strong>Send {sent.email} this link.</strong> We couldn't email it for you.
            <CopyField label="Invite link" value={sent.link} />
          </div>
        ))}

      {members === null ? (
        <div className="empty">Loading…</div>
      ) : members.length === 0 && invites.length === 0 ? (
        <div className="empty">
          <p>Nobody else yet. Only you can sign in to this server.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="servers">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Added</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <strong>{m.email}</strong>
                  </td>
                  <td>Active</td>
                  <td className="date">{date(m.createdAt)}</td>
                  <td className="row-action">
                    <button type="button" className="link-danger" disabled={busy} onClick={() => remove(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.email}</strong>
                  </td>
                  <td>Invited</td>
                  <td className="date">{date(i.createdAt)}</td>
                  <td className="row-action">
                    <button type="button" className="copy-button" onClick={() => copyLink(i)}>
                      {copied === i.id ? "Copied" : "Copy link"}
                    </button>{" "}
                    <button type="button" className="link-danger" disabled={busy} onClick={() => cancel(i)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="key-form" onSubmit={invite}>
        <input
          type="email"
          placeholder="Their email, e.g. sam@example.com"
          value={email}
          maxLength={254}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Working…" : "Invite"}
        </button>
      </form>
    </section>
  );
}

/** The server's name as the page heading, with a way to change it. */
function ServerHead({ deployment, onRenamed }: { deployment: DeploymentRecord; onRenamed?: (renamed: DeploymentRecord) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(deployment.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const description = `${deployment.toolNames.length} tools · ${deployment.projectName}`;

  function start() {
    setName(deployment.name);
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onRenamed?.(await renameDeployment(deployment.id, name));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  if (!editing) {
    return (
      <PageHead
        title={deployment.name}
        description={description}
        action={
          <button type="button" className="btn" onClick={start}>
            Rename
          </button>
        }
      />
    );
  }

  return (
    <div className="page-head">
      <div className="rename">
        {error && <div className="notice">{error}</div>}
        <form className="key-form" onSubmit={save}>
          <input
            type="text"
            aria-label="Server name"
            placeholder={deployment.apiTitle}
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="copy-button" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
        <p>Leave it empty to use the spec's title, {deployment.apiTitle}.</p>
      </div>
    </div>
  );
}

/** /mcp/servers/<id>: one server's endpoint, people and access keys. */
export function ServerPage({
  deploymentId,
  deployments,
  loading,
  onRenamed,
}: {
  deploymentId: string;
  deployments: DeploymentRecord[];
  loading: boolean;
  onRenamed?: (renamed: DeploymentRecord) => void;
}) {
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

  if (deployment.audience === "customers") {
    return (
      <>
        <ServerHead deployment={deployment} onRenamed={onRenamed} />
        <section className="dash-section">
          <h2>Who it's for</h2>
          <div className="audience-row">
            <strong>Your customers</strong>
            <span>Anyone with a {deployment.connectSettings?.displayName ?? deployment.apiTitle} account, signing in with their own credential.</span>
          </div>
        </section>
        <section className="dash-section">
          <h2>Connect</h2>
          <ConnectPanel deployment={deployment} />
        </section>
        <Connections deployment={deployment} />
        <section className="dash-section">
          <div className="section-row">
            <h2>Recent calls</h2>
            <Link to="observability">All logs →</Link>
          </div>
          <ToolCallLog deploymentId={deployment.id} pageSize={10} />
        </section>
      </>
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
      <ServerHead deployment={deployment} onRenamed={onRenamed} />
      {error && <div className="notice">{error}</div>}

      <section className="dash-section">
        <h2>Who it's for</h2>
        <div className="audience-row">
          <strong>Private</strong>
          <span>
            {deployment.authMode === "passthrough"
              ? "You and anyone holding an access key."
              : "You, people you invite, and anyone holding an access key."}
          </span>
        </div>
      </section>

      <section className="dash-section">
        <h2>Connect</h2>
        <ConnectPanel deployment={deployment} />
      </section>

      {deployment.authMode !== "passthrough" && <People deployment={deployment} />}

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
      <section className="dash-section">
        <div className="section-row">
          <h2>Recent calls</h2>
          <Link to="observability">All logs →</Link>
        </div>
        <ToolCallLog deploymentId={deployment.id} pageSize={10} />
      </section>
    </>
  );
}
