"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Eraser,
  LoaderCircle,
  LockKeyhole,
  Send,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AgentMascot from "../agent-panel/AgentMascot";
import { Button, IconButton, StatusBadge, cx } from "../ui";

type PublicMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  ts: string;
  content: string;
};

type PublicQueryResponse = {
  mode: "query";
  question: string;
  answer: string;
  sources: Array<{ path: string; title: string; score: number }>;
  agent: string | null;
  durationMs: number;
};

const STORAGE_KEY = "clio.public.messages.v1";

function nowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function loadMessages(): PublicMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PublicMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        (item.role === "user" ||
          item.role === "assistant" ||
          item.role === "system") &&
        typeof item.ts === "string" &&
        typeof item.content === "string",
    );
  } catch {
    return [];
  }
}

async function asError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `request failed (${res.status})`);
}

export default function PublicClioChat() {
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMessages(loadMessages());
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  async function send() {
    const message = value.trim();
    if (!message || pending) return;

    const userMessage: PublicMessage = {
      id: newId(),
      role: "user",
      ts: nowStamp(),
      content: message,
    };
    setMessages((current) => [...current, userMessage]);
    setValue("");
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/public/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw await asError(res);
      const data = (await res.json()) as PublicQueryResponse;
      const sources =
        data.sources.length > 0
          ? "\n\n---\n\n" +
            data.sources
              .map((source) => `- ${source.title}: \`${source.path}\``)
              .join("\n")
          : "";
      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "assistant",
          ts: nowStamp(),
          content: `${data.answer}${sources}`,
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "system",
          ts: nowStamp(),
          content: msg,
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  function clear() {
    setMessages([]);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-bg/80 text-ink">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg-panel/76 px-5 py-3 shadow-sm backdrop-blur-xl">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              public clio
            </div>
            <h1 className="truncate text-base font-semibold text-ink">
              CLIO Query
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge tone="ready">
              <LockKeyhole aria-hidden className="mr-1 h-3 w-3" />
              query only
            </StatusBadge>
            <IconButton
              icon={Eraser}
              label="Clear local chat"
              onClick={clear}
              disabled={pending || messages.length === 0}
              variant="ghost"
            />
          </div>
        </header>

        {error ? (
          <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
            {error}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-h-0 overflow-auto">
            <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-3 px-4 py-5 sm:px-6">
              {messages.length === 0 ? (
                <div className="flex min-h-40 flex-col justify-end border-b border-line/70 pb-6">
                  <div className="max-w-2xl text-2xl font-semibold leading-tight text-ink sm:text-3xl">
                    wiki에 대해 물어보세요.
                  </div>
                </div>
              ) : null}

              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}

              {pending ? (
                <article className="rounded-md border border-line bg-bg-subtle px-4 py-3 text-sm">
                  <header className="mb-2 flex items-center gap-2 text-[11px] text-ink-faint">
                    <LoaderCircle
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin"
                    />
                    <span className="font-mono uppercase tracking-widest">
                      query
                    </span>
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
          </div>

          <aside className="hidden border-l border-line bg-bg-subtle/72 p-5 lg:flex lg:flex-col lg:justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                session
              </div>
              <div className="mt-2 text-sm font-medium text-ink">
                Local browser history
              </div>
              <div className="mt-1 text-xs leading-relaxed text-ink-faint">
                {messages.length} messages
              </div>
            </div>
            <div className="flex justify-center">
              <AgentMascot running={pending} />
            </div>
          </aside>
        </div>

        <div className="border-t border-line bg-bg-subtle px-4 py-3">
          <div className="mx-auto flex max-w-4xl items-end gap-2">
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="질문 입력"
              disabled={pending}
              className="block w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
            />
            <Button
              onClick={() => void send()}
              disabled={pending || !value.trim()}
              variant="primary"
              size="md"
              icon={pending ? LoaderCircle : Send}
              className={cx(pending && "[&>svg]:animate-spin")}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function MessageBubble({ message }: { message: PublicMessage }) {
  const Icon =
    message.role === "user" ? UserRound : message.role === "assistant" ? Bot : LockKeyhole;
  const label =
    message.role === "user" ? "you" : message.role === "assistant" ? "clio" : "system";

  return (
    <article
      className={cx(
        "chat-message rounded-md border px-4 py-3 text-sm leading-relaxed shadow-[inset_0_1px_0_rgb(255_255_255_/_0.03)]",
        message.role === "user" && "chat-message-user",
        message.role === "assistant" && "chat-message-assistant",
        message.role === "system" && "chat-message-system",
      )}
    >
      <header className="mb-2 flex items-center gap-2 text-[11px] text-ink-faint">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono uppercase tracking-widest">
          {label}
        </span>
        <span className="shrink-0 font-mono">{message.ts}</span>
      </header>
      <div className="prose prose-theme max-w-none text-[13.5px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.content}
        </ReactMarkdown>
      </div>
    </article>
  );
}
