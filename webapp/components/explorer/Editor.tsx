"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLanguage } from "../i18n";
import type { Entry, WsKey } from "./types";

type FileMode = "edit" | "preview";

const TEXT_EXT_RE = /\.(md|mdx|txt|json|jsonc|yaml|yml|ts|tsx|js|jsx|css|html|csv|tsv|log|toml|ini|env|sh|py|go|rs|sql|xml|svg)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF_EXT_RE = /\.pdf$/i;

export default function Editor({
  ws,
  entry,
  readOnly,
  onSaved,
}: {
  ws: WsKey;
  entry: Entry | null;
  readOnly: boolean;
  onSaved?: () => void;
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<FileMode>("edit");
  const [original, setOriginal] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastLoadedRef = useRef<string | null>(null);

  const isMd = entry ? /\.(md|mdx)$/i.test(entry.path) : false;
  const isText = entry ? TEXT_EXT_RE.test(entry.path) : false;
  const isImage = entry ? IMAGE_EXT_RE.test(entry.path) : false;
  const isPdf = entry ? PDF_EXT_RE.test(entry.path) : false;
  const dirty = entry?.kind === "file" && content !== original;

  useEffect(() => {
    if (!entry || entry.kind !== "file") {
      setContent("");
      setOriginal("");
      setError(null);
      lastLoadedRef.current = null;
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
        if (!readOnly && dirty && !saving) onSave();
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
        </div>
        <div className="flex items-center gap-1">
          {isMd ? (
            <div className="mr-2 flex overflow-hidden rounded border border-line">
              <button
                type="button"
                onClick={() => setMode("edit")}
                className={[
                  "px-2 py-1 text-[11px]",
                  mode === "edit"
                    ? "bg-bg-panel text-ink"
                    : "text-ink-dim hover:bg-bg-panel/60",
                ].join(" ")}
              >
                {t.common.edit}
              </button>
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={[
                  "px-2 py-1 text-[11px]",
                  mode === "preview"
                    ? "bg-bg-panel text-ink"
                    : "text-ink-dim hover:bg-bg-panel/60",
                ].join(" ")}
              >
                {t.common.preview}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={readOnly || !dirty || saving || !isText}
            className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-bg disabled:opacity-40"
            title="Ctrl/Cmd+S"
          >
            {saving ? t.common.saving : dirty ? t.common.save : t.common.saved}
          </button>
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
              src={`/api/files/blob?ws=${ws}&path=${encodeURIComponent(entry.path)}`}
              alt={entry.name}
              className="max-h-full max-w-full"
            />
          </div>
        ) : isPdf ? (
          <iframe
            title={entry.name}
            src={`/api/files/blob?ws=${ws}&path=${encodeURIComponent(entry.path)}`}
            className="h-full w-full bg-white"
          />
        ) : !isText ? (
          <div className="p-4 text-sm text-ink-faint">
            {t.explorer.binary}{" "}
            <a
              className="text-accent underline"
              href={`/api/files/blob?ws=${ws}&path=${encodeURIComponent(entry.path)}`}
              target="_blank"
              rel="noreferrer"
            >
              {t.common.download}
            </a>
          </div>
        ) : mode === "preview" && isMd ? (
          <div className="prose prose-invert max-w-none px-6 py-4 text-sm leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <textarea
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
