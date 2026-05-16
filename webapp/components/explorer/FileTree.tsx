"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../i18n";
import type { Entry, WsKey } from "./types";

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

export default function FileTree({
  ws,
  selectedPath,
  refreshKey,
  onSelect,
  onContextAction,
}: {
  ws: WsKey;
  selectedPath: string | null;
  refreshKey: number;
  onSelect: (entry: Entry) => void;
  onContextAction: (action: "new-file" | "new-dir" | "delete" | "rename", target: Entry | null) => void;
}) {
  const { t } = useLanguage();
  const [roots, setRoots] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);

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
            const action = window.prompt(t.explorer.contextAction(n.path), "");
            if (action === "new-file" || action === "new-dir" || action === "rename" || action === "delete") {
              onContextAction(action, n);
            }
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
          <span className="truncate">{n.name}</span>
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
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink"
            title={t.explorer.newRootFile}
          >
            {t.explorer.fileButton}
          </button>
          <button
            type="button"
            onClick={() => onContextAction("new-dir", null)}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink"
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
    </div>
  );
}
