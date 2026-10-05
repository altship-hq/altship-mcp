import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  deployToVercel,
  generateServer,
  importSpec,
  type Audience,
  type AuthMode,
  type AuthRequirement,
  type DeployResponse,
  type GenerateResponse,
  type Platform,
  type SpecSource,
  type ToolDefinition,
  type ValidationIssue,
} from "./api.js";
import { ConnectPanel } from "./Access.js";

/** Matches the API's limit for uploaded specs. */
const MAX_SPEC_BYTES = 5 * 1024 * 1024;

type Step = "import" | "select" | "result";

/** The spec → tools → generate/deploy flow. Rendered on MCP Creator's "New server" page. */
export default function Builder({ onDeployed }: { onDeployed?: (deployment: DeployResponse) => void }) {
  const [step, setStep] = useState<Step>("import");
  const [specMode, setSpecMode] = useState<"url" | "file">("url");
  const [specInput, setSpecInput] = useState("");
  const [specFile, setSpecFile] = useState<{ fileName: string; content: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const [audience, setAudience] = useState<Audience>("private");
  const [connectHelpText, setConnectHelpText] = useState("");

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
  const forCustomers = platform === "vercel" && audience === "customers";
  // Servers for customers need the spec to say how users authenticate, since each brings their own credential.
  const customersAvailable = authRequirement !== null;
  const needsCredential = platform === "vercel" && !forCustomers && authRequirement !== null && authMode === "static";

  /** The spec to send: the URL typed in, or the file picked. Null until one is given. */
  const specSource: SpecSource | null =
    specMode === "url" ? (specInput.trim() ? { url: specInput.trim() } : null) : specFile;

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setErrorMessage(null);
    if (file.size > MAX_SPEC_BYTES) {
      setErrorMessage(`${file.name} is larger than 5 MB.`);
      return;
    }
    setSpecFile({ fileName: file.name, content: await file.text() });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files[0]);
  }

  async function handleImport() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await importSpec(specSource!);
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
        const result = await deployToVercel(specSource!, toolNames, {
          authMode: forCustomers ? "static" : authMode,
          credentialValue: forCustomers ? undefined : credentialValue || undefined,
          audience: forCustomers ? "customers" : "private",
          connectHelpText: forCustomers ? connectHelpText.trim() || undefined : undefined,
        });
        setDeployResult(result);
        onDeployed?.(result);
      } else {
        const result = await generateServer(specSource!, toolNames, platform, authMode);
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
    setSpecFile(null);
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
          <div className="spec-tabs" role="tablist" aria-label="Where's your spec?">
            <button
              type="button"
              role="tab"
              aria-selected={specMode === "url"}
              className={specMode === "url" ? "active" : ""}
              onClick={() => setSpecMode("url")}
            >
              From a URL
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={specMode === "file"}
              className={specMode === "file" ? "active" : ""}
              onClick={() => setSpecMode("file")}
            >
              Upload a file
            </button>
          </div>

          {specMode === "url" ? (
            <>
              <label htmlFor="spec">OpenAPI spec URL</label>
              <input
                id="spec"
                value={specInput}
                onChange={(e) => setSpecInput(e.target.value)}
                placeholder="https://api.example.com/openapi.json"
                onKeyDown={(e) => e.key === "Enter" && !loading && specSource && handleImport()}
              />
            </>
          ) : (
            <div
              className={`spec-drop${dragging ? " dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
                hidden
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              {specFile ? (
                <p>
                  <strong>{specFile.fileName}</strong> · {(specFile.content.length / 1024).toFixed(0)} KB{" "}
                  <button type="button" className="link" onClick={() => fileInputRef.current?.click()}>
                    Choose another
                  </button>
                </p>
              ) : (
                <p>
                  Drop your <code>openapi.yaml</code> or <code>.json</code> here, or{" "}
                  <button type="button" className="link" onClick={() => fileInputRef.current?.click()}>
                    choose a file
                  </button>
                  .
                </p>
              )}
            </div>
          )}

          <button disabled={loading || !specSource} onClick={handleImport}>
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
                  <small>Deploy to our servers and get a live MCP endpoint.</small>
                </span>
              </label>
            </div>
          </div>

          {platform === "vercel" && (
            <div className="config-section">
              <h3>Who is this for?</h3>
              <div className="option-grid">
                <label className="option">
                  <input type="radio" name="audience" checked={audience === "private"} onChange={() => setAudience("private")} />
                  <span>
                    <strong>Private</strong>
                    <small>You and people you invite. Connect with access keys, or sign in with your altship account.</small>
                  </span>
                </label>
                <label className={customersAvailable ? "option" : "option option-disabled"} aria-disabled={!customersAvailable}>
                  <input
                    type="radio"
                    name="audience"
                    checked={audience === "customers"}
                    disabled={!customersAvailable}
                    onChange={() => setAudience("customers")}
                  />
                  <span>
                    <strong>For your customers</strong>
                    <small>
                      {customersAvailable
                        ? "Your product's users connect from Claude or ChatGPT with their own API key. No altship account needed."
                        : "Needs the spec to declare how users authenticate (API key, bearer token or basic auth)."}
                    </small>
                  </span>
                </label>
              </div>
            </div>
          )}

          {forCustomers && (
            <div className="config-section">
              <h3>
                <label htmlFor="connect-help">Where do your users find their {authRequirement?.kind === "basic" ? "login" : "API key"}?</label>
              </h3>
              <p className="hint">Optional. Shown on the page your users see when they connect, e.g. "In {apiTitle ?? "your app"}, go to Settings → API."</p>
              <input
                id="connect-help"
                type="text"
                maxLength={300}
                value={connectHelpText}
                onChange={(e) => setConnectHelpText(e.target.value)}
                placeholder="Settings → Developers → API keys"
              />
            </div>
          )}

          {passthroughAvailable && !forCustomers && (
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
              <p className="hint">Required to deploy. Stored encrypted on our servers, never written to the generated code.</p>
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
                  ? "Deploy to altship"
                  : "Generate MCP server"}
            </button>
          </div>
        </section>
      )}

      {step === "result" && deployResult && (
        <section className="card">
          <h2>Deployed</h2>
          <p className="subtitle">
            <code>{deployResult.projectName}</code> is live, exposing {deployResult.toolNames.length} tool(s).{" "}
            {deployResult.audience === "customers"
              ? "Your users connect with their own API key."
              : "Every request needs an access key or an OAuth sign-in."}
          </p>
          <ConnectPanel deployment={deployResult} accessKey={deployResult.accessKey ?? undefined} />
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
