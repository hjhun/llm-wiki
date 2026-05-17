"use client";

import { useEffect, useState } from "react";

type AutoLintRuntime = {
  counter: { suggested: boolean };
};

type AutoLintEvent =
  | { type: "state"; state: AutoLintRuntime }
  | { type: "suggestion"; count: number; threshold: number }
  | { type: "start" | "done" | "skipped" };

/**
 * Tiny dot rendered next to the Settings tab in the sidebar when the
 * auto-lint counter has crossed its threshold. Driven entirely by the
 * `/api/auto-lint/events` SSE stream so it stays in sync with the panel
 * and the chat hint without polling.
 */
export default function AutoLintBadge({
  className,
}: {
  className?: string;
}) {
  const [suggested, setSuggested] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/auto-lint/events");
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AutoLintEvent;
        if (event.type === "state") {
          setSuggested(event.state.counter.suggested);
        } else if (event.type === "suggestion") {
          setSuggested(true);
        } else if (event.type === "done") {
          // The counter resets via state event shortly after done — keep
          // showing the dot until that arrives.
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      // browser auto-reconnects
    };
    return () => es.close();
  }, []);

  if (!suggested) return null;
  return (
    <span
      title="lint 추천: ingest 누적 임계값 도달"
      className={[
        "inline-block h-2 w-2 rounded-full bg-amber-400",
        className ?? "",
      ].join(" ")}
    />
  );
}
