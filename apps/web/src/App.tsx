import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import {
  deployToVercel,
  generateServer,
  importSpec,
  listDeployments,
  type AuthRequirement,
  type DeployResponse,
  type DeploymentRecord,
  type GenerateResponse,
  type Platform,
  type ToolDefinition,
  type ValidationIssue,
} from "./api.js";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!checkingSession && !session) {
      const redirect = encodeURIComponent(window.location.href);
      window.location.href = `${import.meta.env.VITE_LANDING_URL}/?redirect=${redirect}`;
    }
  }, [checkingSession, session]);

  if (checkingSession || !session) return null;
  return <Workspace session={session} />;
}

type Step = "import" | "select" | "result";

function Workspace({ session }: { session: Session }) {
  const [step, setStep] = useState<Step>("import");
  const [specInput, setSpecInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [apiTitle, setApiTitle] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [platform, setPlatform] = useState<Platform>("node");
  const [authRequirement, setAuthRequirement] = useState<AuthRequirement | null>(null);
  const [credentialValue, setCredentialValue] = useState("");

  const [generateResult, setGenerateResult] = useState<GenerateResponse | null>(null);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);

  const groups = useMemo(() => groupByNamespace(tools), [tools]);
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const needsCredential = platform === "vercel" && authRequirement !== null;

  useEffect(() => {
    refreshDeployments();
  }, []);

  async function refreshDeployments() {
    try {
      setDeployments(await listDeployments());
    } catch {
      // Non-fatal: the main flow doesn't depend on deployment history loading.
    }
  }

  async function handleImport() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await importSpec(specInput.trim());
      setApiTitle(result.apiTitle);
      setIssues(result.issues);
      setTools(result.tools);
      setAuthRequirement(result.auth);

      const initialSelection: Record<string, boolean> = {};
      for (const tool of result.tools) initialSelection[tool.name] = !tool.destructive;
      setSelected(initialSelection);

      if (result.tools.length > 0) setStep("select");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const toolNames = Object.entries(selected)
        .filter(([, checked]) => checked)
        .map(([name]) => name);

      if (platform === "vercel") {
        const result = await deployToVercel(specInput.trim(), toolNames, credentialValue || undefined);
        setDeployResult(result);
        refreshDeployments();
      } else {
        const result = await generateServer(specInput.trim(), toolNames, platform);
        setGenerateResult(result);
      }
      setStep("result");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("import");
    setSpecInput("");
    setErrorMessage(null);
    setApiTitle(null);
    setIssues([]);
    setTools([]);
    setSelected({});
    setAuthRequirement(null);
    setCredentialValue("");
    setGenerateResult(null);
    setDeployResult(null);
  }

  return (
    <div className="page">
      <header className="app-header">
        <div>
          <h1>AltShip MCP</h1>
          <p className="subtitle">Turn an OpenAPI spec into a production-ready MCP server.</p>
        </div>
        <div className="account">
          <span>{session.user.email}</span>
          <button
            className="secondary"
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = import.meta.env.VITE_LANDING_URL;
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {errorMessage && <div className="banner error">{errorMessage}</div>}

      {step === "import" && (
        <section className="card">
          <label htmlFor="spec">OpenAPI spec URL or file path</label>
          <input
            id="spec"
            value={specInput}
            onChange={(e) => setSpecInput(e.target.value)}
            placeholder="https://api.example.com/openapi.json or /path/to/openapi.yaml"
            onKeyDown={(e) => e.key === "Enter" && !loading && specInput.trim() && handleImport()}
          />
          <button disabled={loading || !specInput.trim()} onClick={handleImport}>
            {loading ? "Importing…" : "Import"}
          </button>

          {issues.length > 0 && <IssueList issues={issues} />}
          {apiTitle === null && issues.length > 0 && (
            <p className="hint">Spec failed to parse — fix the issue above and try again.</p>
          )}
        </section>
      )}

      {step === "select" && (
        <section className="card">
          <h2>{apiTitle}</h2>
          <p className="subtitle">
            {tools.length} operation(s) discovered. Review the proposed tool surface — destructive operations are
            unchecked by default.
          </p>
          {issues.length > 0 && <IssueList issues={issues} collapsedByDefault />}

          {Object.entries(groups).map(([namespace, groupTools]) => (
            <div key={namespace} className="group">
              <h3>{namespace}</h3>
              {groupTools.map((tool) => (
                <label key={tool.name} className="tool-row">
                  <input
                    type="checkbox"
                    checked={selected[tool.name] ?? false}
                    onChange={(e) => setSelected((s) => ({ ...s, [tool.name]: e.target.checked }))}
                  />
                  <div className="tool-body">
                    <div className="tool-title">
                      <code>
                        {tool.method} {tool.path}
                      </code>
                      <span className="arrow">→</span>
                      <strong>{tool.name}</strong>
                      {tool.destructive && <span className="flag destructive">destructive</span>}
                      {tool.sensitive && <span className="flag sensitive">sensitive</span>}
                    </div>
                    {tool.description && <p className="tool-desc">{tool.description}</p>}
                  </div>
                </label>
              ))}
            </div>
          ))}

          <div className="platform-picker">
            <span className="platform-label">Deploy target:</span>
            <label>
              <input
                type="radio"
                name="platform"
                checked={platform === "node"}
                onChange={() => setPlatform("node")}
              />
              Node + Docker (self-hosted)
            </label>
            <label>
              <input
                type="radio"
                name="platform"
                checked={platform === "vercel"}
                onChange={() => setPlatform("vercel")}
              />
              Vercel (managed — deploys to a live URL)
            </label>
          </div>

          {needsCredential && (
            <div className="credential-field">
              <label htmlFor="credential">
                {authRequirement?.envVar} <span className="hint">— required to deploy; stored as an encrypted Vercel env var, never written to the generated code</span>
              </label>
              <input
                id="credential"
                type="password"
                value={credentialValue}
                onChange={(e) => setCredentialValue(e.target.value)}
                placeholder="Paste the upstream API credential"
              />
            </div>
          )}

          <div className="actions">
            <button className="secondary" onClick={reset}>
              Back
            </button>
            <button
              disabled={loading || selectedCount === 0 || (needsCredential && !credentialValue.trim())}
              onClick={handleGenerate}
            >
              {loading
                ? platform === "vercel"
                  ? "Deploying…"
                  : "Generating…"
                : platform === "vercel"
                  ? `Deploy to Vercel (${selectedCount} tool(s))`
                  : `Generate MCP Server (${selectedCount} tool(s))`}
            </button>
          </div>
        </section>
      )}

      {step === "result" && deployResult && (
        <section className="card">
          <h2>Deployed</h2>
          <p>
            <a href={deployResult.url} target="_blank" rel="noreferrer">
              {deployResult.url}
            </a>
          </p>
          <p className="subtitle">
            Project <code>{deployResult.projectName}</code> under the altship-mcp org, exposing{" "}
            {deployResult.toolNames.length} tool(s).
          </p>
          {deployResult.warnings.length > 0 && (
            <div className="banner warning">
              {deployResult.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          <div className="actions">
            <button className="secondary" onClick={reset}>
              Start over
            </button>
          </div>
        </section>
      )}

      {step === "result" && generateResult && (
        <section className="card">
          <h2>Server generated</h2>
          <p>
            Wrote {generateResult.filesWritten.length} files to <code>{generateResult.outDir}</code>
          </p>
          <ul className="file-list">
            {generateResult.filesWritten.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {generateResult.warnings.length > 0 && (
            <div className="banner warning">
              {generateResult.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          <div className="actions">
            <button className="secondary" onClick={reset}>
              Start over
            </button>
          </div>
        </section>
      )}

      {step === "import" && deployments.length > 0 && (
        <section className="card">
          <h2>Your MCPs</h2>
          <ul className="deployment-list">
            {deployments.map((d) => (
              <li key={d.id}>
                <div>
                  <strong>{d.apiTitle}</strong> — {d.toolNames.length} tool(s)
                </div>
                <a href={d.url} target="_blank" rel="noreferrer">
                  {d.url}
                </a>
                <span className="deployment-date">{new Date(d.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function IssueList({ issues, collapsedByDefault }: { issues: ValidationIssue[]; collapsedByDefault?: boolean }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const errorCount = issues.filter((i) => i.severity === "error").length;

  return (
    <div className="issues">
      <button className="link" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {issues.length} issue(s){errorCount > 0 ? ` (${errorCount} error)` : ""}
      </button>
      {open && (
        <ul>
          {issues.map((issue, i) => (
            <li key={i} className={issue.severity}>
              [{issue.code}] {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByNamespace(tools: ToolDefinition[]): Record<string, ToolDefinition[]> {
  const groups: Record<string, ToolDefinition[]> = {};
  for (const tool of tools) {
    const namespace = tool.name.split(".")[0];
    (groups[namespace] ??= []).push(tool);
  }
  return groups;
}
