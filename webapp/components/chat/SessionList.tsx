"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckSquare, MessageSquarePlus, Trash2 } from "lucide-react";
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
}: {
  sessions: SessionRef[];
  activePath: string | null;
  onSelect: (s: SessionRef) => void;
  onNew: () => void;
  onDelete: (paths: string[]) => void;
  deleting: boolean;
}) {
  const { t } = useLanguage();
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
      <div className="border-b border-line p-2">
        <Button
          onClick={onNew}
          variant="primary"
          icon={MessageSquarePlus}
          className="w-full"
        >
          {t.chat.newChat}
        </Button>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
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
      <div className="min-h-0 flex-1 overflow-auto py-1">
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
                  "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-2 text-left text-xs transition-colors",
                  active
                    ? "bg-bg-panel text-ink shadow-[inset_3px_0_0_rgb(var(--color-accent))]"
                    : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
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
                    {new Date(s.meta.updated).toLocaleString()}
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
