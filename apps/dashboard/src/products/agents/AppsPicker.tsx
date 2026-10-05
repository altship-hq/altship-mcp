import { useEffect, useRef, useState } from "react";
import { connectApp, disconnectApp, listApps, type AppInfo } from "./api.js";

/**
 * The connected-apps part of the tool picker: third-party apps (Gmail,
 * Slack, ...) the agent can use on the user's behalf. An app has to be
 * connected (the user signs in to it, in a new tab) before it can be ticked.
 * Renders nothing when connected apps aren't set up on this altship.
 */
export default function AppsPicker({ picked, onToggle }: { picked: Set<string>; onToggle: (slug: string, on: boolean) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The app whose sign-in tab is open, so coming back to this tab can tick it.
  const connecting = useRef<string | null>(null);
  const latest = useRef(0);

  async function load(query: string) {
    const request = ++latest.current;
    try {
      const result = await listApps(query);
      if (request !== latest.current) return; // a newer search has started
      setEnabled(result.enabled);
      setApps(result.apps);
      const justConnected = connecting.current;
      if (justConnected && result.apps.some((a) => a.slug === justConnected && a.connected)) {
        connecting.current = null;
        onToggle(justConnected, true);
      }
    } catch (err) {
      if (request === latest.current) setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Search as the user types, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => load(search.trim()), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search]);

  // Signing in happens in another tab: check again when this one is back in front.
  useEffect(() => {
    const onFocus = () => load(search.trim());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [search]);

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
      await load(search.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  if (enabled === false) return null;

  return (
    <>
      <div className="tool-picker-label">Connected apps</div>
      <p className="hint">
        Apps the agent can act in for you, like sending an email or posting a message. Connect one by signing in to it, then tick it
        for this agent.
      </p>
      {error && <div className="notice">{error}</div>}
      <input
        type="search"
        className="apps-search"
        placeholder="Search apps, e.g. Gmail, Slack, Notion"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search apps"
      />
      {enabled === null ? (
        <p className="hint">Loading apps…</p>
      ) : apps.length === 0 ? (
        <p className="hint">No apps match "{search}".</p>
      ) : (
        <div className="tool-picker-group apps-list">
          {apps.map((app) =>
            app.connected ? (
              <label key={app.slug} className="tool-choice">
                <input type="checkbox" checked={picked.has(app.slug)} onChange={(e) => onToggle(app.slug, e.target.checked)} />
                {app.logo && <img src={app.logo} alt="" width="18" height="18" />}
                <span>
                  <strong>{app.name}</strong>
                  <small>
                    Connected ·{" "}
                    <button
                      type="button"
                      className="link"
                      disabled={busy === app.slug}
                      onClick={(e) => {
                        e.preventDefault();
                        disconnect(app);
                      }}
                    >
                      Disconnect
                    </button>
                  </small>
                </span>
              </label>
            ) : (
              <div key={app.slug} className="tool-choice app-unconnected">
                {app.logo && <img src={app.logo} alt="" width="18" height="18" />}
                <span>
                  <strong>{app.name}</strong>
                  <small>Not connected</small>
                </span>
                <button type="button" className="secondary" disabled={busy === app.slug} onClick={() => connect(app)}>
                  {busy === app.slug ? "Opening…" : "Connect"}
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </>
  );
}
