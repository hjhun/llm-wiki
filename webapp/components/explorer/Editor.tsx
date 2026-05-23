"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FileWarning, Save } from "lucide-react";
import { useLanguage } from "../i18n";
import { Button, cx } from "../ui";
import MarkdownPreview from "./MarkdownPreview";
import type { Entry, WsKey } from "./types";

const TEXT_EXT_RE = /\.(md|mdx|txt|json|jsonc|yaml|yml|ts|tsx|js|jsx|css|html|csv|tsv|log|toml|ini|env|sh|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|sql|xml|svg)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|flac)$/i;
const OFFICE_EXT_RE = /\.(doc|docx|ppt|pptx|xls|xlsx|odt|ods|odp|rtf)$/i;

export default function Editor({
  ws,
  entry,
  readOnly,
  targetLine,
  onSaved,
}: {
  ws: WsKey;
  entry: Entry | null;
  readOnly: boolean;
  targetLine?: number | null;
  onSaved?: () => void;
}) {
  const { t } = useLanguage();
  const [original, setOriginal] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastLoadedRef = useRef<string | null>(null);
  const markdownTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isMd = entry ? /\.(md|mdx)$/i.test(entry.path) : false;
  const isText = entry ? TEXT_EXT_RE.test(entry.path) : false;
  const isImage = entry ? IMAGE_EXT_RE.test(entry.path) : false;
  const isPdf = entry ? PDF_EXT_RE.test(entry.path) : false;
  const isVideo = entry ? VIDEO_EXT_RE.test(entry.path) : false;
  const isAudio = entry ? AUDIO_EXT_RE.test(entry.path) : false;
  const isOffice = entry ? OFFICE_EXT_RE.test(entry.path) : false;
  const dirty = entry?.kind === "file" && content !== original;
  const rawSymlinkFile = ws === "raw" && entry?.isSymlink;

  useEffect(() => {
    if (!entry || entry.kind !== "file") {
      setContent("");
      setOriginal("");
      setError(null);
      lastLoadedRef.current = null;
      return;
    }
    if (entry.broken) {
      setContent("");
      setOriginal("");
      setError("broken symlink");
      lastLoadedRef.current = `${ws}:${entry.path}`;
      return;
    }
    const key = `${ws}:${entry.path}`;
    if (lastLoadedRef.current === key) return;
    if (!isText) {
      // Binary/image files are shown through their blob endpoint.
      lastLoadedRef.current = key;
      setContent("");
      setOriginal("");
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    (async () => {
      try {
        const u = new URL("/api/files/content", window.location.origin);
        u.searchParams.set("ws", ws);
        u.searchParams.set("path", entry.path);
        const res = await fetch(u);
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `read failed (${res.status})`);
        }
        const j = (await res.json()) as { content: string };
        setContent(j.content);
        setOriginal(j.content);
        lastLoadedRef.current = key;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [entry, ws, isText]);

  useEffect(() => {
    if (!targetLine || !isText || !content) return;
    const textarea = isMd ? markdownTextareaRef.current : textTextareaRef.current;
    if (!textarea) return;
    const { start, end } = lineRange(content, targetLine);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (targetLine - 4) * lineHeight);
  }, [targetLine, isText, isMd, content]);

  async function onSave() {
    if (!entry) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/files/content", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ws, path: entry.path, content }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `save failed (${res.status})`);
      }
      setOriginal(content);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!readOnly && !rawSymlinkFile && dirty && !saving) onSave();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">
        {t.explorer.selectFile}
      </div>
    );
  }

  if (entry.kind === "dir") {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-line px-4 py-2 font-mono text-xs text-ink-dim">
          {ws}/{entry.path}/
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
          {t.explorer.directory}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-ink-dim">
            {ws}/{entry.path}
          </div>
          <div className="text-[10px] text-ink-faint">
            {entry.size.toLocaleString()} bytes · {t.explorer.modified}{" "}
            {new Date(entry.mtime).toLocaleString()}
          </div>
          {entry.isSymlink ? (
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-faint">
              <ExternalLink className="h-3 w-3" />
              <span className="truncate">
                {entry.broken
                  ? "broken symlink"
                  : `symlink -> ${entry.linkTarget ?? "unknown"}`}
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            onClick={onSave}
            disabled={readOnly || rawSymlinkFile || !dirty || saving || !isText}
            variant="primary"
            icon={Save}
            className="h-7 px-2.5 text-[11px]"
            title="Ctrl/Cmd+S"
          >
            {saving ? t.common.saving : dirty ? t.common.save : t.common.saved}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}
      {readOnly ? (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-[11px] text-ink-faint">
          {t.explorer.readOnly}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {loading ? (
          <div className="p-4 text-sm text-ink-faint">{t.common.loading}</div>
        ) : isImage ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={blobHref(ws, entry.path)}
              alt={entry.name}
              className="max-h-full max-w-full"
            />
          </div>
        ) : isPdf ? (
          <iframe
            title={entry.name}
            src={blobHref(ws, entry.path)}
            className="h-full w-full bg-white"
          />
        ) : isVideo ? (
          <div className="flex h-full items-center justify-center bg-black p-4">
            <video
              src={blobHref(ws, entry.path)}
              controls
              playsInline
              className="max-h-full max-w-full"
            />
          </div>
        ) : isAudio ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-2xl rounded-md border border-line bg-bg-panel p-5 shadow-sm">
              <div className="mb-4 truncate font-mono text-xs text-ink-dim">
                {entry.name}
              </div>
              <audio
                src={blobHref(ws, entry.path)}
                controls
                className="w-full"
              />
            </div>
          </div>
        ) : isOffice ? (
          <OfficePreview ws={ws} entry={entry} />
        ) : !isText ? (
          <BinaryFallback ws={ws} entry={entry} message={t.explorer.binary} />
        ) : isMd ? (
          <div className="grid h-full min-w-0 grid-cols-1 md:grid-cols-2">
            <section className="flex min-h-0 flex-col border-b border-line md:border-b-0 md:border-r">
              <div className="shrink-0 border-b border-line bg-bg-subtle px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {t.common.edit}
              </div>
              <textarea
                ref={markdownTextareaRef}
                value={content}
                readOnly={readOnly}
                spellCheck={false}
                onChange={(e) => setContent(e.target.value)}
                className="block min-h-72 flex-1 resize-none bg-bg px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none md:min-h-0"
              />
            </section>
            <section className="flex min-h-0 flex-col">
              <div className="shrink-0 border-b border-line bg-bg-subtle px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {t.common.preview}
              </div>
              <MarkdownPreview
                content={content}
                className="prose prose-theme min-h-0 max-w-none flex-1 overflow-auto px-6 py-4 text-sm leading-relaxed"
              />
            </section>
          </div>
        ) : (
          <textarea
            ref={textTextareaRef}
            value={content}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => setContent(e.target.value)}
            className="block h-full w-full resize-none bg-bg px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
          />
        )}
      </div>
    </div>
  );
}

function lineRange(content: string, line: number): { start: number; end: number } {
  if (line <= 1) {
    const end = content.indexOf("\n");
    return { start: 0, end: end === -1 ? content.length : end };
  }
  let current = 1;
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      current += 1;
      start = i + 1;
      if (current === line) break;
    }
  }
  if (current !== line) return { start: content.length, end: content.length };
  const next = content.indexOf("\n", start);
  return { start, end: next === -1 ? content.length : next };
}

function blobHref(ws: WsKey, path: string): string {
  const params = new URLSearchParams({ ws, path });
  return `/api/files/blob?${params.toString()}`;
}

function previewHref(ws: WsKey, path: string): string {
  const params = new URLSearchParams({ ws, path });
  return `/api/files/preview?${params.toString()}`;
}

function OfficePreview({ ws, entry }: { ws: WsKey; entry: Entry }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let nextObjectUrl: string | null = null;

    setStatus("loading");
    setObjectUrl(null);
    setMessage(null);

    (async () => {
      try {
        const res = await fetch(previewHref(ws, entry.path));
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `preview failed (${res.status})`);
        }
        const blob = await res.blob();
        nextObjectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(nextObjectUrl);
          return;
        }
        setObjectUrl(nextObjectUrl);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [entry.path, ws]);

  if (status === "ready" && objectUrl) {
    return (
      <iframe
        title={entry.name}
        src={objectUrl}
        className="h-full w-full bg-white"
      />
    );
  }

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-ink-faint">
        {t.common.loading}
      </div>
    );
  }

  return (
    <BinaryFallback
      ws={ws}
      entry={entry}
      message={message ?? t.explorer.previewUnavailable}
      detail={t.explorer.officePreviewHint}
    />
  );
}

function BinaryFallback({
  ws,
  entry,
  message,
  detail,
}: {
  ws: WsKey;
  entry: Entry;
  message: string;
  detail?: string;
}) {
  const { t } = useLanguage();
  const href = blobHref(ws, entry.path);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-md border border-line bg-bg-panel p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md border border-line bg-bg-subtle p-2 text-ink-dim">
            <FileWarning aria-hidden className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs text-ink-dim">
              {entry.name}
            </div>
            <p className="mt-2 text-sm text-ink-faint">{message}</p>
            {detail ? <p className="mt-1 text-xs text-ink-faint">{detail}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                className={cx(
                  "inline-flex h-8 items-center justify-center gap-2 rounded-md border border-line bg-bg-panel/78 px-3 text-xs font-medium text-ink-dim shadow-sm transition-colors hover:border-ink-faint/60 hover:bg-bg-panel hover:text-ink",
                )}
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink aria-hidden className="h-4 w-4" />
                {t.explorer.openFile}
              </a>
              <a
                className={cx(
                  "inline-flex h-8 items-center justify-center gap-2 rounded-md border border-line bg-bg-panel/78 px-3 text-xs font-medium text-ink-dim shadow-sm transition-colors hover:border-ink-faint/60 hover:bg-bg-panel hover:text-ink",
                )}
                href={href}
                download={entry.name}
              >
                <Download aria-hidden className="h-4 w-4" />
                {t.common.download}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
