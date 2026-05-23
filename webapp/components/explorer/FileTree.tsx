"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Link2Off } from "lucide-react";
import { useLanguage } from "../i18n";
import type { Entry, ExplorerAction, WsKey } from "./types";

type Node = Entry & { children?: Node[]; open?: boolean; loading?: boolean };

async function fetchList(ws: WsKey, p: string): Promise<Entry[]> {
  const u = new URL("/api/files/list", window.location.origin);
  u.searchParams.set("ws", ws);
  u.searchParams.set("path", p);
  const res = await fetch(u);
  if (!res.ok) throw new Error(await res.text());
  const j = (await res.json()) as { entries: Entry[] };
  return j.entries;
}

function patchNode(
  list: Node[],
  target: string,
  patch: Partial<Node>,
): Node[] {
  return list.map((n) => {
    if (n.path === target) return { ...n, ...patch };
    if (n.children) {
      return { ...n, children: patchNode(n.children, target, patch) };
    }
    return n;
  });
}

function findNode(list: Node[], target: string): Node | null {
  for (const n of list) {
    if (n.path === target) return n;
    if (n.children) {
      const found = findNode(n.children, target);
      if (found) return found;
    }
  }
  return null;
}

export default function FileTree({
  ws,
  selectedPath,
  focusPath,
  refreshKey,
  onSelect,
  onContextAction,
  readOnly,
}: {
  ws: WsKey;
  selectedPath: string | null;
  focusPath?: string | null;
  refreshKey: number;
  onSelect: (entry: Entry) => void;
  onContextAction: (action: ExplorerAction, target: Entry | null) => void;
  readOnly: boolean;
}) {
  const { t } = useLanguage();
  const [roots, setRoots] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    entry: Entry;
    x: number;
    y: number;
  } | null>(null);
  const [lastFocused, setLastFocused] = useState<string | null>(null);

  const loadChildren = useCallback(
    async (parentPath: string): Promise<Node[]> => {
      const entries = await fetchList(ws, parentPath);
      return entries.map((e) => ({ ...e, children: undefined, open: false }));
    },
    [ws],
  );

  // 워크스페이스/리프레시 변경 시 루트 재로드
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const top = await loadChildren("");
        if (!cancelled) setRoots(top);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws, refreshKey, loadChildren]);

  useEffect(() => {
    if (!focusPath || roots.length === 0) return;
    const focusKey = `${ws}:${refreshKey}:${focusPath}`;
    if (lastFocused === focusKey) return;

    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const parts = focusPath.split("/").filter(Boolean);
        let tree = roots;
        let parent = "";
        let target: Node | null = null;

        for (let i = 0; i < parts.length; i += 1) {
          const current = parent ? `${parent}/${parts[i]}` : parts[i];
          const node = findNode(tree, current);
          if (!node) throw new Error(t.explorer.pathNotFound(focusPath));

          if (i === parts.length - 1 || node.kind === "file") {
            target = node;
            break;
          }

          const children = node.children ?? (await loadChildren(node.path));
          tree = patchNode(tree, node.path, {
            children,
            open: true,
            loading: false,
          });
          parent = current;
        }

        if (!cancelled) {
          setRoots(tree);
          if (target) onSelect(target);
          setLastFocused(focusKey);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLastFocused(focusKey);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    focusPath,
    lastFocused,
    loadChildren,
    onSelect,
    refreshKey,
    roots,
    t.explorer,
    ws,
  ]);

  useEffect(() => {
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function toggleDir(n: Node) {
    if (n.kind !== "dir") return;
    if (n.open) {
      setRoots((curr) => patchNode(curr, n.path, { open: false }));
      return;
    }
    if (!n.children) {
      setRoots((curr) => patchNode(curr, n.path, { loading: true }));
      try {
        const kids = await loadChildren(n.path);
        setRoots((curr) =>
          patchNode(curr, n.path, {
            children: kids,
            open: true,
            loading: false,
          }),
        );
      } catch (err) {
        setRoots((curr) => patchNode(curr, n.path, { loading: false }));
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      setRoots((curr) => patchNode(curr, n.path, { open: true }));
    }
  }

  function renderRow(n: Node, depth: number): React.ReactNode {
    const isSelected = selectedPath === n.path;
    const indent = { paddingLeft: 8 + depth * 14 };
    return (
      <div key={n.path}>
        <button
          type="button"
          onClick={() => {
            if (n.kind === "dir") toggleDir(n);
            onSelect(n);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ entry: n, x: e.clientX, y: e.clientY });
          }}
          className={[
            "flex w-full items-center gap-1 py-0.5 text-left text-[12.5px] hover:bg-bg-panel/70",
            isSelected ? "bg-bg-panel text-ink" : "text-ink-dim",
          ].join(" ")}
          style={indent}
        >
          <span className="w-3 text-ink-faint">
            {n.kind === "dir" ? (n.open ? "▾" : "▸") : " "}
          </span>
          <span
            className={["truncate", n.broken ? "text-red-300" : ""].join(" ")}
          >
            {n.name}
          </span>
          {n.isSymlink ? (
            n.broken ? (
              <Link2Off
                aria-label="broken symlink"
                className="h-3 w-3 shrink-0 text-red-300"
              />
            ) : (
              <Link2
                aria-label="symlink"
                className="h-3 w-3 shrink-0 text-ink-faint"
              />
            )
          ) : null}
          {n.loading ? <span className="text-[10px] text-ink-faint">…</span> : null}
        </button>
        {n.open && n.children
          ? n.children.map((c) => renderRow(c, depth + 1))
          : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {ws}/
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onContextAction("new-file", null)}
            disabled={readOnly}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            title={t.explorer.newRootFile}
          >
            {t.explorer.fileButton}
          </button>
          <button
            type="button"
            onClick={() => onContextAction("new-dir", null)}
            disabled={readOnly}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            title={t.explorer.newRootFolder}
          >
            {t.explorer.folderButton}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>
        ) : roots.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-ink-faint">
            {t.explorer.empty}
          </div>
        ) : (
          roots.map((n) => renderRow(n, 0))
        )}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          readOnly={readOnly}
          onAction={(action) => {
            setMenu(null);
            onContextAction(action, menu.entry);
          }}
        />
      ) : null}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  entry,
  readOnly,
  onAction,
}: {
  x: number;
  y: number;
  entry: Entry;
  readOnly: boolean;
  onAction: (action: ExplorerAction) => void;
}) {
  const { t } = useLanguage();
  const actions: { action: ExplorerAction; label: string }[] = [
    { action: "new-file", label: t.explorer.actions.newFile },
    { action: "new-dir", label: t.explorer.actions.newFolder },
    { action: "upload-file", label: t.explorer.actions.uploadFile },
    { action: "upload-dir", label: t.explorer.actions.uploadFolder },
    { action: "rename", label: t.explorer.actions.rename },
    { action: "delete", label: t.explorer.actions.delete },
  ];

  return (
    <div
      className="fixed z-40 w-44 overflow-hidden rounded border border-line bg-bg-subtle py-1 shadow-2xl"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="border-b border-line px-2 py-1.5">
        <div className="truncate font-mono text-[10px] text-ink-faint">
          {entry.path}
        </div>
      </div>
      {actions.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          disabled={readOnly}
          onClick={() => onAction(action)}
          className="block w-full px-2.5 py-1.5 text-left text-xs text-ink-dim hover:bg-bg-panel hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
