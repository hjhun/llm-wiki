"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLanguage } from "../i18n";
import type { ChatMessage, ChatProgress } from "./types";

const ROLE_LABEL: Record<string, string> = {
  user: "you",
  assistant: "agent",
  system: "system",
};

const ROLE_STYLE: Record<string, string> = {
  user: "chat-message-user",
  assistant: "chat-message-assistant",
  system: "chat-message-system",
};

export default function MessageList({
  messages,
  pending,
  progress,
}: {
  messages: ChatMessage[];
  pending: boolean;
  progress: ChatProgress | null;
}) {
  const { t } = useLanguage();
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, progress?.updated]);

  const showProgress =
    pending &&
    progress != null &&
    (progress.summary != null || progress.log.length > 0);

  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {messages.length === 0 && !pending ? (
        <div className="rounded-md border border-line bg-bg-panel px-4 py-6 text-sm text-ink-dim">
          <div className="mb-1 font-medium text-ink">{t.chat.guideTitle}</div>
          <ul className="ml-4 list-disc text-[12.5px] leading-relaxed">
            <li>
              {t.chat.guideFreeQuestion}{" "}
              <span className="font-mono">/preprocess &lt;path&gt;</span>,{" "}
              <span className="font-mono">/ingest &lt;path&gt;</span>,{" "}
              <span className="font-mono">/query &lt;question&gt;</span>,{" "}
              <span className="font-mono">/lint</span>
            </li>
            <li>{t.chat.guideSessions}</li>
            <li>{t.chat.guideAgent}</li>
          </ul>
        </div>
      ) : null}
      {messages.map((m, i) => (
        <article
          key={i}
          className={[
            "rounded-md border px-4 py-3 text-sm leading-relaxed",
            ROLE_STYLE[m.role] ?? "border-line",
            "chat-message",
          ].join(" ")}
        >
          <header className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono uppercase tracking-widest">
              {ROLE_LABEL[m.role] ?? m.role}
              {m.agent ? `·${m.agent}` : ""}
            </span>
            <span className="font-mono">{m.ts}</span>
          </header>
          <div className="prose prose-theme max-w-none text-[13.5px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {m.content || t.chat.empty}
            </ReactMarkdown>
          </div>
        </article>
      ))}
      {showProgress ? (
        <article className="chat-progress-card rounded-md border px-4 py-3 text-[12.5px]">
          <header className="chat-progress-title mb-1 flex items-center gap-2 text-[11px]">
            <span className="font-mono uppercase tracking-widest">
              {t.chat.progressTitle}
            </span>
          </header>
          {progress?.summary ? (
            <div className="chat-progress-summary font-mono text-[11.5px]">
              {progress.summary}
            </div>
          ) : (
            <div className="chat-progress-muted text-[11.5px]">
              {t.chat.progressWaiting}
            </div>
          )}
          {progress && progress.log.length > 0 ? (
            <ul className="chat-progress-log mt-2 space-y-0.5 font-mono text-[11px]">
              {progress.log.map((entry, i) => (
                <li key={`${entry.ts}-${i}`} className="truncate">
                  <span className="chat-progress-time">{entry.ts}</span>
                  <span className="chat-progress-separator mx-1">·</span>
                  <span>{entry.op}</span>
                  <span className="chat-progress-separator mx-1">|</span>
                  <span>{entry.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}
      {pending ? (
        <article className="rounded-md border border-line bg-bg-subtle px-4 py-3 text-sm">
          <header className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-mono uppercase tracking-widest">agent</span>
            <span>{t.chat.processing}</span>
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
