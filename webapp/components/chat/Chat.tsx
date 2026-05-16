"use client";

import { useCallback, useEffect, useState } from "react";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SessionList from "./SessionList";
import { useLanguage } from "../i18n";
import type { ChatMessage, SessionRef } from "./types";

type ActiveSession = {
  path: string;
  meta: SessionRef["meta"];
  messages: ChatMessage[];
};

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

export default function Chat() {
  const { t } = useLanguage();
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);

    // 낙관적 사용자 메시지 표시
    const optimisticUser: ChatMessage = {
      role: "user",
      ts,
      content: message,
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

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionPath: active?.path && active.path !== "(pending)"
            ? active.path
            : undefined,
          message,
        }),
      });
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as {
        sessionPath: string;
        assistant: ChatMessage;
      };
      // 새 세션이 만들어졌을 수 있음. 전체 다시 로드.
      const reopen = await fetch(
        `/api/chat/session?path=${encodeURIComponent(j.sessionPath)}`,
      );
      if (reopen.ok) {
        const data = (await reopen.json()) as {
          meta: SessionRef["meta"];
          messages: ChatMessage[];
        };
        setActive({
          path: j.sessionPath,
          meta: data.meta,
          messages: data.messages,
        });
      }
      await refreshSessions();
    } catch (err) {
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
          <MessageList messages={active?.messages ?? []} pending={pending} />
        </div>

        <Composer disabled={pending} onSend={send} />
      </section>
    </div>
  );
}
