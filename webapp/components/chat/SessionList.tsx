"use client";

import type { SessionRef } from "./types";

export default function SessionList({
  sessions,
  activePath,
  onSelect,
  onNew,
}: {
  sessions: SessionRef[];
  activePath: string | null;
  onSelect: (s: SessionRef) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-line p-2">
        <button
          type="button"
          onClick={onNew}
          className="w-full rounded-md bg-accent px-3 py-2 text-xs font-medium text-bg hover:opacity-90"
        >
          + New Chat
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-ink-faint">
            아직 세션이 없습니다.
          </div>
        ) : (
          sessions.map((s) => {
            const active = activePath === s.path;
            return (
              <button
                key={s.path}
                type="button"
                onClick={() => onSelect(s)}
                className={[
                  "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors",
                  active
                    ? "bg-bg-panel text-ink"
                    : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
                ].join(" ")}
              >
                <span className="truncate font-medium">{s.meta.title}</span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {s.meta.agent ?? "—"} ·{" "}
                  {new Date(s.meta.updated).toLocaleString()}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
