import { useEffect, useState, type FormEvent } from "react";
import { navigate } from "../../router.js";
import { ConfirmDialog } from "../../ui.js";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type AgentRecord,
  type AgentSchedule,
  type ScheduleFrequency,
  type ScheduleList,
} from "./api.js";

// An agent's Schedule tab: run it at set times with the same request each
// time. The runs appear under Runs like any other.

const FREQUENCIES: { id: ScheduleFrequency; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays (Mon to Fri)" },
  { id: "weekly", label: "Once a week" },
  { id: "hourly", label: "Every hour" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Every timezone the browser knows, with the user's own first; just theirs and UTC on a browser that can't list them. */
function timezones(own: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([own, "UTC", ...all])];
}

function formatWhen(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone });
}

export default function Schedule({ agent }: { agent: AgentRecord }) {
  const [list, setList] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentSchedule | null>(null);

  const [frequency, setFrequency] = useState<ScheduleFrequency>("daily");
  const [time, setTime] = useState("08:00");
  const [weekday, setWeekday] = useState(1);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [prompt, setPrompt] = useState("");
  const [emailResults, setEmailResults] = useState(false);

  const load = () =>
    listSchedules(agent.id)
      .then(setList)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    load();
  }, [agent.id]);

  /** Runs one change, then shows the list as it now is. */
  async function act(key: string, change: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await change();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    act("add", async () => {
      await createSchedule(agent.id, { frequency, time, weekday, timezone, prompt: prompt.trim(), emailResults });
      setPrompt("");
    });
  }

  // Tools set to "ask" pause a run until its owner answers, whoever started it.
  const asks = agent.plan.agents.some((a) => [...a.tools, ...(a.builtinTools ?? [])].some((t) => t.permission === "ask"));
  const full = list !== null && list.used >= list.limit;

  return (
    <div className="schedule-tab">
      {error && <div className="notice">{error}</div>}

      {list === null ? (
        !error && <div className="empty">Loading…</div>
      ) : list.schedules.length === 0 ? (
        <p className="agent-summary">This agent only runs when it's asked. Add a schedule to have it run by itself.</p>
      ) : (
        <ul className="schedule-list">
          {list.schedules.map((s) => (
            <li key={s.id} className={s.status === "paused" ? "is-paused" : ""}>
              <div className="schedule-main">
                <strong>{s.label}</strong>
                <span className="schedule-zone">{s.timezone}</span>
                <p>{s.prompt}</p>
                <span className="schedule-next">
                  {s.status === "paused" ? "Paused" : s.nextRunAt ? `Next run: ${formatWhen(s.nextRunAt, s.timezone)}` : "Next run: not known yet"}
                  {list.emails && s.emailResults ? " · Emails you the result" : ""}
                </span>
              </div>
              <div className="schedule-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(`run:${s.id}`);
                    setError(null);
                    try {
                      const { sessionId } = await runScheduleNow(agent.id, s.id);
                      navigate(`agents/${agent.id}?session=${encodeURIComponent(sessionId)}`);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                      setBusy(null);
                    }
                  }}
                >
                  {busy === `run:${s.id}` ? "Starting…" : "Run now"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  onClick={() => act(`pause:${s.id}`, () => updateSchedule(agent.id, s.id, { paused: s.status === "active" }))}
                >
                  {s.status === "active" ? "Pause" : "Resume"}
                </button>
                <button type="button" className="link-danger" disabled={busy !== null} onClick={() => setDeleting(s)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {list !== null && (
        <form className="agent-form schedule-form" onSubmit={add}>
          <h2>Add a schedule</h2>
          <div className="schedule-when">
            <div>
              <label htmlFor="schedule-frequency">How often</label>
              <select id="schedule-frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}>
                {FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            {frequency === "weekly" && (
              <div>
                <label htmlFor="schedule-weekday">On</label>
                <select id="schedule-weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((day, i) => (
                    <option key={day} value={i}>
                      {day}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="schedule-time">{frequency === "hourly" ? "Starting at (the minutes are used)" : "At"}</label>
              <input id="schedule-time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div>
              <label htmlFor="schedule-timezone">Timezone</label>
              <select id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones(timezone).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label htmlFor="schedule-prompt">What should it do each time?</label>
          <textarea
            id="schedule-prompt"
            rows={4}
            maxLength={4000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={agent.plan.testPrompts[0] ?? "Go through my unread email and tell me what needs a reply today."}
          />

          {list.emails ? (
            <label className="schedule-check">
              <input type="checkbox" checked={emailResults} onChange={(e) => setEmailResults(e.target.checked)} />
              <span>Email me the result each time. You're always emailed if a run fails{asks ? " or is waiting for your approval" : ""}.</span>
            </label>
          ) : (
            <p className="hint">Results appear under Runs. Email notifications aren't set up on this altship yet.</p>
          )}
          {asks && (
            <p className="hint">
              This agent asks before some of its actions. A scheduled run will pause at those and wait until you approve it
              {list.emails ? "; you'll get an email with a link." : " under Runs."}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy !== null || full || !prompt.trim() || !time}>
              {busy === "add" ? "Adding…" : "Add schedule"}
            </button>
            <span className="hint">
              {full
                ? `Your plan allows ${list.limit} schedule${list.limit === 1 ? "" : "s"}. Delete one to add another.`
                : `${list.used} of ${list.limit} schedules used. Runs can start a few minutes after the set time.`}
            </span>
          </div>
        </form>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this schedule?"
          confirmLabel="Delete schedule"
          busy={busy === "delete"}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await act("delete", () => deleteSchedule(agent.id, deleting.id));
            setDeleting(null);
          }}
        >
          <p>
            <strong>{deleting.label}</strong> will stop running. Runs it has already made stay in the run log.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
