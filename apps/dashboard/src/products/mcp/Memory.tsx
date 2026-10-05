import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addMemoryTopic,
  createMemoryStore,
  deleteMemoryRecord,
  deleteMemoryTopic,
  importMemoryNotes,
  listMemoryRecords,
  previewMemoryImport,
  saveMemoryRecord,
  updateMemoryRecord,
  updateMemoryTopic,
  type DeployResponse,
  type DeploymentRecord,
  type MemoryCollection,
  type MemoryImportPlan,
  type MemoryRecord,
} from "./api.js";
import { ConnectPanel } from "./Access.js";
import { Link } from "../../router.js";
import { ConfirmDialog } from "../../ui.js";

// Memories: MCP servers altship hosts that keep notes for an LLM or an agent to
// search and write. A memory has a name, a description and topics (such as
// "Technical skills"); each note belongs to a topic. Creating one (nothing to
// import or deploy) and browsing or editing its notes.

const IMPORT_METHOD: Record<MemoryImportPlan["method"], string> = {
  headings: "Split along the document's headings, keeping every word.",
  ai: "Organised into notes by AI. Check that nothing you care about was left out.",
  paragraphs: "Split by paragraph, since the text had no headings to follow.",
};

/** Text to remember: typed or pasted, or loaded from a Markdown or text file with the Upload button. */
function SourceField({
  value,
  onChange,
  disabled,
  rows = 8,
  placeholder = "Paste or write what should be remembered: a document, an essay or a few paragraphs.",
  label = "Text",
}: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  label?: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
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
        rows={rows}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setFileName(null);
        }}
        disabled={disabled}
      />
      <div className="upload-row">
        <button type="button" className="upload-button" onClick={() => picker.current?.click()} disabled={disabled}>
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2.5h12V13" />
          </svg>
          Upload a file
        </button>
        <span className="upload-note">{fileName ? `Loaded ${fileName}` : "Markdown or text, up to 1 MB"}</span>
        <input
          ref={picker}
          type="file"
          hidden
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            // So choosing the same file again still loads it.
            e.target.value = "";
          }}
        />
      </div>
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
            aria-label="Topic"
            placeholder="Topic for these notes (optional; headings or AI may choose)"
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

interface TopicDraft {
  id: number;
  title: string;
  text: string;
}

/** /mcp/memory/new: a name, what it's about, what to remember, and any topics under it. */
export function NewMemoryStore({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [topics, setTopics] = useState<TopicDraft[]>([]);
  const nextTopicId = useRef(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DeployResponse | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const setTopic = (id: number, patch: Partial<TopicDraft>) => setTopics((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const named = topics.filter((t) => t.title.trim());
  const unnamedWithText = topics.some((t) => !t.title.trim() && t.text.trim());

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const store = await createMemoryStore({ name: name.trim(), description: description.trim(), topics: named.map((t) => t.title.trim()) });
      // The memory exists from here on; text that can't be turned into notes is reported, not fatal.
      let notes = 0;
      const failures: string[] = [];
      const add = async (label: string, source: string, topic?: string) => {
        if (!source.trim()) return;
        try {
          // Text written under a topic stays in it; the main text is organised by its headings, or by AI.
          const plan = await previewMemoryImport(store.id, source, topic, topic !== undefined);
          await importMemoryNotes(store.id, plan.notes);
          notes += plan.notes.length;
        } catch (err) {
          failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      await add("The main text", text);
      for (const topic of named) await add(topic.title.trim(), topic.text, topic.title.trim());
      setImported(notes);
      setImportErrors(failures);
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
        <h2>Memory ready</h2>
        <p className="subtitle">
          <code>{created.name}</code> is live{imported ? ` with ${imported} note${imported === 1 ? "" : "s"}` : ""}. Connect it to a chat app and say
          “remember that…”, or give it to an agent. Every request needs an access key or a sign-in.
        </p>
        {importErrors.length > 0 && (
          <div className="banner error">
            The memory was created, but some text couldn't be turned into notes. You can add it from the memory's page.
            {importErrors.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        )}
        <ConnectPanel deployment={created} accessKey={created.accessKey ?? undefined} />
        <div className="actions">
          <Link className="btn" to={`mcp/servers/${created.id}`}>
            Open the memory
          </Link>
        </div>
      </section>
    );
  }

  const hasText = Boolean(text.trim()) || named.some((t) => t.text.trim());

  return (
    <form className="card memory-form" onSubmit={create}>
      {error && <div className="banner error">{error}</div>}

      <div className="config-section credential-field">
        <h3>
          <label htmlFor="memory-name">Title</label>
        </h3>
        <input id="memory-name" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My career" disabled={busy} />
      </div>

      <div className="config-section credential-field">
        <h3>
          <label htmlFor="memory-description">Description</label>
        </h3>
        <p className="hint">What this memory is about. The apps and agents that use it are told this, so they know when to look here.</p>
        <input
          id="memory-description"
          type="text"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. My work history, skills and what I'm looking for next"
          disabled={busy}
        />
      </div>

      <div className="config-section">
        <h3>What to remember</h3>
        <p className="hint">Optional. It's turned into notes for you: along its headings if it has them, otherwise organised by AI.</p>
        <SourceField value={text} onChange={setText} disabled={busy} label="What to remember" />
      </div>

      <div className="config-section">
        <h3>Topics</h3>
        <p className="hint">
          Optional. Split the memory into areas, each with its own text, such as “Technical skills” or “Companies I'm interested in”. More
          can be added later.
        </p>
        {topics.map((topic) => (
          <div key={topic.id} className="topic-draft">
            <div className="topic-draft-head">
              <input
                type="text"
                aria-label="Topic title"
                placeholder="Topic title"
                maxLength={60}
                value={topic.title}
                onChange={(e) => setTopic(topic.id, { title: e.target.value })}
                disabled={busy}
              />
              <button type="button" className="link-danger" onClick={() => setTopics((current) => current.filter((t) => t.id !== topic.id))} disabled={busy}>
                Remove topic
              </button>
            </div>
            <SourceField
              value={topic.text}
              onChange={(value) => setTopic(topic.id, { text: value })}
              disabled={busy}
              rows={4}
              label={`Text for ${topic.title || "this topic"}`}
              placeholder="What should be remembered under this topic (optional)"
            />
          </div>
        ))}
        <button type="button" className="upload-button" onClick={() => setTopics((current) => [...current, { id: nextTopicId.current++, title: "", text: "" }])} disabled={busy || topics.length >= 30}>
          + Add a topic
        </button>
        {unnamedWithText && <p className="hint">Give each topic a title; a topic without one isn't saved.</p>}
      </div>

      <div className="action-bar">
        <span className="tool-count">You can add, edit and import more once it's created.</span>
        <button type="submit" disabled={busy || !name.trim() || unnamedWithText}>
          {busy ? (hasText ? "Creating and reading your text…" : "Creating…") : "Create memory"}
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
  // The topic form: "new" to add one, a topic's name to edit it, or null when closed.
  const [topicForm, setTopicForm] = useState<string | null>(null);
  const [topicDraft, setTopicDraft] = useState({ name: "", description: "" });
  const selected = collections.find((c) => c.name === collection) ?? null;

  async function saveTopic(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const name = topicDraft.name.trim();
      if (topicForm === "new") await addMemoryTopic(deployment.id, name, topicDraft.description.trim());
      else if (topicForm) await updateMemoryTopic(deployment.id, topicForm, { name, description: topicDraft.description.trim() });
      setTopicForm(null);
      // Stay on the topic under its new name; the list reloads when the selection changes.
      if (collection === name) await load();
      else setCollection(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  // The topic the delete dialog is asking about.
  const [deleting, setDeleting] = useState<(MemoryCollection & { notes: number }) | null>(null);

  async function removeTopic(topic: MemoryCollection & { notes: number }) {
    setBusy(true);
    setError(null);
    try {
      await deleteMemoryTopic(deployment.id, topic.name);
      setTopicForm(null);
      setEditing(null);
      setCollection("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeleting(null);
    setBusy(false);
  }

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
          aria-label="Topic"
          placeholder="Topic, e.g. Technical skills"
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
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete permanently"
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => removeTopic(deleting)}
        >
          <p>
            This permanently deletes the topic
            {deleting.notes > 0 ? (
              <>
                {" "}
                and the <strong>{deleting.notes} note{deleting.notes === 1 ? "" : "s"}</strong> in it
              </>
            ) : null}{" "}
            from this memory. Apps and agents that use the memory will no longer find {deleting.notes === 1 ? "it" : "them"}.
          </p>
          <p>This can't be undone.</p>
        </ConfirmDialog>
      )}
      <div className="section-row">
        <h2>Notes</h2>
      </div>
      <p className="section-copy">
        What this memory holds, by topic. It grows as it's used: apps and agents connected to it save what they learn and add topics
        of their own, marked as created by the agent.
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
            title={[c.description, c.createdBy === "agent" ? "Created by agent" : ""].filter(Boolean).join(" · ") || undefined}
            onClick={() => setCollection(c.name)}
          >
            {c.name} <span>{c.notes}</span>
            {c.createdBy === "agent" && <span className="agent-dot" aria-label="Created by agent" />}
          </button>
        ))}
        <button
          type="button"
          className="note-chip note-chip-add"
          disabled={busy || topicForm === "new"}
          onClick={() => {
            setTopicDraft({ name: "", description: "" });
            setTopicForm("new");
          }}
        >
          + Topic
        </button>
        <input type="search" className="note-search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search notes" />
        <button type="button" className="btn ghost" onClick={() => setImporting(true)} disabled={importing}>
          Import text or file
        </button>
        <button type="button" className="btn" onClick={startNew} disabled={editing === "new"}>
          + New note
        </button>
      </div>

      {topicForm ? (
        <form className="note-editor topic-form" onSubmit={saveTopic}>
          <div className="note-editor-row">
            <input
              aria-label="Topic name"
              placeholder="Topic name, e.g. Technical skills"
              maxLength={60}
              autoFocus
              value={topicDraft.name}
              onChange={(e) => setTopicDraft({ ...topicDraft, name: e.target.value })}
              disabled={busy}
            />
            <input
              aria-label="Topic description"
              placeholder="What belongs in it (optional)"
              maxLength={500}
              value={topicDraft.description}
              onChange={(e) => setTopicDraft({ ...topicDraft, description: e.target.value })}
              disabled={busy}
            />
          </div>
          <div className="log-actions">
            <button type="submit" className="btn" disabled={busy || !topicDraft.name.trim()}>
              {busy ? "Saving…" : topicForm === "new" ? "Add topic" : "Save topic"}
            </button>
            <button type="button" className="copy-button" disabled={busy} onClick={() => setTopicForm(null)}>
              Cancel
            </button>
            {topicForm !== "new" && <span className="hint">Renaming a topic moves its notes with it.</span>}
          </div>
        </form>
      ) : (
        selected && (
          <div className="topic-bar">
            <span>
              <strong>{selected.name}</strong>
              {selected.createdBy === "agent" && <span className="agent-tag">Created by agent</span>}
              {selected.description ? ` · ${selected.description}` : " · No description"}
            </span>
            <button
              type="button"
              className="copy-button"
              disabled={busy}
              onClick={() => {
                setTopicDraft({ name: selected.name, description: selected.description });
                setTopicForm(selected.name);
              }}
            >
              Edit topic
            </button>
            <button type="button" className="link-danger" disabled={busy} onClick={() => setDeleting(selected)}>
              Delete topic
            </button>
          </div>
        )
      )}

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
          <p>{query ? `No notes match "${query}".` : "No notes yet. Add one here, or connect the memory to a chat app and say “remember that…”."}</p>
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
                    {r.createdBy === "agent" && <span className="agent-tag">Added by agent</span>}
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
