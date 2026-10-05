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
 * A modal that asks before something that can't be undone. Opens with focus
 * on Cancel, so Enter never deletes by accident; Escape and a click outside
 * also cancel.
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

  useEffect(() => {
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{title}</h2>
        <div id="confirm-body" className="modal-body">
          {children}
        </div>
        <div className="modal-actions">
          <button type="button" className="modal-cancel" ref={cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="modal-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
