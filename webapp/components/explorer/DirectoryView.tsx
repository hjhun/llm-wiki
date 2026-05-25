"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Download,
  File,
  Folder,
  FolderUp,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { useLanguage } from "../i18n";
import { Button, IconButton, cx } from "../ui";
import type { Entry, ExplorerAction, WsKey } from "./types";

type SortKey = "name" | "kind" | "size" | "mtime";
type SortDir = "asc" | "desc";

async function fetchList(ws: WsKey, p: string): Promise<Entry[]> {
  const u = new URL("/api/files/list", window.location.origin);
  u.searchParams.set("ws", ws);
  u.searchParams.set("path", p);
  const res = await fetch(u);
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? (await res.text()));
  }
  const j = (await res.json()) as { entries: Entry[] };
  return j.entries;
}

function isTrashPath(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

function blobHref(ws: WsKey, path: string): string {
  const params = new URLSearchParams({ ws, path });
  return `/api/files/blob?${params.toString()}`;
}

export default function DirectoryView({
  ws,
  entry,
  refreshKey,
  readOnly,
  busy,
  onSelect,
  onClearSelection,
  onContextAction,
}: {
  ws: WsKey;
  entry: Entry | null;
  refreshKey: number;
  readOnly: boolean;
  busy: boolean;
  onSelect: (entry: Entry) => void;
  onClearSelection: () => void;
  onContextAction: (action: ExplorerAction, target: Entry | null) => void;
}) {
  const { t } = useLanguage();
  const currentPath = entry?.kind === "dir" ? entry.path : "";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const next = await fetchList(ws, currentPath);
        if (!cancelled) setEntries(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath, refreshKey, ws]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = needle
      ? entries.filter((item) => item.name.toLowerCase().includes(needle))
      : entries;
    return [...base].sort((a, b) => compareEntry(a, b, sortKey, sortDir));
  }, [entries, query, sortDir, sortKey]);

  function changeSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((curr) => (curr === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(nextKey);
      setSortDir("asc");
    }
  }

  const canEmptyTrash = !readOnly && currentPath === ".trash";

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <Breadcrumb
            ws={ws}
            path={currentPath}
            onRoot={onClearSelection}
            onPath={(path) => onSelect(dirEntryFromPath(path))}
          />
          <div className="mt-1 text-[10px] text-ink-faint">
            {t.explorer.itemCount(entries.length)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => onContextAction("new-file", entry)}
            disabled={readOnly}
            className="h-7 px-2.5 text-[11px]"
          >
            {t.explorer.fileButton}
          </Button>
          <Button
            onClick={() => onContextAction("new-dir", entry)}
            disabled={readOnly}
            className="h-7 px-2.5 text-[11px]"
          >
            {t.explorer.folderButton}
          </Button>
          <Button
            onClick={() => onContextAction("upload-file", entry)}
            disabled={readOnly}
            icon={Upload}
            className="h-7 px-2.5 text-[11px]"
          >
            {t.explorer.upload}
          </Button>
          <Button
            onClick={() => onContextAction("upload-dir", entry)}
            disabled={readOnly}
            icon={FolderUp}
            className="h-7 px-2.5 text-[11px]"
          >
            {t.explorer.uploadFolder}
          </Button>
          {canEmptyTrash ? (
            <Button
              onClick={() => onContextAction("empty-trash", entry)}
              disabled={busy}
              variant="danger"
              icon={Trash2}
              className="h-7 px-2.5 text-[11px]"
            >
              {t.explorer.emptyTrash}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-bg-subtle px-4 py-2">
        <Search aria-hidden className="h-4 w-4 text-ink-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.explorer.searchPlaceholder}
          className="h-8 min-w-0 flex-1 rounded border border-line bg-bg px-3 text-xs text-ink outline-none focus:border-accent"
        />
      </div>

      {error ? (
        <div className="border-b border-danger/50 bg-danger/10 px-4 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-line bg-bg-panel text-[10px] uppercase tracking-wide text-ink-faint">
            <tr>
              <HeaderCell
                label={t.explorer.columns.name}
                active={sortKey === "name"}
                dir={sortDir}
                className="w-[45%]"
                onClick={() => changeSort("name")}
              />
              <HeaderCell
                label={t.explorer.columns.type}
                active={sortKey === "kind"}
                dir={sortDir}
                className="w-[16%]"
                onClick={() => changeSort("kind")}
              />
              <HeaderCell
                label={t.explorer.columns.size}
                active={sortKey === "size"}
                dir={sortDir}
                className="w-[14%]"
                onClick={() => changeSort("size")}
              />
              <HeaderCell
                label={t.explorer.columns.modified}
                active={sortKey === "mtime"}
                dir={sortDir}
                className="w-[17%]"
                onClick={() => changeSort("mtime")}
              />
              <th className="w-[8%] px-2 py-2 text-right">{t.explorer.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-faint">
                  {t.common.loading}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-faint">
                  {entries.length === 0 ? t.explorer.emptyFolder : t.explorer.noMatches}
                </td>
              </tr>
            ) : (
              filtered.map((item) => (
                <tr
                  key={item.path}
                  onClick={() => onSelect(item)}
                  onDoubleClick={() => onSelect(item)}
                  className={cx(
                    "group cursor-default border-b border-line/70 text-ink-dim hover:bg-bg-panel/70 hover:text-ink",
                    item.broken ? "text-danger" : "",
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.kind === "dir" ? (
                        <Folder aria-hidden className="h-4 w-4 shrink-0 text-info" />
                      ) : (
                        <File aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                      )}
                      <span className="truncate font-mono text-[12px]">{item.name}</span>
                      {item.path === ".trash" ? (
                        <span className="rounded border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger">
                          {t.explorer.trashLabel}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-ink-faint">
                    {item.kind === "dir" ? t.explorer.folderKind : fileKind(item.name)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-faint">
                    {item.kind === "dir" ? "-" : formatBytes(item.size)}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-[11px] text-ink-faint">
                    {new Date(item.mtime).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {item.kind === "file" ? (
                        <a
                          href={blobHref(ws, item.path)}
                          download={item.name}
                          onClick={(event) => event.stopPropagation()}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-bg-panel text-ink-dim transition-colors hover:text-ink"
                          title={t.common.download}
                        >
                          <Download aria-hidden className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                      <IconButton
                        icon={Pencil}
                        label={t.explorer.actions.rename}
                        disabled={readOnly || item.path === ".trash"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onContextAction("rename", item);
                        }}
                        className="h-7 w-7"
                      />
                      <IconButton
                        icon={Trash2}
                        label={t.explorer.actions.delete}
                        variant="danger"
                        disabled={readOnly || item.path === ".trash"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onContextAction("delete", item);
                        }}
                        className="h-7 w-7"
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isTrashPath(currentPath) ? (
        <div className="shrink-0 border-t border-danger/30 bg-danger/10 px-4 py-2 text-[11px] text-danger">
          {t.explorer.trashWarning}
        </div>
      ) : null}
    </div>
  );
}

function HeaderCell({
  label,
  active,
  dir,
  className,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  className: string;
  onClick: () => void;
}) {
  return (
    <th className={cx("px-3 py-2", className)}>
      <button
        type="button"
        onClick={onClick}
        className={cx(
          "inline-flex items-center gap-1 transition-colors hover:text-ink",
          active ? "text-ink-dim" : "",
        )}
      >
        {label}
        <span className="text-[9px]">{active ? (dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

function Breadcrumb({
  ws,
  path,
  onRoot,
  onPath,
}: {
  ws: WsKey;
  path: string;
  onRoot: () => void;
  onPath: (path: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs">
      <button
        type="button"
        onClick={onRoot}
        className="rounded px-1.5 py-0.5 text-ink-dim hover:bg-bg-panel hover:text-ink"
      >
        {ws}/
      </button>
      {parts.map((part, index) => {
        const segmentPath = parts.slice(0, index + 1).join("/");
        return (
          <span key={segmentPath} className="flex min-w-0 items-center gap-1">
            <span className="text-ink-faint">/</span>
            <button
              type="button"
              onClick={() => onPath(segmentPath)}
              className="max-w-56 truncate rounded px-1.5 py-0.5 text-ink-dim hover:bg-bg-panel hover:text-ink"
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function compareEntry(a: Entry, b: Entry, key: SortKey, dir: SortDir): number {
  let result = 0;
  if (key === "name") result = a.name.localeCompare(b.name);
  if (key === "kind") result = a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
  if (key === "size") result = a.size - b.size || a.name.localeCompare(b.name);
  if (key === "mtime") result = a.mtime - b.mtime || a.name.localeCompare(b.name);
  return dir === "asc" ? result : -result;
}

function dirEntryFromPath(path: string): Entry {
  return {
    name: path.split("/").filter(Boolean).at(-1) ?? "",
    kind: "dir",
    size: 0,
    mtime: Date.now(),
    path,
  };
}

function fileKind(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return ext ? ext.toUpperCase() : "FILE";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024) return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(0)} PB`;
}
