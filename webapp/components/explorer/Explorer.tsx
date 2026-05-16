"use client";

import { useCallback, useState } from "react";
import { useLanguage } from "../i18n";
import Editor from "./Editor";
import FileTree from "./FileTree";
import type { Entry, WsKey } from "./types";

const WS_LIST: { key: WsKey; label: string }[] = [
  { key: "wiki", label: "wiki/" },
  { key: "raw", label: "raw/" },
  { key: "sessions", label: "sessions/" },
];

export default function Explorer() {
  const { t } = useLanguage();
  const [ws, setWs] = useState<WsKey>("wiki");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isReadOnly = ws === "sessions";

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  async function action(
    kind: "new-file" | "new-dir" | "rename" | "delete",
    target: Entry | null,
  ) {
    setError(null);
    if (isReadOnly) {
      setError(t.explorer.readOnlyError);
      return;
    }
    try {
      if (kind === "new-file" || kind === "new-dir") {
        const base = target?.kind === "dir" ? `${target.path}/` : "";
        const name = window.prompt(
          kind === "new-file"
            ? t.explorer.newFilePath
            : t.explorer.newFolderPath,
          base,
        );
        if (!name) return;
        setBusy(kind);
        const res = await fetch("/api/files/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ws,
            path: name,
            kind: kind === "new-file" ? "file" : "dir",
          }),
        });
        if (!res.ok) throw await asError(res);
      } else if (kind === "rename" && target) {
        const next = window.prompt(t.explorer.newPath, target.path);
        if (!next || next === target.path) return;
        setBusy(kind);
        const res = await fetch("/api/files/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, from: target.path, to: next }),
        });
        if (!res.ok) throw await asError(res);
        if (selected?.path === target.path) setSelected(null);
      } else if (kind === "delete" && target) {
        const ok = window.confirm(t.explorer.deleteConfirm(target.path));
        if (!ok) return;
        setBusy(kind);
        const res = await fetch("/api/files/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, path: target.path }),
        });
        if (!res.ok) throw await asError(res);
        if (selected?.path === target.path) setSelected(null);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = input.files;
    if (!files || files.length === 0) return;
    if (isReadOnly) {
      setError(t.explorer.uploadBlocked);
      return;
    }
    const dir =
      selected?.kind === "dir"
        ? selected.path
        : selected?.path
          ? selected.path.split("/").slice(0, -1).join("/")
          : "";
    const fd = new FormData();
    fd.set("ws", ws);
    fd.set("dir", dir);
    for (const f of Array.from(files)) fd.append("files", f);
    setBusy("upload");
    try {
      const res = await fetch("/api/files/upload", { method: "POST", body: fd });
      if (!res.ok) throw await asError(res);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      input.value = "";
    }
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <div className="flex items-center gap-1">
          {WS_LIST.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => {
                setWs(w.key);
                setSelected(null);
              }}
              title={t.explorer.workspaces[w.key]}
              className={[
                "rounded px-2.5 py-1 text-xs",
                ws === w.key
                  ? "bg-bg-panel text-ink"
                  : "text-ink-dim hover:bg-bg-panel/60 hover:text-ink",
              ].join(" ")}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <label
            className={[
              "cursor-pointer rounded border border-line px-2 py-1 hover:bg-bg-panel",
              isReadOnly ? "pointer-events-none opacity-40" : "",
            ].join(" ")}
          >
            {t.explorer.upload}
            <input
              type="file"
              multiple
              className="hidden"
              onChange={onUpload}
              disabled={isReadOnly}
            />
          </label>
          <button
            type="button"
            onClick={refresh}
            className="rounded border border-line px-2 py-1 hover:bg-bg-panel"
          >
            {t.common.refresh}
          </button>
          {busy ? <span>{t.explorer.busy(busy)}</span> : null}
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}
      {ws === "raw" ? (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-[11px] text-ink-faint">
          {t.explorer.rawHintPrefix}{" "}
          <span className="font-mono text-ink">/ingest</span>
          <span className="ml-1">{t.explorer.rawHintSuffix}</span>
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 border-r border-line bg-bg-subtle">
          <FileTree
            ws={ws}
            selectedPath={selected?.path ?? null}
            refreshKey={refreshKey}
            onSelect={setSelected}
            onContextAction={action}
          />
        </aside>
        <div className="min-w-0 flex-1">
          <Editor
            ws={ws}
            entry={selected}
            readOnly={isReadOnly}
            onSaved={refresh}
          />
        </div>
      </section>
    </div>
  );
}

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}
