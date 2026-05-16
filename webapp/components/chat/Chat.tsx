"use client";

import { useCallback, useEffect, useState } from "react";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SessionList from "./SessionList";
import { useLanguage } from "../i18n";
import type {
  ChatMessage,
  ChatProgress,
  ChatProgressLog,
  SessionRef,
} from "./types";

type ActiveSession = {
  path: string;
  meta: SessionRef["meta"];
  messages: ChatMessage[];
};

type ChatSendEvent =
  | { type: "start"; sessionPath: string }
  | { type: "chunk"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "progress";
      phase: "state";
      summary: string;
      active: string | null;
    }
  | {
      type: "progress";
      phase: "log";
      ts: string;
      op: string;
      detail: string;
    }
  | {
      type: "done";
      sessionPath: string;
      assistant: ChatMessage;
      exitCode: number;
      durationMs: number;
    }
  | { type: "error"; sessionPath: string; error: string };

const PROGRESS_LOG_CAP = 12;

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

type ChatKind = "chat" | "ingest" | "query" | "lint" | "graph";

function detectKind(message: string): ChatKind {
  const head = message.trimStart().toLowerCase();
  if (head.startsWith("/ingest")) return "ingest";
  if (head.startsWith("/query")) return "query";
  if (head.startsWith("/lint")) return "lint";
  if (head.startsWith("wiki-graphify ")) return "graph";
  return "chat";
}

export default function Chat() {
  const { t } = useLanguage();
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ChatProgress | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as { sessions: SessionRef[] };
      setSessions(j.sessions);
      return j.sessions;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  // 초기: 세션 목록을 받고 가장 최근 세션을 자동 열어둔다.
  useEffect(() => {
    (async () => {
      const list = await refreshSessions();
      if (list.length > 0) {
        await openSession(list[0]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openSession(ref: SessionRef) {
    setError(null);
    try {
      const u = new URL("/api/chat/session", window.location.origin);
      u.searchParams.set("path", ref.path);
      const res = await fetch(u);
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as {
        meta: SessionRef["meta"];
        messages: ChatMessage[];
      };
      setActive({ path: ref.path, meta: j.meta, messages: j.messages });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function newSessionDraft() {
    // 실제 세션 파일 생성은 첫 메시지 전송 시 send 라우트가 만든다.
    setActive(null);
    setError(null);
  }

  async function deleteSessions(paths: string[]) {
    if (paths.length === 0 || deleting) return;
    const ok = window.confirm(t.chat.deleteConfirm(paths.length));
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) throw await asError(res);
      if (active && paths.includes(active.path)) {
        setActive(null);
      }
      const list = await refreshSessions();
      if (active && paths.includes(active.path) && list.length > 0) {
        await openSession(list[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  async function send(message: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    setProgress(null);

    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);

    // 낙관적 사용자 메시지 표시
    const optimisticUser: ChatMessage = {
      role: "user",
      ts,
      content: message,
    };
    const streamingAssistant: ChatMessage = {
      role: "assistant",
      ts,
      agent: "streaming",
      content: "",
    };
    if (active) {
      setActive({ ...active, messages: [...active.messages, optimisticUser] });
    } else {
      setActive({
        path: "(pending)",
        meta: {
          title: message.slice(0, 60),
          agent: null,
          created: now.toISOString(),
          updated: now.toISOString(),
        },
        messages: [optimisticUser],
      });
    }

    let sessionPath = active?.path && active.path !== "(pending)"
      ? active.path
      : undefined;
    let accumulated = "";
    let assistantInserted = false;
    let streamError: string | null = null;

    function upsertStreamingAssistant(content: string) {
      setActive((current) => {
        if (!current) return current;
        const messages = [...current.messages];
        const index = messages.findIndex(
          (m) =>
            m.role === streamingAssistant.role &&
            m.ts === streamingAssistant.ts &&
            m.agent === streamingAssistant.agent,
        );
        const nextMessage = { ...streamingAssistant, content };
        if (index >= 0) {
          messages[index] = nextMessage;
        } else {
          messages.push(nextMessage);
        }
        assistantInserted = true;
        return { ...current, messages };
      });
    }

    function replaceStreamingAssistant(finalMessage: ChatMessage) {
      setActive((current) => {
        if (!current) return current;
        const messages = [...current.messages];
        const index = messages.findIndex(
          (m) =>
            m.role === streamingAssistant.role &&
            m.ts === streamingAssistant.ts &&
            m.agent === streamingAssistant.agent,
        );
        if (index >= 0) {
          messages[index] = finalMessage;
        } else {
          messages.push(finalMessage);
        }
        return {
          ...current,
          path: sessionPath ?? current.path,
          messages,
        };
      });
    }

    async function reopenSession(path: string) {
      const reopen = await fetch(
        `/api/chat/session?path=${encodeURIComponent(path)}`,
      );
      if (!reopen.ok) return;
      const data = (await reopen.json()) as {
        meta: SessionRef["meta"];
        messages: ChatMessage[];
      };
      setActive({
        path,
        meta: data.meta,
        messages: data.messages,
      });
    }

    function handleEvent(event: ChatSendEvent) {
      if (event.type === "start") {
        sessionPath = event.sessionPath;
        setActive((current) =>
          current ? { ...current, path: event.sessionPath } : current,
        );
        return;
      }
      if (event.type === "chunk") {
        accumulated += event.text;
        upsertStreamingAssistant(accumulated || t.chat.processing);
        return;
      }
      if (event.type === "progress") {
        setProgress((current) => {
          const log: ChatProgressLog[] = current?.log ?? [];
          if (event.phase === "state") {
            return {
              summary: event.summary,
              active: event.active,
              log,
              updated: new Date().toISOString(),
            };
          }
          // event.phase === "log"
          const nextLog: ChatProgressLog[] = [
            ...log,
            { ts: event.ts, op: event.op, detail: event.detail },
          ].slice(-PROGRESS_LOG_CAP);
          return {
            summary: current?.summary ?? null,
            active: current?.active ?? null,
            log: nextLog,
            updated: new Date().toISOString(),
          };
        });
        return;
      }
      if (event.type === "done") {
        sessionPath = event.sessionPath;
        replaceStreamingAssistant(event.assistant);
        return;
      }
      streamError = event.error;
      setError(event.error);
    }

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionPath,
          message,
          kind: detectKind(message),
        }),
      });
      if (!res.ok) throw await asError(res);
      if (!res.body) {
        throw new Error("streaming response body is unavailable");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failed = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ChatSendEvent;
          handleEvent(event);
          if (event.type === "error") failed = true;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = JSON.parse(buffer) as ChatSendEvent;
        handleEvent(event);
        if (event.type === "error") failed = true;
      }

      if (sessionPath) {
        await reopenSession(sessionPath);
      }
      await refreshSessions();
      if (failed) {
        throw new Error(streamError ?? "CLI stream failed");
      }
    } catch (err) {
      if (assistantInserted && accumulated) {
        upsertStreamingAssistant(accumulated);
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="w-64 shrink-0 border-r border-line bg-bg-subtle">
        <SessionList
          sessions={sessions}
          activePath={active?.path ?? null}
          onSelect={openSession}
          onNew={newSessionDraft}
          onDelete={deleteSessions}
          deleting={deleting}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {active?.meta.title ?? t.chat.newTitle}
            </div>
            <div className="font-mono text-[11px] text-ink-faint">
              {active?.path ?? t.chat.pendingPath}
            </div>
          </div>
          {active?.meta.agent ? (
            <div className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-dim">
              agent: <span className="font-mono">{active.meta.agent}</span>
            </div>
          ) : null}
        </header>

        {error ? (
          <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <MessageList
            messages={active?.messages ?? []}
            pending={pending}
            progress={progress}
          />
        </div>

        <Composer disabled={pending} onSend={send} />
      </section>
    </div>
  );
}
