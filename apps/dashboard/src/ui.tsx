import { useEffect, useRef, useState, type ReactNode } from "react";

// Building blocks shared by every product's pages.

export function PageHead({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

/**
 * A dialog over the page: a dimmed backdrop and a panel with a title.
 * Escape and a click outside close it, unless `locked` (while something in
 * it is in progress).
 */
export function Modal({
  title,
  children,
  onClose,
  locked = false,
  wide = false,
  alert = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  locked?: boolean;
  /** A larger panel, for content to browse rather than a question to answer. */
  wide?: boolean;
  /** Announced as an alert: for a question about something that can't be undone. */
  alert?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div className={wide ? "modal modal-wide" : "modal"} role={alert ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/**
 * A modal that asks before something that can't be undone. Opens with focus
 * on Cancel, so Enter never deletes by accident.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);

  return (
    <Modal title={title} onClose={onCancel} locked={busy} alert>
      <div className="modal-body">{children}</div>
      <div className="modal-actions">
        <button type="button" className="modal-cancel" ref={cancel} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="modal-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// Pictures shown while something slow runs, ending on the altship mark.
// Decoration only: swap the files in public/loading to change them.
const LOADING_IMAGES = ["/loading/1.jpg", "/loading/2.jpg", "/loading/3.jpg", "/loading/4.jpg"];

/**
 * Covers the page while something slow runs (designing an agent, deploying a
 * server). `steps` say what's happening, in order. Pass `step` when the page
 * knows which one it's on; otherwise they advance every `pace` ms and hold on
 * the last, since the work is one request with no progress to report. Stays
 * hidden for the first moment, so quick work doesn't flash it.
 */
export function LoadingOverlay({
  kicker,
  title,
  steps,
  step,
  pace = 5000,
  note = "This can take up to a minute",
}: {
  /** The small line above the pictures, e.g. "altship agents". */
  kicker: string;
  title: string;
  steps: string[];
  step?: number;
  pace?: number;
  note?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [timed, setTimed] = useState(0);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const show = window.setTimeout(() => setVisible(true), 400);
    const frames = window.setInterval(() => setFrame((f) => (f + 1) % LOADING_IMAGES.length), 1800);
    return () => {
      window.clearTimeout(show);
      window.clearInterval(frames);
    };
  }, []);

  useEffect(() => {
    if (step !== undefined) return;
    const advance = window.setInterval(() => setTimed((i) => Math.min(i + 1, steps.length - 1)), pace);
    return () => window.clearInterval(advance);
  }, [step, steps.length, pace]);

  if (!visible) return null;
  const current = Math.min(step ?? timed, steps.length - 1);
  // Never full: the bar shows where the work is, not that it's done.
  const progress = Math.round(((current + 0.5) / steps.length) * 100);
  const count = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-content">
        <div className="loading-kicker">{kicker}</div>
        <div className="loading-images" aria-hidden="true">
          {LOADING_IMAGES.map((src, i) => (
            <div key={src} className={i === frame ? "loading-frame is-active" : "loading-frame"}>
              <img src={src} alt="" />
            </div>
          ))}
        </div>
        <h2>{title}</h2>
        <p className="loading-status">{steps[current]}…</p>
        <div className="loading-track">
          <div className="loading-progress" style={{ width: `${progress}%` }} />
        </div>
        <div className="loading-meta">
          <span>
            {count(current + 1)} / {count(steps.length)}
          </span>
          <span>{note}</span>
        </div>
      </div>
    </div>
  );
}
