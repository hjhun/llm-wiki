"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "../i18n";
import Editor from "./Editor";
import FileTree from "./FileTree";
import type { Entry, ExplorerAction, WsKey } from "./types";

const WS_LIST: { key: WsKey; label: string }[] = [
  { key: "wiki", label: "wiki/" },
  { key: "raw", label: "raw/" },
  { key: "sessions", label: "sessions/" },
];

function parseWs(value: string | null): WsKey | null {
  if (value === "wiki" || value === "raw" || value === "sessions") {
    return value;
  }
  return null;
}

export default function Explorer() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const linkedWs = parseWs(searchParams.get("ws"));
  const linkedPath = searchParams.get("path")?.replace(/^\/+/, "") ?? null;
  const [ws, setWs] = useState<WsKey>("wiki");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [uploadTarget, setUploadTarget] = useState<Entry | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const isReadOnly = ws === "sessions";
  const focusPath = linkedWs === ws ? linkedPath : null;

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!linkedWs || linkedWs === ws) return;
    setWs(linkedWs);
    setSelected(null);
  }, [linkedWs, ws]);

  function action(kind: ExplorerAction, target: Entry | null) {
    setError(null);
    if (isReadOnly) {
      setError(t.explorer.readOnlyError);
      return;
    }
    if (kind === "upload-file" || kind === "upload-dir") {
      triggerUpload(kind, target);
      return;
    }

    const parent =
      target?.kind === "dir"
        ? target.path
        : target?.path
          ? target.path.split("/").slice(0, -1).join("/")
          : "";
    const base = parent ? `${parent}/` : "";
    if (kind === "new-file" || kind === "new-dir") {
      setDialog({
        kind,
        target,
        value: base,
      });
    } else if (target) {
      setDialog({
        kind,
        target,
        value: target.path,
      });
    }
  }

  async function submitDialog() {
    if (!dialog) return;
    try {
      if (dialog.kind === "new-file" || dialog.kind === "new-dir") {
        const name = dialog.value.trim();
        if (!name) return;
        setBusy(dialog.kind);
        const res = await fetch("/api/files/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ws,
            path: name,
            kind: dialog.kind === "new-file" ? "file" : "dir",
          }),
        });
        if (!res.ok) throw await asError(res);
      } else if (dialog.kind === "rename" && dialog.target) {
        const next = dialog.value.trim();
        if (!next || next === dialog.target.path) return;
        setBusy(dialog.kind);
        const res = await fetch("/api/files/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, from: dialog.target.path, to: next }),
        });
        if (!res.ok) throw await asError(res);
        if (selected?.path === dialog.target.path) setSelected(null);
      } else if (dialog.kind === "delete" && dialog.target) {
        setBusy(dialog.kind);
        const res = await fetch("/api/files/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, path: dialog.target.path }),
        });
        if (!res.ok) throw await asError(res);
        if (selected?.path === dialog.target.path) setSelected(null);
      }
      setDialog(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function triggerUpload(kind: "upload-file" | "upload-dir", target: Entry | null) {
    setUploadTarget(target ?? selected);
    if (kind === "upload-file") {
      fileInputRef.current?.click();
    } else {
      dirInputRef.current?.click();
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
    const target = uploadTarget ?? selected;
    const dir =
      target?.kind === "dir"
        ? target.path
        : target?.path
          ? target.path.split("/").slice(0, -1).join("/")
          : "";
    const fd = new FormData();
    fd.set("ws", ws);
    fd.set("dir", dir);
    for (const f of Array.from(files)) {
      fd.append("files", f);
      fd.append("paths", f.webkitRelativePath || f.name);
    }
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
      setUploadTarget(null);
    }
  }

  const directoryInputProps = {
    webkitdirectory: "",
    directory: "",
  } as React.InputHTMLAttributes<HTMLInputElement>;

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
                router.replace("/explorer", { scroll: false });
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
          <button
            type="button"
            onClick={() => triggerUpload("upload-file", selected)}
            disabled={isReadOnly}
            className="rounded border border-line px-2 py-1 hover:bg-bg-panel disabled:pointer-events-none disabled:opacity-40"
          >
            {t.explorer.upload}
          </button>
          <button
            type="button"
            onClick={() => triggerUpload("upload-dir", selected)}
            disabled={isReadOnly}
            className="rounded border border-line px-2 py-1 hover:bg-bg-panel disabled:pointer-events-none disabled:opacity-40"
          >
            {t.explorer.uploadFolder}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onUpload}
            disabled={isReadOnly}
          />
          <input
            ref={dirInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onUpload}
            disabled={isReadOnly}
            {...directoryInputProps}
          />
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
            focusPath={focusPath}
            refreshKey={refreshKey}
            onSelect={setSelected}
            onContextAction={action}
            readOnly={isReadOnly}
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
      {dialog ? (
        <ActionDialog
          dialog={dialog}
          busy={busy !== null}
          onChange={(value) => setDialog((curr) => (curr ? { ...curr, value } : curr))}
          onCancel={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  );
}

type DialogState = {
  kind: "new-file" | "new-dir" | "rename" | "delete";
  target: Entry | null;
  value: string;
};

function ActionDialog({
  dialog,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  dialog: DialogState;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLanguage();
  const isDelete = dialog.kind === "delete";
  const title =
    dialog.kind === "new-file"
      ? t.explorer.newFilePath
      : dialog.kind === "new-dir"
        ? t.explorer.newFolderPath
        : dialog.kind === "rename"
          ? t.explorer.newPath
          : t.explorer.deleteTitle;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="w-full max-w-md rounded border border-line bg-bg-subtle shadow-2xl">
        <div className="border-b border-line px-4 py-3">
          <div className="text-sm font-medium text-ink">{title}</div>
          {dialog.target ? (
            <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
              {dialog.target.path}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-4">
          {isDelete ? (
            <p className="text-sm text-ink-dim">
              {t.explorer.deleteConfirm(dialog.target?.path ?? "")}
            </p>
          ) : (
            <input
              autoFocus
              value={dialog.value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
                if (event.key === "Escape") onCancel();
              }}
              className="w-full rounded border border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line px-3 py-1.5 text-xs text-ink-dim hover:bg-bg-panel hover:text-ink"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || (!isDelete && dialog.value.trim().length === 0)}
            className={[
              "rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40",
              isDelete
                ? "bg-red-500 text-white"
                : "bg-accent text-bg",
            ].join(" ")}
          >
            {isDelete ? t.common.delete : t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}
