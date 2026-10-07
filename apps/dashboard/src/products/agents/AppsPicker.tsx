import { useEffect, useRef, useState } from "react";
import { Modal } from "../../ui.js";
import { connectApp, disconnectApp, listApps, type AppInfo } from "./api.js";

// The connected-apps part of the tool picker: third-party apps (Gmail,
// Slack, ...) an agent can use on the user's behalf. An app has to be
// connected (the user signs in to it, in a new tab) before it can be ticked.
// The form shows a short list; "See all apps" opens the rest in a modal.

/** How many apps the form shows before "See all apps" (more, if the user has connected more). */
const INLINE_COUNT = 6;

/** One app: a checkbox once it's connected, a Connect button until then. */
function AppRow({
  app,
  picked,
  busy,
  onToggle,
  onConnect,
  onDisconnect,
}: {
  app: AppInfo;
  picked: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (!app.connected) {
    return (
      <div className="tool-choice app-unconnected">
        {app.logo && <img src={app.logo} alt="" width="18" height="18" />}
        <span>
          <strong>{app.name}</strong>
          <small>Not connected</small>
        </span>
        <button type="button" className="secondary" disabled={busy} onClick={onConnect}>
          {busy ? "Opening…" : "Connect"}
        </button>
      </div>
    );
  }
  return (
    <label className="tool-choice">
      <input type="checkbox" checked={picked} onChange={(e) => onToggle(e.target.checked)} />
      {app.logo && <img src={app.logo} alt="" width="18" height="18" />}
      <span>
        <strong>{app.name}</strong>
        <small>
          Connected ·{" "}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onDisconnect();
            }}
          >
            Disconnect
          </button>
        </small>
      </span>
    </label>
  );
}

/**
 * Renders nothing when connected apps aren't set up on this altship.
 * `required` (a template's apps) are listed first, and ticked to begin with
 * when the user has already connected them.
 */
export default function AppsPicker({
  picked,
  onToggle,
  required = [],
}: {
  picked: Set<string>;
  onToggle: (slug: string, on: boolean) => void;
  required?: { slug: string; name: string }[];
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // For the form: the user's connected apps, and the first page of all apps to suggest from.
  const [connected, setConnected] = useState<AppInfo[]>([]);
  const [suggested, setSuggested] = useState<AppInfo[]>([]);
  // The required apps as the provider lists them, looked up once.
  const [requiredApps, setRequiredApps] = useState<AppInfo[]>([]);
  const requiredLoaded = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The app whose sign-in tab is open, so coming back to this tab can tick it.
  const connecting = useRef<string | null>(null);

  // The "all apps" modal: what's listed there, and whether there's more to load.
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [all, setAll] = useState<AppInfo[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const latestSearch = useRef(0);
  const searchField = useRef<HTMLInputElement>(null);

  async function loadForm() {
    try {
      const [mine, first] = await Promise.all([listApps({ connected: true }), listApps()]);
      setEnabled(first.enabled);
      setConnected(mine.apps);
      setSuggested(first.apps);
      if (required.length > 0 && !requiredLoaded.current) {
        requiredLoaded.current = true;
        const known = new Map([...first.apps, ...mine.apps].map((a) => [a.slug, a]));
        const found = await Promise.all(
          required.map(async (r) => known.get(r.slug) ?? (await listApps({ search: r.name })).apps.find((a) => a.slug === r.slug) ?? null),
        );
        setRequiredApps(found.filter((a): a is AppInfo => a !== null));
        for (const r of required) if (mine.apps.some((a) => a.slug === r.slug)) onToggle(r.slug, true);
      }
      const justConnected = connecting.current;
      if (justConnected && mine.apps.some((a) => a.slug === justConnected)) {
        connecting.current = null;
        onToggle(justConnected, true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadAll(query: string) {
    const request = ++latestSearch.current;
    try {
      const page = await listApps({ search: query || undefined });
      if (request !== latestSearch.current) return; // a newer search has started
      setAll(page.apps);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (request === latestSearch.current) setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listApps({ search: search.trim() || undefined, cursor: nextCursor });
      setAll((current) => {
        const seen = new Set((current ?? []).map((a) => a.slug));
        return [...(current ?? []), ...page.apps.filter((a) => !seen.has(a.slug))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoadingMore(false);
  }

  useEffect(() => {
    loadForm();
  }, []);

  // In the modal: search as the user types, after a short pause.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => loadAll(search.trim()), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [open, search]);

  useEffect(() => {
    if (open) searchField.current?.focus();
  }, [open]);

  // Signing in happens in another tab: check again when this one is back in front.
  useEffect(() => {
    const onFocus = () => {
      loadForm();
      if (open) loadAll(search.trim());
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, search]);

  async function connect(app: AppInfo) {
    setBusy(app.slug);
    setError(null);
    // Opened before the request so the browser treats it as the user's click, not a pop-up.
    const tab = window.open("", "_blank");
    try {
      const { url } = await connectApp(app.slug);
      connecting.current = app.slug;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  async function disconnect(app: AppInfo) {
    if (!window.confirm(`Disconnect ${app.name}? Agents that use it will stop being able to.`)) return;
    setBusy(app.slug);
    setError(null);
    try {
      await disconnectApp(app.slug);
      onToggle(app.slug, false);
      await Promise.all([loadForm(), open ? loadAll(search.trim()) : Promise.resolve()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  if (enabled === false) return null;

  // Everything the user has connected, then widely used apps to fill the list out.
  const connectedSlugs = new Set(connected.map((a) => a.slug));
  // A row reflects a connection made since its list loaded.
  const current = (app: AppInfo) => (connectedSlugs.has(app.slug) ? { ...app, connected: true } : app);
  const requiredSlugs = new Set(requiredApps.map((a) => a.slug));
  const others = [...connected, ...suggested.filter((a) => !connectedSlugs.has(a.slug))].filter((a) => !requiredSlugs.has(a.slug));
  const shownOthers = Math.max(connected.filter((a) => !requiredSlugs.has(a.slug)).length, INLINE_COUNT - requiredApps.length);
  const inline = [...requiredApps.map(current), ...others.slice(0, shownOthers)];
  const row = (app: AppInfo) => (
    <AppRow
      key={app.slug}
      app={app}
      picked={picked.has(app.slug)}
      busy={busy === app.slug}
      onToggle={(on) => onToggle(app.slug, on)}
      onConnect={() => connect(app)}
      onDisconnect={() => disconnect(app)}
    />
  );

  return (
    <>
      <div className="tool-picker-label">Connected apps</div>
      <p className="hint">
        Apps the agent can act in for you, like sending an email or posting a message. Connect one by signing in to it, then tick it
        for this agent.
      </p>
      {error && !open && <div className="notice">{error}</div>}
      {enabled === null ? (
        <p className="hint">Loading apps…</p>
      ) : (
        <>
          <div className="tool-picker-group apps-list">{inline.map(row)}</div>
          <button type="button" className="secondary apps-more" onClick={() => setOpen(true)}>
            See all apps
          </button>
        </>
      )}

      {open && (
        <Modal title="Connected apps" wide onClose={() => setOpen(false)}>
          <input
            ref={searchField}
            type="search"
            className="apps-search"
            placeholder="Search apps, e.g. Gmail, Slack, Notion"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search apps"
          />
          {error && <div className="notice">{error}</div>}
          <div className="apps-modal-list">
            {all === null ? (
              <p className="hint">Loading apps…</p>
            ) : all.length === 0 ? (
              <p className="hint">No apps match "{search}".</p>
            ) : (
              <>
                <div className="tool-picker-group apps-list">{all.map((app) => row(current(app)))}</div>
                {nextCursor && (
                  <button type="button" className="secondary apps-more" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="modal-actions">
            <span className="modal-note">
              {picked.size === 0 ? "No apps ticked for this agent." : `${picked.size} app${picked.size === 1 ? "" : "s"} ticked for this agent.`}
            </span>
            <button type="button" className="modal-cancel" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
