import { useMemo, useState } from "react";
import {
  generateServer,
  importSpec,
  type GenerateResponse,
  type Platform,
  type ToolDefinition,
  type ValidationIssue,
} from "./api.js";

type Step = "import" | "select" | "result";

export default function App() {
  const [step, setStep] = useState<Step>("import");
  const [specInput, setSpecInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [apiTitle, setApiTitle] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [platform, setPlatform] = useState<Platform>("node");

  const [generateResult, setGenerateResult] = useState<GenerateResponse | null>(null);

  const groups = useMemo(() => groupByNamespace(tools), [tools]);
  const selectedCount = Object.values(selected).filter(Boolean).length;

  async function handleImport() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await importSpec(specInput.trim());
      setApiTitle(result.apiTitle);
      setIssues(result.issues);
      setTools(result.tools);

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
      const result = await generateServer(specInput.trim(), toolNames, platform);
      setGenerateResult(result);
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
    setGenerateResult(null);
  }

  return (
    <div className="page">
      <header>
        <h1>AltShip MCP</h1>
        <p className="subtitle">Turn an OpenAPI spec into a production-ready MCP server.</p>
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
              Vercel (serverless)
            </label>
          </div>

          <div className="actions">
            <button className="secondary" onClick={reset}>
              Back
            </button>
            <button disabled={loading || selectedCount === 0} onClick={handleGenerate}>
              {loading ? "Generating…" : `Generate MCP Server (${selectedCount} tool(s))`}
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
