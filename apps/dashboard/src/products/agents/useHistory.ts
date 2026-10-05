import { useCallback, useRef, useState } from "react";

// Undo and redo for a value that's edited in many small steps (the agent plan
// on the flow canvas). Each change becomes a step to go back to, except that
// a run of quick edits of the same kind (typing in a field) counts as one.

/** Edits closer together than this can be merged into one undo step. */
const MERGE_WINDOW_MS = 800;
const MAX_STEPS = 100;

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function useHistory<T>(initial: T) {
  const [history, setHistory] = useState<History<T>>({ past: [], present: initial, future: [] });
  const lastChange = useRef(0);

  /**
   * Records a change. With `canMerge`, a change made right after the last one
   * replaces it rather than adding an undo step, when `canMerge` says the two
   * are the same kind of edit.
   */
  const set = useCallback((next: T, canMerge?: (previous: T, next: T) => boolean) => {
    const now = Date.now();
    const quick = now - lastChange.current < MERGE_WINDOW_MS;
    lastChange.current = now;
    setHistory((h) =>
      quick && h.past.length > 0 && canMerge?.(h.present, next)
        ? { ...h, present: next, future: [] }
        : { past: [...h.past, h.present].slice(-MAX_STEPS), present: next, future: [] },
    );
  }, []);

  /** Starts over from a new value, with nothing to undo. */
  const reset = useCallback((value: T) => {
    lastChange.current = 0;
    setHistory({ past: [], present: value, future: [] });
  }, []);

  const undo = useCallback(() => {
    lastChange.current = 0;
    setHistory((h) => (h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }));
  }, []);

  const redo = useCallback(() => {
    lastChange.current = 0;
    setHistory((h) => (h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }));
  }, []);

  return { value: history.present, set, reset, undo, redo, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}
