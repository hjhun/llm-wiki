"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDotDashed,
  LoaderCircle,
  RadioTower,
  Save,
  Sparkles,
  Terminal,
  UserRound,
} from "lucide-react";
import MarkdownContent from "./MarkdownContent";
import MessageCopyButton from "./MessageCopyButton";
import AgentMascot from "../agent-panel/AgentMascot";
import { useLanguage } from "../i18n";
import { EmptyState } from "../ui";
import { extractAnswerSources, sourceHref } from "@/lib/answer-sources";
import { FileText } from "lucide-react";
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

function formatDuration(ms?: number): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

const SAVE_ANSWER_MARKER_RE =
  /<!--\s*clio:save-answer\s+([^>]+?)\s*-->/i;

function decodeMarkerAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSaveAnswerMarker(
  content: string,
): { slug: string; question: string; cleaned: string } | null {
  const match = SAVE_ANSWER_MARKER_RE.exec(content);
  if (!match) return null;
  const attrs = match[1];
  const slug = /slug\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
  const questionRaw = /question\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
  const slugTrim = slug.trim();
  const question = decodeMarkerAttr(questionRaw).trim();
  if (!slugTrim || !question) return null;
  // Strip the marker and the immediately preceding "Save to ..." fallback line
  // so the rendered answer is clean.
  let cleaned = content.replace(SAVE_ANSWER_MARKER_RE, "").trimEnd();
  cleaned = cleaned.replace(/(?:^|\n)\s*Save to `wiki\/answers\/[^`]+`\?\s*$/i, "");
  return { slug: slugTrim, question, cleaned: cleaned.trimEnd() };
}

function agentStatusLabel(status: string): string {
  if (status === "assigned") return "assigned";
  if (status === "running") return "running";
  if (status === "done") return "complete";
  if (status === "error") return "blocked";
  if (status === "consolidating") return "consolidating";
  return status;
}

function AgentStatusIcon({ status }: { status: string }) {
  if (status === "done") {
    return <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />;
  }
  if (status === "error") {
    return <AlertTriangle aria-hidden className="h-3.5 w-3.5" />;
  }
  if (status === "consolidating") {
    return <Sparkles aria-hidden className="h-3.5 w-3.5" />;
  }
  if (status === "running") {
    return <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />;
  }
  return <RadioTower aria-hidden className="h-3.5 w-3.5" />;
}

export default function MessageList({
  messages,
  pending,
  progress,
  onSaveAnswer,
}: {
  messages: ChatMessage[];
  pending: boolean;
  progress: ChatProgress | null;
  onSaveAnswer?: (question: string, slug: string) => void;
}) {
  const { t } = useLanguage();
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, progress?.updated]);

  const showProgress =
    pending &&
    progress != null &&
    (progress.summary != null ||
      progress.log.length > 0 ||
      progress.agents.length > 0);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3 px-5 py-5 lg:px-8">
      {messages.length === 0 && !pending ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8">
          <AgentMascot running={false} />
          <EmptyState
            title={t.chat.guideTitle}
            description={
              <span>
                {t.chat.guideFreeQuestion}{" "}
                <span className="font-mono text-ink">/preprocess</span>,{" "}
                <span className="font-mono text-ink">/ingest</span>,{" "}
                <span className="font-mono text-ink">/query</span>,{" "}
                <span className="font-mono text-ink">/lint</span>
              </span>
            }
            className="w-full max-w-lg"
          />
        </div>
      ) : null}
      {messages.map((m, i) => {
        const RoleIcon =
          m.role === "user" ? UserRound : m.role === "assistant" ? Bot : Terminal;
        const liveMermaid =
          pending && m.role === "assistant" && m.agent === "streaming";
        const saveMarker =
          m.role === "assistant" && !pending
            ? parseSaveAnswerMarker(m.content)
            : null;
        const displayContent = saveMarker ? saveMarker.cleaned : m.content;
        const sources =
          m.role === "assistant" && !liveMermaid
            ? extractAnswerSources(displayContent)
            : [];
        return (
          <article
            key={i}
            className={[
              "rounded-md border px-4 py-3 text-sm leading-relaxed shadow-[0_12px_30px_rgb(0_0_0_/_0.12),inset_0_1px_0_rgb(255_255_255_/_0.04)]",
              ROLE_STYLE[m.role] ?? "border-line",
              "chat-message",
            ].join(" ")}
          >
            <header className="mb-2 flex items-center gap-2 text-[11px] text-ink-faint">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <RoleIcon aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-mono uppercase tracking-widest">
                  {ROLE_LABEL[m.role] ?? m.role}
                  {m.agent ? ` · ${m.agent}` : ""}
                </span>
                <span className="shrink-0 font-mono">{m.ts}</span>
              </div>
            </header>
            <div className="prose prose-theme max-w-none text-[13.5px]">
              <MarkdownContent
                content={displayContent}
                emptyText={t.chat.empty}
                liveMermaid={liveMermaid}
              />
              {liveMermaid && displayContent ? (
                <span className="md-stream-cursor" aria-hidden />
              ) : null}
            </div>
            {sources.length > 0 ? (
              <div className="mt-3 border-t border-line/60 pt-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                  <FileText aria-hidden className="h-3 w-3" />
                  {t.chat.sourcesLabel}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sources.map((source) => (
                    <a
                      key={source.path}
                      href={sourceHref(source.path)}
                      title={source.path}
                      className="inline-flex max-w-full items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent no-underline transition hover:border-accent hover:bg-accent/15"
                    >
                      <span className="truncate">{source.label}</span>
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2">
              {saveMarker && onSaveAnswer ? (
                <button
                  type="button"
                  onClick={() =>
                    onSaveAnswer(saveMarker.question, saveMarker.slug)
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-[rgb(var(--color-bg-subtle)_/_0.6)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-dim transition hover:border-ink-dim hover:text-ink"
                  title={`Feed this answer back to wiki/answers/${saveMarker.slug}.md`}
                >
                  <Save aria-hidden className="h-3 w-3" />
                  Save to wiki/answers/{saveMarker.slug}.md
                </button>
              ) : (
                <span />
              )}
              <MessageCopyButton
                content={m.content}
                copyLabel={t.chat.copyMessage}
                copiedLabel={t.chat.copiedMessage}
              />
            </div>
          </article>
        );
      })}
      {showProgress ? (
        <article className="chat-progress-card rounded-md border px-4 py-3 text-[12.5px] shadow-[0_16px_34px_rgb(0_0_0_/_0.15),inset_0_1px_0_rgb(255_255_255_/_0.04)]">
          <header className="chat-progress-title mb-2 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-2">
              <CircleDotDashed aria-hidden className="h-3.5 w-3.5 animate-spin" />
              <span className="font-mono uppercase tracking-widest">
                {t.chat.progressTitle}
              </span>
            </div>
            {progress?.agents.length ? (
              <span className="font-mono text-[10px] uppercase tracking-widest">
                {progress.agents.filter((agent) => agent.status === "done").length}
                /{progress.agents.length} complete
              </span>
            ) : null}
          </header>
          {progress?.agents.length ? (
            <div className="chat-agent-grid mb-3 grid gap-2 md:grid-cols-2">
              {progress.agents.map((agent) => {
                const duration = formatDuration(agent.durationMs);
                return (
                  <section
                    key={agent.agentId}
                    className="chat-agent-card rounded-md border px-3 py-2"
                    data-status={agent.status}
                    style={
                      agent.accent
                        ? ({ "--agent-accent": agent.accent } as CSSProperties)
                        : undefined
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="chat-agent-orb h-2.5 w-2.5 shrink-0 rounded-full" />
                          <span className="truncate text-[13px] font-semibold text-ink">
                            {agent.name}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[11px] font-medium text-ink-dim">
                          {agent.role}
                        </div>
                      </div>
                      <div className="chat-agent-status flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest">
                        <AgentStatusIcon status={agent.status} />
                        <span>{agentStatusLabel(agent.status)}</span>
                      </div>
                    </div>
                    <div className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-ink-dim">
                      {agent.detail}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                      <span>{agent.cli}</span>
                      <span>
                        round {agent.round}
                        {duration ? ` · ${duration}` : ""}
                      </span>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : null}
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
        <article className="rounded-md border border-line bg-bg-panel/80 px-4 py-3 text-sm shadow-[0_12px_28px_rgb(0_0_0_/_0.12)]">
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
