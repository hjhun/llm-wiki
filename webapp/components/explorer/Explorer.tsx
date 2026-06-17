"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderUp, RefreshCw, Upload } from "lucide-react";
import { useLanguage } from "../i18n";
import DirectoryView from "./DirectoryView";
import Editor from "./Editor";
import FileTree from "./FileTree";
import { Button, PageHeader, SegmentControl, Toolbar, cx } from "../ui";
import type { Entry, ExplorerAction, WsKey } from "./types";

const WS_LIST: { key: WsKey; label: string }[] = [
  { key: "wiki", label: "wiki/" },
  { key: "raw", label: "raw/" },
  { key: "progress", label: "progress/" },
  { key: "sessions", label: "sessions/" },
];

function parseWs(value: string | null): WsKey | null {
  if (
    value === "wiki" ||
    value === "raw" ||
    value === "progress" ||
    value === "sessions"
  ) {
    return value;
  }
  return null;
}

function isTrashPath(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

export default function Explorer() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const linkedWs = parseWs(searchParams.get("ws"));
  const linkedPath = searchParams.get("path")?.replace(/^\/+/, "") ?? null;
  const linkedLine = parseLine(searchParams.get("line"));
  const [ws, setWs] = useState<WsKey>("wiki");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [uploadTarget, setUploadTarget] = useState<Entry | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const isReadOnly = ws === "sessions" || ws === "progress";
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
    if (kind === "empty-trash") {
      if (target?.kind !== "dir" || target.path !== ".trash") return;
      setDialog({ kind, target, value: target.path });
      return;
    }
    if ((kind === "delete" || kind === "rename") && target?.path === ".trash") {
      setError(t.explorer.trashRootActionBlocked);
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
        targets: target ? [target] : undefined,
        value: target.path,
      });
    }
  }

  function deleteEntries(targets: Entry[]) {
    if (isReadOnly) {
      setError(t.explorer.readOnlyError);
      return;
    }
    const removable = targets.filter((target) => target.path !== ".trash");
    if (removable.length === 0) return;
    setError(null);
    setDialog({
      kind: "delete",
      target: removable[0] ?? null,
      targets: removable,
      value: removable.map((target) => target.path).join("\n"),
    });
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
        const targets = dialog.targets?.length ? dialog.targets : [dialog.target];
        setBusy(dialog.kind);
        const res = await fetch("/api/files/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, paths: targets.map((target) => target.path) }),
        });
        if (!res.ok) throw await asError(res);
        if (selected && targets.some((target) => target.path === selected.path)) {
          setSelected(null);
        }
      } else if (dialog.kind === "empty-trash" && dialog.target) {
        setBusy(dialog.kind);
        const res = await fetch("/api/files/empty-trash", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, path: dialog.target.path }),
        });
        if (!res.ok) throw await asError(res);
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
      <PageHeader
        eyebrow="file workbench"
        title={t.sidebar.tabs.explorer.label}
        meta={t.explorer.workspaces[ws]}
        actions={
          <>
            <Button
              onClick={() => triggerUpload("upload-file", selected)}
              disabled={isReadOnly}
              icon={Upload}
            >
              {t.explorer.upload}
            </Button>
            <Button
              onClick={() => triggerUpload("upload-dir", selected)}
              disabled={isReadOnly}
              icon={FolderUp}
            >
              {t.explorer.uploadFolder}
            </Button>
            <Button onClick={refresh} icon={RefreshCw}>
              {t.common.refresh}
            </Button>
            {busy ? <span className="text-[11px] text-ink-faint">{t.explorer.busy(busy)}</span> : null}
          </>
        }
      />
      <Toolbar>
        <SegmentControl
          value={ws}
          onChange={(nextWs) => {
            setWs(nextWs);
            setSelected(null);
            router.replace("/explorer", { scroll: false });
          }}
          options={WS_LIST.map((w) => ({
            value: w.key,
            label: w.label,
            title: t.explorer.workspaces[w.key],
          }))}
          className="grid-cols-4"
        />
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
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
        </div>
      </Toolbar>
      {error ? (
        <div className="border-b border-danger/50 bg-danger/10 px-4 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
      {ws === "raw" ? (
        <div className="border-b border-info/30 bg-info/10 px-4 py-1 text-[11px] text-info">
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
          {selected?.kind === "file" ? (
            <Editor
              ws={ws}
              entry={selected}
              readOnly={isReadOnly}
              targetLine={linkedWs === ws && selected.path === linkedPath ? linkedLine : null}
              onSaved={refresh}
            />
          ) : (
            <DirectoryView
              ws={ws}
              entry={selected}
              refreshKey={refreshKey}
              readOnly={isReadOnly}
              busy={busy !== null}
              onSelect={setSelected}
              onClearSelection={() => setSelected(null)}
              onContextAction={action}
              onDeleteEntries={deleteEntries}
            />
          )}
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

function parseLine(value: string | null): number | null {
  if (!value) return null;
  const first = value.split("-")[0];
  const line = Number.parseInt(first, 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

type DialogState = {
  kind: "new-file" | "new-dir" | "rename" | "delete" | "empty-trash";
  target: Entry | null;
  targets?: Entry[];
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
  const isEmptyTrash = dialog.kind === "empty-trash";
  const deleteTargets = dialog.targets?.length
    ? dialog.targets
    : dialog.target
      ? [dialog.target]
      : [];
  const title =
    dialog.kind === "new-file"
      ? t.explorer.newFilePath
      : dialog.kind === "new-dir"
        ? t.explorer.newFolderPath
        : dialog.kind === "rename"
          ? t.explorer.newPath
          : isEmptyTrash
            ? t.explorer.emptyTrashTitle
            : t.explorer.deleteTitle;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="w-full max-w-md rounded-md border border-line bg-bg-subtle shadow-2xl">
        <div className="border-b border-line px-4 py-3">
          <div className="text-sm font-medium text-ink">{title}</div>
          {dialog.target ? (
            <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
              {dialog.target.path}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-4">
          {isDelete || isEmptyTrash ? (
            <p className="text-sm text-ink-dim">
              {isEmptyTrash
                ? t.explorer.emptyTrashConfirm(dialog.target?.path ?? "")
                : deleteTargets.length > 1
                  ? t.explorer.deleteManyConfirm(deleteTargets.length)
                  : isTrashPath(deleteTargets[0]?.path ?? "")
                    ? t.explorer.deletePermanentConfirm(deleteTargets[0]?.path ?? "")
                    : t.explorer.deleteConfirm(deleteTargets[0]?.path ?? "")}
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
          <Button
            onClick={onCancel}
            variant="secondary"
          >
            {t.common.cancel}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={busy || (!isDelete && !isEmptyTrash && dialog.value.trim().length === 0)}
            variant={isDelete || isEmptyTrash ? "danger" : "primary"}
            className={cx(isDelete || isEmptyTrash ? "border-danger/60" : "")}
          >
            {isDelete || isEmptyTrash ? t.common.delete : t.common.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}
