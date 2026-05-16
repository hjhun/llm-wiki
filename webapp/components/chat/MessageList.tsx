"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "./types";

const ROLE_LABEL: Record<string, string> = {
  user: "you",
  assistant: "agent",
  system: "system",
};

const ROLE_STYLE: Record<string, string> = {
  user: "border-sky-800/70 bg-sky-950/35",
  assistant: "border-emerald-900/70 bg-emerald-950/25",
  system: "border-red-900/60 bg-red-950/30 text-red-200",
};

export default function MessageList({
  messages,
  pending,
}: {
  messages: ChatMessage[];
  pending: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {messages.length === 0 && !pending ? (
        <div className="rounded-md border border-line bg-bg-panel px-4 py-6 text-sm text-ink-dim">
          <div className="mb-1 font-medium text-ink">시작 가이드</div>
          <ul className="ml-4 list-disc text-[12.5px] leading-relaxed">
            <li>
              자유 질문 또는 슬래시 커맨드:{" "}
              <span className="font-mono">/ingest &lt;path&gt;</span>,{" "}
              <span className="font-mono">/query &lt;질문&gt;</span>,{" "}
              <span className="font-mono">/lint</span>
            </li>
            <li>
              세션 md는{" "}
              <span className="font-mono">sessions/&lt;date&gt;/</span>에
              자동 저장됩니다.
            </li>
            <li>
              에이전트는 호스트 PC의 codex / claude / gemini / cline 중 Settings에서
              지정한 것을 사용합니다.
            </li>
          </ul>
        </div>
      ) : null}
      {messages.map((m, i) => (
        <article
          key={i}
          className={[
            "rounded-md border px-4 py-3 text-sm leading-relaxed",
            ROLE_STYLE[m.role] ?? "border-line",
          ].join(" ")}
        >
          <header className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono uppercase tracking-widest">
              {ROLE_LABEL[m.role] ?? m.role}
              {m.agent ? `·${m.agent}` : ""}
            </span>
            <span className="font-mono">{m.ts}</span>
          </header>
          <div className="prose prose-invert max-w-none text-[13.5px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {m.content || "_(empty)_"}
            </ReactMarkdown>
          </div>
        </article>
      ))}
      {pending ? (
        <article className="rounded-md border border-line bg-bg-subtle px-4 py-3 text-sm">
          <header className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono uppercase tracking-widest">agent</span>
            <span>처리 중…</span>
          </header>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:240ms]" />
          </div>
        </article>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
