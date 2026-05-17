"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "../i18n";

type AutoLintRuntime = {
  counter: {
    value: number;
    threshold: number;
    suggested: boolean;
  };
};

type AutoLintEvent =
  | { type: "state"; state: AutoLintRuntime }
  | { type: "suggestion"; count: number; threshold: number }
  | { type: "start" | "done" | "skipped" };

/**
 * Slim hint above the Composer that surfaces "lint recommended" when the
 * counter trigger has fired. Hidden whenever the counter is below threshold
 * or auto-lint is disabled. Clicking the button POSTs to
 * `/api/auto-lint/run-now` and lets the manager run the lint cycle.
 */
export default function AutoLintHint() {
  const { t } = useLanguage();
  const [count, setCount] = useState(0);
  const [suggested, setSuggested] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/auto-lint/events");
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AutoLintEvent;
        if (event.type === "state") {
          setCount(event.state.counter.value);
          setSuggested(event.state.counter.suggested);
        } else if (event.type === "suggestion") {
          setCount(event.count);
          setSuggested(true);
        }
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      // browser auto-reconnects
    };
    return () => es.close();
  }, []);

  async function runNow() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auto-lint/run-now", { method: "POST" });
    } finally {
      setBusy(false);
    }
  }

  if (!suggested) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/30 px-4 py-1 text-[11px] text-amber-200">
      <span>{t.settings.autoLintSuggestionHint(count)}</span>
      <button
        type="button"
        onClick={() => void runNow()}
        disabled={busy}
        className="rounded border border-amber-700/60 bg-amber-900/40 px-2 py-0.5 text-[11px] font-medium text-amber-100 hover:bg-amber-900/60 disabled:opacity-50"
      >
        {busy ? t.settings.autoLintRunningNow : t.settings.autoLintRunSuggested}
      </button>
    </div>
  );
}
