import { useMemo, useState } from "react";
import {
  deployToVercel,
  generateServer,
  importSpec,
  type AuthMode,
  type AuthRequirement,
  type DeployResponse,
  type GenerateResponse,
  type Platform,
  type ToolDefinition,
  type ValidationIssue,
} from "./api.js";

type Step = "import" | "select" | "result";

/** The spec → tools → generate/deploy flow. Rendered on MCP Creator's "New server" page. */
export default function Builder({ onDeployed }: { onDeployed?: (deployment: DeployResponse) => void }) {
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
  const [passthroughAvailable, setPassthroughAvailable] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("static");
  const [credentialValue, setCredentialValue] = useState("");

  const [generateResult, setGenerateResult] = useState<GenerateResponse | null>(null);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  const [filter, setFilter] = useState("");
  const visibleTools = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((t) => [t.name, t.path, t.description].some((field) => field?.toLowerCase().includes(query)));
  }, [tools, filter]);
  const visibleGroups = useMemo(() => groupByNamespace(visibleTools), [visibleTools]);
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const needsCredential = platform === "vercel" && authRequirement !== null && authMode === "static";

  async function handleImport() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await importSpec(specInput.trim());
      setApiTitle(result.apiTitle);
      setIssues(result.issues);
      setTools(result.tools);
      setAuthRequirement(result.auth);
      setPassthroughAvailable(result.passthroughAvailable);
      setAuthMode("static");

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
        const result = await deployToVercel(specInput.trim(), toolNames, authMode, credentialValue || undefined);
        setDeployResult(result);
        onDeployed?.(result);
      } else {
        const result = await generateServer(specInput.trim(), toolNames, platform, authMode);
        setGenerateResult(result);
      }
      setStep("result");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function setMany(toolsToSet: ToolDefinition[], checked: boolean) {
    setSelected((s) => {
      const next = { ...s };
      for (const tool of toolsToSet) next[tool.name] = checked;
      return next;
    });
  }

  function reset() {
    setStep("import");
    setSpecInput("");
    setErrorMessage(null);
    setApiTitle(null);
    setIssues([]);
    setTools([]);
    setSelected({});
    setFilter("");
    setAuthRequirement(null);
    setPassthroughAvailable(false);
    setAuthMode("static");
    setCredentialValue("");
    setGenerateResult(null);
    setDeployResult(null);
  }

  return (
    <div className="page">
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
        <section className="select-step">
          <div className="select-head">
            <h2>{apiTitle}</h2>
            <p className="subtitle">
              {tools.length} operation{tools.length === 1 ? "" : "s"} discovered. Choose which ones agents can call —
              destructive operations start unchecked.
            </p>
            {issues.length > 0 && <IssueList issues={issues} collapsedByDefault />}
          </div>

          <div className="tool-toolbar">
            <input
              type="search"
              className="tool-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, path or description"
              aria-label="Filter tools"
            />
            <span className="tool-count">
              {selectedCount} of {tools.length} selected
            </span>
            <button className="link" onClick={() => setMany(visibleTools, true)}>
              Select all
            </button>
            <button className="link" onClick={() => setMany(visibleTools, false)}>
              Clear
            </button>
          </div>

          <div className="tool-table">
            {Object.entries(visibleGroups).map(([namespace, groupTools]) => {
              const checkedCount = groupTools.filter((t) => selected[t.name]).length;
              return (
                <div key={namespace} className="tool-group">
                  <label className="tool-group-head">
                    <input
                      type="checkbox"
                      checked={checkedCount === groupTools.length}
                      ref={(el) => {
                        if (el) el.indeterminate = checkedCount > 0 && checkedCount < groupTools.length;
                      }}
                      onChange={(e) => setMany(groupTools, e.target.checked)}
                    />
                    <span className="tool-group-name">{namespace}</span>
                    <span className="tool-group-count">
                      {checkedCount}/{groupTools.length}
                    </span>
                  </label>
                  {groupTools.map((tool) => (
                    <label key={tool.name} className={selected[tool.name] ? "tool-row is-selected" : "tool-row"}>
                      <input
                        type="checkbox"
                        checked={selected[tool.name] ?? false}
                        onChange={(e) => setSelected((s) => ({ ...s, [tool.name]: e.target.checked }))}
                      />
                      <div className="tool-main">
                        <div className="tool-name">
                          {tool.name}
                          {tool.destructive && <span className="flag destructive">Destructive</span>}
                          {tool.sensitive && <span className="flag sensitive">Sensitive</span>}
                        </div>
                        {tool.description && <p className="tool-desc">{tool.description}</p>}
                      </div>
                      <div className="tool-endpoint">
                        <span className={`method method-${tool.method.toLowerCase()}`}>{tool.method}</span>
                        <code>{tool.path}</code>
                      </div>
                    </label>
                  ))}
                </div>
              );
            })}
            {visibleTools.length === 0 && <div className="tool-empty">No tools match "{filter}".</div>}
          </div>

          <div className="config-section">
            <h3>Deploy target</h3>
            <div className="option-grid">
              <label className="option">
                <input type="radio" name="platform" checked={platform === "node"} onChange={() => setPlatform("node")} />
                <span>
                  <strong>Self-hosted</strong>
                  <small>Node + Docker source you run on your own infrastructure.</small>
                </span>
              </label>
              <label className="option">
                <input type="radio" name="platform" checked={platform === "vercel"} onChange={() => setPlatform("vercel")} />
                <span>
                  <strong>Managed</strong>
                  <small>Deploy to Vercel and get a live MCP endpoint.</small>
                </span>
              </label>
            </div>
          </div>

          {passthroughAvailable && (
            <div className="config-section">
              <h3>Auth model</h3>
              <div className="option-grid">
                <label className="option">
                  <input type="radio" name="authMode" checked={authMode === "static"} onChange={() => setAuthMode("static")} />
                  <span>
                    <strong>Shared credential</strong>
                    <small>One server-side token for every call.</small>
                  </span>
                </label>
                <label className="option">
                  <input type="radio" name="authMode" checked={authMode === "passthrough"} onChange={() => setAuthMode("passthrough")} />
                  <span>
                    <strong>Per-user</strong>
                    <small>Forward each caller's own token; no credential needed here.</small>
                  </span>
                </label>
              </div>
            </div>
          )}

          {needsCredential && (
            <div className="config-section credential-field">
              <h3>
                <label htmlFor="credential">{authRequirement?.envVar}</label>
              </h3>
              <p className="hint">Required to deploy. Stored as an encrypted Vercel env var, never written to the generated code.</p>
              <input
                id="credential"
                type="password"
                value={credentialValue}
                onChange={(e) => setCredentialValue(e.target.value)}
                placeholder="Paste the upstream API credential"
              />
            </div>
          )}

          <div className="action-bar">
            <button className="secondary" onClick={reset}>
              ← Back
            </button>
            <span className="tool-count">
              {selectedCount} tool{selectedCount === 1 ? "" : "s"} selected
            </span>
            <button
              disabled={loading || selectedCount === 0 || (needsCredential && !credentialValue.trim())}
              onClick={handleGenerate}
            >
              {loading
                ? platform === "vercel"
                  ? "Deploying…"
                  : "Generating…"
                : platform === "vercel"
                  ? "Deploy to Vercel"
                  : "Generate MCP server"}
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
