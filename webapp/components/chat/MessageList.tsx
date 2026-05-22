"use client";

import { Children, useEffect, useRef, useState } from "react";
import {
  Archive,
  Bot,
  CircleDotDashed,
  ExternalLink,
  Terminal,
  UserRound,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLanguage } from "../i18n";
import { EmptyState } from "../ui";
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

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const isExplorerLink = href?.startsWith("/explorer?");
    if (isExplorerLink) {
      return (
        <a
          href={href}
          className="not-prose inline-flex max-w-full items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] text-accent no-underline hover:border-accent hover:bg-accent/15"
          {...props}
        >
          <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
          <span className="truncate">{children}</span>
        </a>
      );
    }
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
  code({ className, children, node: _node, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const language = match?.[1]?.toLowerCase();
    const source = Children.toArray(children).join("").replace(/\n$/, "");

    if (language === "mermaid") {
      return <MermaidDiagram source={source} />;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export default function MessageList({
  messages,
  pending,
  progress,
  sessionPath,
  capturingIndex,
  onCaptureMessage,
}: {
  messages: ChatMessage[];
  pending: boolean;
  progress: ChatProgress | null;
  sessionPath: string | null;
  capturingIndex: number | null;
  onCaptureMessage: (messageIndex: number) => void;
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
          className="items-start text-left"
        />
      ) : null}
      {messages.map((m, i) => {
        const RoleIcon =
          m.role === "user" ? UserRound : m.role === "assistant" ? Bot : Terminal;
        return (
          <article
            key={i}
            className={[
              "rounded-md border px-4 py-3 text-sm leading-relaxed shadow-[inset_0_1px_0_rgb(255_255_255_/_0.03)]",
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
              {m.role === "assistant" && sessionPath && !pending ? (
                <button
                  type="button"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line bg-bg-subtle text-ink-muted transition hover:border-accent/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  title={t.chat.saveCapture}
                  aria-label={t.chat.saveCapture}
                  disabled={capturingIndex === i}
                  onClick={() => onCaptureMessage(i)}
                >
                  <Archive aria-hidden className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </header>
            <div className="prose prose-theme max-w-none text-[13.5px]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {m.content || t.chat.empty}
              </ReactMarkdown>
            </div>
          </article>
        );
      })}
      {showProgress ? (
        <article className="chat-progress-card rounded-md border px-4 py-3 text-[12.5px] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]">
          <header className="chat-progress-title mb-1 flex items-center gap-2 text-[11px]">
            <CircleDotDashed aria-hidden className="h-3.5 w-3.5 animate-spin" />
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

function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const renderCountRef = useRef(0);

  if (!idRef.current) {
    idRef.current = `chat-mermaid-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        setSvg(null);
        setError(null);
        const mermaid = (await import("mermaid")).default;
        const theme =
          document.documentElement.dataset.theme === "dark" ? "dark" : "default";

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
        });

        renderCountRef.current += 1;
        const result = await mermaid.render(
          `${idRef.current}-${renderCountRef.current}`,
          source,
        );
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="not-prose my-4 overflow-hidden rounded border border-red-900/60 bg-red-950/20">
        <div className="border-b border-red-900/60 px-3 py-2 text-xs text-red-300">
          Mermaid render failed: {error}
        </div>
        <pre className="overflow-auto p-3 text-[11px] leading-relaxed text-ink-dim">
          {source}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="not-prose my-4 rounded border border-line bg-bg-subtle px-3 py-2 text-xs text-ink-faint">
        Rendering Mermaid diagram...
      </div>
    );
  }

  return (
    <div
      className="not-prose my-4 overflow-auto rounded border border-line bg-bg-subtle p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
