import { useEffect, useState, type FormEvent } from "react";
import {
  createMemoryStore,
  deleteMemoryRecord,
  importMemoryNotes,
  listMemoryRecords,
  previewMemoryImport,
  saveMemoryRecord,
  updateMemoryRecord,
  type DeployResponse,
  type DeploymentRecord,
  type MemoryCollection,
  type MemoryImportPlan,
  type MemoryRecord,
} from "./api.js";
import { ConnectPanel } from "./Access.js";
import { Link } from "../../router.js";

// Memory stores: MCP servers altship hosts that hold notes in collections,
// for an LLM or an agent to search and write. Creating one (nothing to import
// or deploy) and browsing or editing its notes.

const TEMPLATES: { id: string; name: string; copy: string }[] = [
  { id: "blank", name: "Blank", copy: "Start empty. Collections appear as notes are saved." },
  { id: "job-search", name: "Job search", copy: "Profile, Preferences, Answers and Applications: what an agent needs to apply for roles on your behalf." },
];

const IMPORT_METHOD: Record<MemoryImportPlan["method"], string> = {
  headings: "Split along the document's headings, keeping every word.",
  ai: "Organised into notes by AI. Check that nothing you care about was left out.",
  paragraphs: "Split by paragraph, since the text had no headings to follow.",
};

/** Where the text to import comes from: pasted, or read from a Markdown or text file in the browser. */
function SourceField({ value, onChange, disabled }: { value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 1_000_000) return setError("That file is too large. Markdown and text files up to 1 MB work.");
    onChange(await file.text());
    setFileName(file.name);
  }

  return (
    <div className="import-source">
      <textarea
        rows={8}
        aria-label="Text to import"
        placeholder="Paste a document, an essay or a few paragraphs: a CV, notes about a product, anything you'd like remembered."
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setFileName(null);
        }}
        disabled={disabled}
      />
      <label className="import-file">
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => pick(e.target.files?.[0])} disabled={disabled} />
        <span>{fileName ? `Loaded ${fileName}` : "or choose a Markdown or text file"}</span>
      </label>
      {error && <div className="notice">{error}</div>}
    </div>
  );
}

/** Turn a document into notes in an existing store: paste or pick it, look at the notes it becomes, then add them. */
function ImportPanel({ storeId, collection, onDone, onCancel }: { storeId: string; collection: string; onDone: () => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [into, setInto] = useState(collection);
  const [plan, setPlan] = useState<MemoryImportPlan | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "save">(null);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setBusy("preview");
    setError(null);
    try {
      setPlan(await previewMemoryImport(storeId, text, into.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  async function save() {
    if (!plan) return;
    setBusy("save");
    setError(null);
    try {
      await importMemoryNotes(storeId, plan.notes);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div className="note-editor import-panel">
      {error && <div className="notice">{error}</div>}
      {!plan ? (
        <>
          <SourceField value={text} onChange={setText} disabled={busy !== null} />
          <input
            aria-label="Collection"
            placeholder="Collection for these notes (optional; headings or AI may choose)"
            maxLength={60}
            value={into}
            onChange={(e) => setInto(e.target.value)}
            disabled={busy !== null}
          />
          <div className="log-actions">
            <button type="button" className="btn" disabled={busy !== null || !text.trim()} onClick={preview}>
              {busy === "preview" ? "Reading it…" : "Preview notes"}
            </button>
            <button type="button" className="copy-button" disabled={busy !== null} onClick={onCancel}>
              Cancel
            </button>
            {busy === "preview" && <span className="hint">Text without headings is organised by AI, which can take up to a minute.</span>}
          </div>
        </>
      ) : (
        <>
          <p className="section-copy">
            This becomes {plan.notes.length} note{plan.notes.length === 1 ? "" : "s"}. {IMPORT_METHOD[plan.method]} Remove any you don't want;
            you can edit them after adding.
          </p>
          <ul className="note-list import-preview">
            {plan.notes.map((n, i) => (
              <li key={i} className="note">
                <div className="note-head">
                  <strong>{n.title}</strong>
                  <span className="note-meta">{n.collection}</span>
                  <button
                    type="button"
                    className="link-danger"
                    disabled={busy !== null}
                    onClick={() => setPlan({ ...plan, notes: plan.notes.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
                {n.body && <p className="note-body">{n.body.length > 240 ? `${n.body.slice(0, 240)}…` : n.body}</p>}
              </li>
            ))}
          </ul>
          <div className="log-actions">
            <button type="button" className="btn" disabled={busy !== null || plan.notes.length === 0} onClick={save}>
              {busy === "save" ? "Adding…" : `Add ${plan.notes.length} note${plan.notes.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" className="copy-button" disabled={busy !== null} onClick={() => setPlan(null)}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** /mcp/memory/new: name it, pick a starting point, get an endpoint. */
export function NewMemoryStore({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DeployResponse | null>(null);
  // Something the user already has written, turned into the store's first notes.
  const [text, setText] = useState("");
  const [imported, setImported] = useState<{ notes: number; collections: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const store = await createMemoryStore(name.trim(), template);
      if (text.trim()) {
        // The store exists either way; a failed import is reported, not fatal.
        try {
          const plan = await previewMemoryImport(store.id, text);
          await importMemoryNotes(store.id, plan.notes);
          setImported({ notes: plan.notes.length, collections: new Set(plan.notes.map((n) => n.collection)).size });
        } catch (err) {
          setImportError(err instanceof Error ? err.message : String(err));
        }
      }
      setCreated(store);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  if (created) {
    return (
      <section className="card">
        <h2>Memory store ready</h2>
        <p className="subtitle">
          <code>{created.name}</code> is live. Connect it to a chat app and say “remember that…”, or give it to an agent. Every request
          needs an access key or a sign-in.
        </p>
        {imported && (
          <div className="banner">
            Your text became {imported.notes} note{imported.notes === 1 ? "" : "s"} in {imported.collections} collection
            {imported.collections === 1 ? "" : "s"}. Open the store to read and edit them.
          </div>
        )}
        {importError && <div className="banner error">The store was created, but your text couldn't be imported: {importError} You can import it from the store's page.</div>}
        <ConnectPanel deployment={created} accessKey={created.accessKey ?? undefined} />
        <div className="actions">
          <Link className="btn" to={`mcp/servers/${created.id}`}>
            Open the store
          </Link>
        </div>
      </section>
    );
  }

  return (
    <form className="card" onSubmit={create}>
      {error && <div className="banner error">{error}</div>}
      <div className="config-section credential-field">
        <h3>
          <label htmlFor="memory-name">Name</label>
        </h3>
        <p className="hint">What this store is called in your dashboard and to the apps that connect to it.</p>
        <input id="memory-name" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="My career notes" />
      </div>

      <div className="config-section">
        <h3>Start from</h3>
        <div className="option-grid">
          {TEMPLATES.map((t) => (
            <label key={t.id} className="option">
              <input type="radio" name="template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span>
                <strong>{t.name}</strong>
                <small>{t.copy}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="config-section">
        <h3>Start with something you've written (optional)</h3>
        <p className="hint">
          A Markdown file, an essay or a few paragraphs. It's turned into notes and collections for you: along its headings if it has
          them, otherwise organised by AI.
        </p>
        <SourceField value={text} onChange={setText} disabled={busy} />
      </div>

      <div className="action-bar">
        <span className="tool-count">Notes are a title, text and tags, grouped into collections.</span>
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? (text.trim() ? "Creating and reading your text…" : "Creating…") : "Create memory store"}
        </button>
      </div>
    </form>
  );
}

const EMPTY = { collection: "", title: "", body: "", tags: "" };

/** A store's notes on its page: browse by collection, search, add, edit and delete. */
export function MemoryNotes({ deployment }: { deployment: DeploymentRecord }) {
  const [collections, setCollections] = useState<Array<MemoryCollection & { notes: number }>>([]);
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [collection, setCollection] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The note being edited: its id, "new" for one being written, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [importing, setImporting] = useState(false);

  async function load() {
    try {
      const result = await listMemoryRecords(deployment.id, { collection: collection || undefined, q: query.trim() || undefined });
      setCollections(result.collections);
      setRecords(result.records);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Search as the user types, after a short pause.
  useEffect(() => {
    const timer = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [deployment.id, collection, query]);

  function startNew() {
    setDraft({ ...EMPTY, collection: collection || collections[0]?.name || "" });
    setEditing("new");
  }

  function startEdit(record: MemoryRecord) {
    setDraft({ collection: record.collection, title: record.title, body: record.body, tags: record.tags.join(", ") });
    setEditing(record.id);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const note = { collection: draft.collection.trim(), title: draft.title.trim(), body: draft.body, tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean) };
    try {
      if (editing === "new") await saveMemoryRecord(deployment.id, note);
      else if (editing) await updateMemoryRecord(deployment.id, editing, note);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function remove(record: MemoryRecord) {
    if (!window.confirm(`Delete "${record.title}"? This can't be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMemoryRecord(deployment.id, record.id);
      if (editing === record.id) setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  const editor = (
    <form className="note-editor" onSubmit={save}>
      <div className="note-editor-row">
        <input
          aria-label="Collection"
          placeholder="Collection, e.g. Profile"
          list="memory-collections"
          maxLength={60}
          value={draft.collection}
          onChange={(e) => setDraft({ ...draft, collection: e.target.value })}
          disabled={busy}
        />
        <input aria-label="Title" placeholder="Title" maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={busy} />
      </div>
      <textarea aria-label="Text" placeholder="What should be remembered" rows={7} maxLength={20000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} disabled={busy} />
      <input aria-label="Tags" placeholder="Tags, separated by commas (optional)" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} disabled={busy} />
      <datalist id="memory-collections">
        {collections.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      <div className="log-actions">
        <button type="submit" className="btn" disabled={busy || !draft.title.trim() || !draft.collection.trim()}>
          {busy ? "Saving…" : "Save note"}
        </button>
        <button type="button" className="copy-button" disabled={busy} onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <section className="dash-section">
      <div className="section-row">
        <h2>Notes</h2>
      </div>
      <p className="section-copy">
        What this store remembers. Apps and agents connected to it add and change notes too; anything they save shows up here.
      </p>
      {error && <div className="notice">{error}</div>}

      <div className="note-filters">
        <button type="button" className={collection === "" ? "note-chip is-on" : "note-chip"} onClick={() => setCollection("")}>
          All
        </button>
        {collections.map((c) => (
          <button
            key={c.name}
            type="button"
            className={collection === c.name ? "note-chip is-on" : "note-chip"}
            title={c.description || undefined}
            onClick={() => setCollection(c.name)}
          >
            {c.name} <span>{c.notes}</span>
          </button>
        ))}
        <input type="search" className="note-search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search notes" />
        <button type="button" className="btn ghost" onClick={() => setImporting(true)} disabled={importing}>
          Import text or file
        </button>
        <button type="button" className="btn" onClick={startNew} disabled={editing === "new"}>
          + New note
        </button>
      </div>

      {importing && (
        <ImportPanel
          storeId={deployment.id}
          collection={collection}
          onCancel={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
      {editing === "new" && editor}

      {records === null ? (
        !error && <div className="empty">Loading…</div>
      ) : records.length === 0 ? (
        <div className="empty">
          <p>{query ? `No notes match "${query}".` : "No notes yet. Add one here, or connect the store to a chat app and say “remember that…”."}</p>
        </div>
      ) : (
        <ul className="note-list">
          {records.map((r) =>
            editing === r.id ? (
              <li key={r.id}>{editor}</li>
            ) : (
              <li key={r.id} className="note">
                <div className="note-head">
                  <strong>{r.title}</strong>
                  <span className="note-meta">
                    {r.collection} · {new Date(r.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                  <button type="button" className="copy-button" disabled={busy} onClick={() => startEdit(r)}>
                    Edit
                  </button>
                  <button type="button" className="link-danger" disabled={busy} onClick={() => remove(r)}>
                    Delete
                  </button>
                </div>
                {r.body && <p className="note-body">{r.body.length > 320 ? `${r.body.slice(0, 320)}…` : r.body}</p>}
                {r.tags.length > 0 && <p className="note-tags">{r.tags.map((t) => `#${t}`).join("  ")}</p>}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
