"use client";

import { useEffect, useRef, useState } from "react";
import { Command, Plus, Send, StopCircle } from "lucide-react";
import { useLanguage } from "../i18n";
import { IconButton } from "../ui";

export default function Composer({
  disabled,
  onSend,
  cancel,
}: {
  disabled: boolean;
  onSend: (message: string) => void;
  /**
   * Generic "Stop CLI" handler. Surfaces whenever a chat-page CLI call is
   * in-flight so the user can abort all running child CLIs immediately.
   */
  cancel?: { onCancel: () => void; cancelling: boolean } | null;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const [showPlus, setShowPlus] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 슬래시 자동완성 후보
  const slashMatch =
    value.startsWith("/") && !value.includes(" ")
      ? t.chat.slashCommands.filter((c) =>
          c.name.startsWith(value.toLowerCase()),
        )
      : [];

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = `${Math.min(
      taRef.current.scrollHeight,
      240,
    )}px`;
  }, [value]);

  function submit() {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue("");
  }

  function pickCommand(cmd: (typeof t.chat.slashCommands)[number]) {
    setValue(cmd.arg ? `${cmd.name} ` : cmd.name);
    setShowPlus(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  return (
    <div className="relative border-t border-line bg-bg-subtle px-4 py-3">
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

      {slashMatch.length > 0 ? (
        <div className="absolute bottom-full left-4 mb-2 w-72 rounded-md border border-line bg-bg-panel p-2 shadow-xl">
          {slashMatch.map((c) => (
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

      <div className="flex items-end gap-2">
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") setShowPlus(false);
          }}
          placeholder={t.chat.placeholder}
          className="block w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
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
      <div className="mt-1 px-1 text-[10px] text-ink-faint">
        {t.chat.hint}
      </div>
    </div>
  );
}
