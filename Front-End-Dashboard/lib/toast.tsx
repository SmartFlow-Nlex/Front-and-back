"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * Transient confirmations for actions that used to succeed silently.
 *
 * Scheduling maintenance or changing a status closed its modal and left the
 * operator to infer from the table that anything had happened. A toast states
 * the outcome in words, which matters most when the visible result is subtle —
 * a status pill changing shade two rows down is easy to miss.
 *
 * Errors are deliberately NOT auto-dismissed. A confirmation that vanishes is
 * fine; a failure that vanishes before it is read is how a silent data loss
 * gets missed. Those stay until dismissed.
 */

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional second line for detail, e.g. the server's reason for a failure. */
  detail?: string;
};

type ToastContextValue = {
  toasts: Toast[];
  /** Returns the id, so a caller can dismiss it early if it wants. */
  show: (kind: ToastKind, message: string, detail?: string) => number;
  success: (message: string, detail?: string) => number;
  error: (message: string, detail?: string) => number;
  info: (message: string, detail?: string) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** Success and info clear themselves; errors do not (see file comment). */
const AUTO_DISMISS_MS: Record<ToastKind, number | null> = {
  success: 4000,
  info: 5000,
  error: null,
};

/** Beyond this the stack becomes its own wall of noise; oldest are dropped. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, kind, message, detail }].slice(-MAX_VISIBLE));
      const ms = AUTO_DISMISS_MS[kind];
      if (ms != null) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            setToasts((cur) => cur.filter((x) => x.id !== id));
          }, ms),
        );
      }
      return id;
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      show,
      dismiss,
      success: (m, d) => show("success", m, d),
      error: (m, d) => show("error", m, d),
      info: (m, d) => show("info", m, d),
    }),
    [toasts, show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const ICON: Record<ToastKind, string> = { success: "✓", error: "!", info: "i" };

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="ds-toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`ds-toast ds-toast-${t.kind}`}
          // Failures interrupt; confirmations wait their turn in the queue.
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="ds-toast-icon" aria-hidden="true">
            {ICON[t.kind]}
          </span>
          <div className="ds-toast-body">
            <p className="ds-toast-message">{t.message}</p>
            {t.detail && <p className="ds-toast-detail">{t.detail}</p>}
          </div>
          <button
            type="button"
            className="ds-toast-close"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // A stray consumer outside the provider should not crash the page; it just
    // loses its notifications.
    const noop = () => 0;
    return { toasts: [], show: noop, success: noop, error: noop, info: noop, dismiss: () => {} };
  }
  return ctx;
}
