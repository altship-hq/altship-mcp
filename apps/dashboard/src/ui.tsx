import { useEffect, useRef, type ReactNode } from "react";

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
