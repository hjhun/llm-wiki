"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckSquare, MessageSquarePlus, Trash2 } from "lucide-react";
import AgentMascot from "../agent-panel/AgentMascot";
import { useLanguage } from "../i18n";
import { Button, EmptyState, cx } from "../ui";
import type { SessionRef } from "./types";

export default function SessionList({
  sessions,
  activePath,
  onSelect,
  onNew,
  onDelete,
  deleting,
  running,
}: {
  sessions: SessionRef[];
  activePath: string | null;
  onSelect: (s: SessionRef) => void;
  onNew: () => void;
  onDelete: (paths: string[]) => void;
  deleting: boolean;
  running: boolean;
}) {
  const { t, formatDateTime } = useLanguage();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectedCount = selected.size;
  const allSelected = sessions.length > 0 && selectedCount === sessions.length;

  const visiblePaths = useMemo(
    () => new Set(sessions.map((session) => session.path)),
    [sessions],
  );

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((path) => visiblePaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [visiblePaths]);

  function toggleOne(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.path)));
  }

  function deleteSelected() {
    if (selectedCount === 0 || deleting) return;
    onDelete([...selected]);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-line bg-bg-panel/52 p-3">
        <Button
          onClick={onNew}
          variant="primary"
          icon={MessageSquarePlus}
          className="h-9 w-full"
        >
          {t.chat.newChat}
        </Button>
        <div className="mt-2">
          <AgentMascot running={running} />
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <Button
            onClick={toggleAll}
            disabled={sessions.length === 0 || deleting}
            variant="secondary"
            icon={CheckSquare}
            className="h-7 text-[11px]"
          >
            {allSelected ? t.chat.clear : t.chat.selectAll}
          </Button>
          <Button
            onClick={deleteSelected}
            disabled={selectedCount === 0 || deleting}
            variant="danger"
            icon={Trash2}
            className="h-7 px-2 text-[11px]"
          >
            {deleting
              ? t.chat.deleting
              : `${t.chat.delete} ${selectedCount || ""}`}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {sessions.length === 0 ? (
          <EmptyState
            title={t.chat.noSessions}
            description={t.chat.guideSessions}
            className="m-2 min-h-32 px-3 py-5"
          />
        ) : (
          sessions.map((s) => {
            const active = activePath === s.path;
            return (
              <div
                key={s.path}
                className={cx(
                  "mb-1 grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md border px-3 py-2.5 text-left text-xs transition-colors",
                  active
                    ? "border-accent/42 bg-[linear-gradient(90deg,rgb(var(--color-accent)_/_0.15),rgb(var(--color-bg-panel)_/_0.88))] text-ink shadow-[inset_3px_0_0_rgb(var(--color-accent)),0_10px_22px_rgb(0_0_0_/_0.12)]"
                    : "border-transparent text-ink-dim hover:border-line/80 hover:bg-bg-panel/62 hover:text-ink",
                )}
              >
                <span className="pt-0.5">
                  <input
                    type="checkbox"
                    checked={selected.has(s.path)}
                    onChange={() => toggleOne(s.path)}
                    aria-label={t.chat.selectSession(s.meta.title)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  className="min-w-0 text-left"
                >
                  <span className="block truncate font-medium">
                    {s.meta.title}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {s.meta.agent ?? "—"} ·{" "}
                    {formatDateTime(s.meta.updated)}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
