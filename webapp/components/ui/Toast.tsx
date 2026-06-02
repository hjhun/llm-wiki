"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cx } from "../ui";

export type ToastTone = "success" | "error" | "info";

type ToastItem = { id: number; tone: ToastTone; message: string };

type ToastContextValue = {
  notify: (message: string, tone?: ToastTone) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

/**
 * Access the toast notifier. Falls back to a no-op outside a ToastProvider so
 * shared components (e.g. used in the public Clio view) never crash.
 */
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? { notify: () => {} };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = (idRef.current += 1);
      setItems((prev) => [...prev, { id, tone, message }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const TONE_ICON = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-success/45 text-success",
  error: "border-danger/45 text-danger",
  info: "border-info/45 text-info",
};

function Toaster({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {items.map((item) => {
        const Icon = TONE_ICON[item.tone];
        return (
          <div
            key={item.id}
            role="status"
            className={cx(
              "toast-enter pointer-events-auto flex items-start gap-2 rounded-md border bg-bg-panel/95 px-3 py-2.5 text-sm shadow-[0_18px_46px_rgb(0_0_0_/_0.28)] backdrop-blur-xl",
              TONE_CLASS[item.tone],
            )}
          >
            <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 text-ink">{item.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              className="shrink-0 text-ink-faint transition hover:text-ink"
              aria-label="Dismiss"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
