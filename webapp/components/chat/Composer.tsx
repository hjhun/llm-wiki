"use client";

import { useEffect, useRef, useState } from "react";
import { Command, Folder, FileText, Plus, Send, StopCircle } from "lucide-react";
import { useLanguage } from "../i18n";
import { IconButton } from "../ui";
import type { Entry } from "@/lib/files";

// Commands whose first argument is a raw/ path we can autocomplete.
const PATH_CMD_RE = /^(\/(?:ingest-loop|ingest|preprocess))\s+(.*)$/i;

type PathLoc = { dir: string; base: string };

/** Split a raw-rooted partial path into the directory to list and the prefix. */
function rawDirAndBase(arg: string): PathLoc | null {
  if (arg !== "" && !arg.startsWith("raw")) return null;
  const rel = arg.replace(/^raw\/?/, "");
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash) : "";
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  return { dir, base };
}

export default function Composer({
  disabled,
  onSend,
  cancel,
  prefill,
  onPrefillConsumed,
}: {
  disabled: boolean;
  onSend: (message: string) => void;
  /**
   * Generic "Stop CLI" handler. Surfaces whenever a chat-page CLI call is
   * in-flight so the user can abort all running child CLIs immediately.
   */
  cancel?: { onCancel: () => void; cancelling: boolean } | null;
  /** External text to drop into the composer (e.g. an ingest suggestion). */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const [showPlus, setShowPlus] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [pathEntries, setPathEntries] = useState<Entry[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Command suggestions: typing `/word` with no space yet.
  const commandSuggestions =
    !dismissed && value.startsWith("/") && !value.includes(" ")
      ? t.chat.slashCommands.filter((c) =>
          c.name.startsWith(value.toLowerCase()),
        )
      : [];

  // Path suggestions: `/ingest <raw partial path>`.
  const pathParse = (() => {
    const match = PATH_CMD_RE.exec(value);
    if (!match) return null;
    const loc = rawDirAndBase(match[2]);
    if (!loc) return null;
    return { prefix: match[1], ...loc };
  })();

  const pathSuggestions =
    !dismissed && pathParse
      ? pathEntries
          .filter((e) =>
            e.name.toLowerCase().startsWith(pathParse.base.toLowerCase()),
          )
          .slice(0, 8)
      : [];

  const activeList =
    commandSuggestions.length > 0
      ? commandSuggestions
      : pathSuggestions.length > 0
        ? pathSuggestions
        : [];

  // Fetch the directory listing for path completion when the dir changes.
  useEffect(() => {
    if (!pathParse) {
      setPathEntries([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/files/list?ws=raw&path=${encodeURIComponent(pathParse.dir)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { entries?: Entry[] };
        if (!cancelled) setPathEntries(json.entries ?? []);
      } catch {
        if (!cancelled) setPathEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-list only when the directory portion changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathParse?.prefix, pathParse?.dir]);

  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  // Accept an externally supplied value (e.g. a drag-and-drop ingest suggestion).
  useEffect(() => {
    if (prefill == null) return;
    setValue(prefill);
    setDismissed(true);
    onPrefillConsumed?.();
    focusSoon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 240)}px`;
  }, [value]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function focusSoon() {
    setTimeout(() => taRef.current?.focus(), 0);
  }

  function pickCommand(cmd: (typeof t.chat.slashCommands)[number]) {
    setValue(cmd.arg ? `${cmd.name} ` : cmd.name);
    setShowPlus(false);
    setDismissed(false);
    focusSoon();
  }

  function pickPath(entry: Entry) {
    if (!pathParse) return;
    const rel = (pathParse.dir ? `${pathParse.dir}/` : "") + entry.name;
    const inserted = `raw/${rel}${entry.kind === "dir" ? "/" : ""}`;
    setValue(`${pathParse.prefix} ${inserted}`);
    // Keep the dropdown open after stepping into a directory.
    setDismissed(entry.kind !== "dir");
    focusSoon();
  }

  function acceptActive() {
    if (commandSuggestions.length > 0) {
      pickCommand(commandSuggestions[activeIndex] ?? commandSuggestions[0]);
    } else if (pathSuggestions.length > 0) {
      pickPath(pathSuggestions[activeIndex] ?? pathSuggestions[0]);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const open = activeList.length > 0;
    if (open && e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % activeList.length);
      return;
    }
    if (open && e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + activeList.length) % activeList.length);
      return;
    }
    if (open && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      acceptActive();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape") {
      setShowPlus(false);
      setDismissed(true);
    }
  }

  return (
    <div className="relative border-t border-line bg-bg-panel/78 px-4 py-3 shadow-[0_-14px_36px_rgb(0_0_0_/_0.16)] backdrop-blur-xl">
      {showPlus ? (
        <div className="absolute bottom-full left-4 mb-2 w-80 rounded-md border border-line bg-bg-panel p-2 shadow-2xl">
          <div className="mb-1 flex items-center gap-1.5 px-2 text-[10px] uppercase tracking-widest text-ink-faint">
            <Command aria-hidden className="h-3 w-3" />
            <span>{t.chat.commands}</span>
          </div>
          {t.chat.slashCommands.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => pickCommand(c)}
              className="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs hover:bg-bg"
            >
              <span className="font-mono text-ink">
                {c.name}
                <span className="text-ink-faint"> {c.arg}</span>
              </span>
              <span className="text-[11px] text-ink-faint">{c.desc}</span>
            </button>
          ))}
        </div>
      ) : null}

      {commandSuggestions.length > 0 ? (
        <div className="absolute bottom-full left-4 mb-2 w-72 rounded-md border border-line bg-bg-panel p-2 shadow-xl">
          {commandSuggestions.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => pickCommand(c)}
              className={[
                "flex w-full flex-col rounded px-2 py-1.5 text-left text-xs",
                i === activeIndex ? "bg-bg" : "hover:bg-bg",
              ].join(" ")}
            >
              <span className="font-mono text-ink">
                {c.name}
                <span className="text-ink-faint"> {c.arg}</span>
              </span>
              <span className="text-[11px] text-ink-faint">{c.desc}</span>
            </button>
          ))}
        </div>
      ) : pathSuggestions.length > 0 ? (
        <div className="absolute bottom-full left-4 mb-2 w-80 rounded-md border border-line bg-bg-panel p-2 shadow-xl">
          <div className="mb-1 px-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            raw/{pathParse?.dir ? `${pathParse.dir}/` : ""}
          </div>
          {pathSuggestions.map((entry, i) => (
            <button
              key={entry.path}
              type="button"
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => pickPath(entry)}
              className={[
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                i === activeIndex ? "bg-bg" : "hover:bg-bg",
              ].join(" ")}
            >
              {entry.kind === "dir" ? (
                <Folder aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />
              ) : (
                <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              )}
              <span className="truncate font-mono text-ink">
                {entry.name}
                {entry.kind === "dir" ? "/" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mx-auto flex max-w-4xl items-end gap-2">
        <IconButton
          onClick={() => setShowPlus((v) => !v)}
          label={t.chat.commandMenu}
          icon={Plus}
          className="h-10 w-10"
        />
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={t.chat.placeholder}
          className="block w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_rgb(var(--color-accent)_/_0.14)]"
        />
        {cancel ? (
          <IconButton
            onClick={cancel.onCancel}
            disabled={cancel.cancelling}
            title={t.chat.cancelHint}
            label={cancel.cancelling ? t.chat.cancelling : t.chat.cancel}
            variant="danger"
            icon={StopCircle}
            className="h-10 w-10 shrink-0"
          />
        ) : null}
        <IconButton
          onClick={submit}
          disabled={disabled || !value.trim()}
          variant="primary"
          label={t.chat.send}
          icon={Send}
          className="h-10 w-10 shrink-0"
        />
      </div>
      <div className="mx-auto mt-1 max-w-4xl px-1 text-[10px] text-ink-faint">
        {t.chat.hint}
      </div>
    </div>
  );
}
