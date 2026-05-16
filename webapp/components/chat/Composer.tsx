"use client";

import { useEffect, useRef, useState } from "react";

const SLASH_COMMANDS: { name: string; arg: string; desc: string }[] = [
  { name: "/ingest", arg: "<path|url>", desc: "raw의 자료를 위키로 흡수" },
  { name: "/query", arg: "<질문>", desc: "위키 검색 + 답변 작성" },
  { name: "/lint", arg: "", desc: "위키 건강 점검" },
];

export default function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (message: string) => void;
}) {
  const [value, setValue] = useState("");
  const [showPlus, setShowPlus] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 슬래시 자동완성 후보
  const slashMatch =
    value.startsWith("/") && !value.includes(" ")
      ? SLASH_COMMANDS.filter((c) =>
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

  function pickCommand(cmd: (typeof SLASH_COMMANDS)[number]) {
    setValue(cmd.arg ? `${cmd.name} ` : cmd.name);
    setShowPlus(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  return (
    <div className="relative border-t border-line bg-bg-subtle px-4 py-3">
      {showPlus ? (
        <div className="absolute bottom-full left-4 mb-2 w-72 rounded-md border border-line bg-bg-panel p-2 shadow-xl">
          <div className="mb-1 px-2 text-[10px] uppercase tracking-widest text-ink-faint">
            명령
          </div>
          {SLASH_COMMANDS.map((c) => (
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
        <button
          type="button"
          onClick={() => setShowPlus((v) => !v)}
          className="rounded-md border border-line bg-bg px-2.5 py-2 text-sm text-ink-dim hover:bg-bg-panel hover:text-ink"
          title="명령 메뉴"
        >
          +
        </button>
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
          placeholder="질문을 입력하거나 /ingest, /query, /lint …  (Shift+Enter로 줄바꿈)"
          className="block w-full resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-40"
        >
          전송
        </button>
      </div>
      <div className="mt-1 px-1 text-[10px] text-ink-faint">
        Enter 전송 · Shift+Enter 줄바꿈 · `/`로 슬래시 커맨드 자동완성
      </div>
    </div>
  );
}
