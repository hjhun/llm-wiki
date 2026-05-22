"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import AutoIngestBanner from "./AutoIngestBanner";
import AutoLintHint from "./AutoLintHint";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SessionList from "./SessionList";
import { useLanguage } from "../i18n";
import { IconButton, PageHeader, StatusBadge } from "../ui";
import type {
  ChatJobSnapshot,
  ChatKind,
  ChatSendEvent,
  SequencedChatSendEvent,
} from "@/lib/chat-events";
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

const PROGRESS_LOG_CAP = 12;

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

function detectKind(message: string): ChatKind {
  const head = message.trimStart().toLowerCase();
  // Match the longer prefix first so "/ingest-loop" is not classified as
  // a plain "/ingest" call.
  if (head.startsWith("/ingest-loop")) return "ingest-loop";
  if (head.startsWith("/ingest")) return "ingest";
  if (head.startsWith("/preprocess")) return "preprocess";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  // Tracks the active operation kind for status/reattach bookkeeping.
  const [activeKind, setActiveKind] = useState<ChatKind | null>(null);
  const [attachedJobId, setAttachedJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [capturingIndex, setCapturingIndex] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamTokenRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as { sessions: SessionRef[] };
      const visibleSessions = j.sessions.filter(
        (session) => session.meta.origin !== "background",
      );
      setSessions(visibleSessions);
      return visibleSessions;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  const refreshRunningJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/jobs");
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as { jobs: ChatJobSnapshot[] };
      return j.jobs;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  const loadSession = useCallback(async (path: string) => {
    const u = new URL("/api/chat/session", window.location.origin);
    u.searchParams.set("path", path);
    const res = await fetch(u);
    if (!res.ok) throw await asError(res);
    const j = (await res.json()) as {
      meta: SessionRef["meta"];
      messages: ChatMessage[];
    };
    setActive({ path, meta: j.meta, messages: j.messages });
  }, []);

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }

  function cancelActiveStream() {
    streamTokenRef.current += 1;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setPending(false);
    setActiveKind(null);
    setAttachedJobId(null);
    setProgress(null);
    setCancelling(false);
  }

  // 초기에는 가장 최근 세션만 연다. 실행 중인 다른 세션의 job에 자동으로
  // 붙으면 채널 간 진행 내용이 섞여 보일 수 있다.
  useEffect(() => {
    (async () => {
      const list = await refreshSessions();
      const firstChatSession =
        list.find((session) => session.meta.origin !== "background") ?? null;
      if (firstChatSession) {
        await openSession(firstChatSession);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      streamTokenRef.current += 1;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, []);

  async function openSession(ref: SessionRef) {
    cancelActiveStream();
    setError(null);
    setNotice(null);
    setRenaming(false);
    setRenameDraft("");
    try {
      await loadSession(ref.path);
      const jobs = await refreshRunningJobs();
      const job = jobs.find((candidate) => candidate.sessionPath === ref.path);
      if (job) await attachJob(job, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function newSessionDraft() {
    // 실제 세션 파일 생성은 첫 메시지 전송 시 send 라우트가 만든다.
    cancelActiveStream();
    setActive(null);
    setRenaming(false);
    setRenameDraft("");
    setError(null);
    setNotice(null);
  }

  function startRename() {
    if (!active || active.path === "(pending)") return;
    setRenameDraft(active.meta.title);
    setRenaming(true);
    setError(null);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameDraft("");
  }

  async function saveRename() {
    if (!active || active.path === "(pending)" || savingRename) return;
    const title = renameDraft.trim();
    if (!title) {
      setError(t.chat.renameEmpty);
      return;
    }
    if (title === active.meta.title) {
      cancelRename();
      return;
    }
    setSavingRename(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/session", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: active.path, title }),
      });
      if (!res.ok) throw await asError(res);
      const ref = (await res.json()) as SessionRef;
      setActive((current) =>
        current && current.path === ref.path
          ? { ...current, meta: ref.meta }
          : current,
      );
      setSessions((current) =>
        current.map((session) => (session.path === ref.path ? ref : session)),
      );
      setRenaming(false);
      setRenameDraft("");
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRename(false);
    }
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
      const firstChatSession =
        list.find((session) => session.meta.origin !== "background") ?? null;
      if (active && paths.includes(active.path) && firstChatSession) {
        await openSession(firstChatSession);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  // Immediate stop for any chat-page CLI call. Sends a server-side SIGTERM via
  // /api/chat/jobs/cancel; the running job's `done` event still arrives through
  // the existing stream as a short stopped-result report.
  async function cancelCli() {
    if (!pending || !attachedJobId || cancelling) {
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch("/api/chat/jobs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: attachedJobId }),
      });
      if (!res.ok) throw await asError(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  async function captureMessage(messageIndex: number) {
    if (!active || active.path === "(pending)" || capturingIndex !== null) {
      return;
    }
    setCapturingIndex(messageIndex);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/chat/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionPath: active.path,
          messageIndex,
        }),
      });
      if (!res.ok) throw await asError(res);
      const j = (await res.json()) as { path: string };
      setNotice(t.chat.captureSaved(j.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturingIndex(null);
    }
  }

  async function consumeChatStream(
    res: Response,
    initialSessionPath: string | undefined,
    token: number,
  ) {
    if (!res.body) {
      throw new Error("streaming response body is unavailable");
    }
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const streamingAssistant: ChatMessage = {
      role: "assistant",
      ts,
      agent: "streaming",
      content: "",
    };

    let sessionPath = initialSessionPath;
    let accumulated = "";
    let assistantInserted = false;
    let streamError: string | null = null;

    function upsertStreamingAssistant(content: string) {
      if (streamTokenRef.current !== token) return;
      setActive((current) => {
        if (streamTokenRef.current !== token) return current;
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
      if (streamTokenRef.current !== token) return;
      setActive((current) => {
        if (streamTokenRef.current !== token) return current;
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
      if (streamTokenRef.current !== token) return;
      const reopen = await fetch(
        `/api/chat/session?path=${encodeURIComponent(path)}`,
      );
      if (!reopen.ok) return;
      const data = (await reopen.json()) as {
        meta: SessionRef["meta"];
        messages: ChatMessage[];
      };
      if (streamTokenRef.current !== token) return;
      setActive({
        path,
        meta: data.meta,
        messages: data.messages,
      });
    }

    function handleEvent(event: ChatSendEvent) {
      if (streamTokenRef.current !== token) return;
      if ("jobId" in event) {
        setAttachedJobId((event as SequencedChatSendEvent).jobId);
      }
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
          if (streamTokenRef.current !== token) return current;
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
      if (streamTokenRef.current === token) await refreshSessions();
      if (failed) {
        throw new Error(streamError ?? "CLI stream failed");
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (assistantInserted && accumulated) {
        upsertStreamingAssistant(accumulated);
      }
      throw err;
    }
  }

  async function attachJob(job: ChatJobSnapshot, reopenFirst: boolean) {
    if (attachedJobId === job.id) return;
    streamTokenRef.current += 1;
    const token = streamTokenRef.current;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setPending(true);
    setActiveKind(job.kind);
    setAttachedJobId(job.id);
    setError(null);
    setProgress(null);
    try {
      if (reopenFirst) await loadSession(job.sessionPath);
      const u = new URL("/api/chat/stream", window.location.origin);
      u.searchParams.set("jobId", job.id);
      u.searchParams.set("sessionPath", job.sessionPath);
      const res = await fetch(u, { signal: controller.signal });
      if (!res.ok) throw await asError(res);
      await consumeChatStream(res, job.sessionPath, token);
    } catch (err) {
      if (!isAbortError(err) && streamTokenRef.current === token) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (streamTokenRef.current === token) {
        streamAbortRef.current = null;
        setPending(false);
        setActiveKind(null);
        setAttachedJobId(null);
      }
    }
  }

  async function send(message: string) {
    if (pending) return;
    const kind = detectKind(message);
    streamTokenRef.current += 1;
    const token = streamTokenRef.current;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setPending(true);
    setActiveKind(kind);
    setAttachedJobId(null);
    setError(null);
    setNotice(null);
    setProgress(null);

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

    const sessionPath =
      active?.path && active.path !== "(pending)" ? active.path : undefined;

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionPath,
          message,
          kind,
        }),
      });
      if (!res.ok) throw await asError(res);
      await consumeChatStream(res, sessionPath, token);
    } catch (err) {
      if (!isAbortError(err) && streamTokenRef.current === token) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (streamTokenRef.current === token) {
        streamAbortRef.current = null;
        setPending(false);
        setActiveKind(null);
        setAttachedJobId(null);
      }
    }
  }

  const canRename = Boolean(active?.path && active.path !== "(pending)");
  const headerTitle =
    renaming && canRename ? (
      <input
        autoFocus
        value={renameDraft}
        onChange={(event) => setRenameDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void saveRename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRename();
          }
        }}
        disabled={savingRename}
        aria-label={t.chat.renameInput}
        className="h-8 w-full max-w-xl rounded-md border border-line bg-bg px-2 text-sm font-semibold text-ink outline-none focus:border-accent"
      />
    ) : (
      active?.meta.title ?? t.chat.newTitle
    );
  const headerActions = (
    <>
      {renaming && canRename ? (
        <>
          <IconButton
            icon={Check}
            label={savingRename ? t.chat.renaming : t.chat.saveRename}
            onClick={() => void saveRename()}
            disabled={savingRename}
            variant="primary"
          />
          <IconButton
            icon={X}
            label={t.common.cancel}
            onClick={cancelRename}
            disabled={savingRename}
            variant="ghost"
          />
        </>
      ) : canRename ? (
        <IconButton
          icon={Pencil}
          label={t.chat.renameChat}
          onClick={startRename}
          disabled={pending}
          variant="ghost"
        />
      ) : null}
      {active?.meta.agent ? (
        <StatusBadge tone="info">
          agent <span className="ml-1 normal-case">{active.meta.agent}</span>
        </StatusBadge>
      ) : pending ? (
        <StatusBadge tone="running">{t.chat.processing}</StatusBadge>
      ) : null}
    </>
  );

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
        <PageHeader
          eyebrow="conversation"
          title={headerTitle}
          meta={active?.path ?? t.chat.pendingPath}
          actions={headerActions}
        />

        <AutoIngestBanner />
        <AutoLintHint />

        {error ? (
          <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="border-b border-emerald-900/50 bg-emerald-950/30 px-4 py-1 text-[11px] text-emerald-300">
            {notice}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <MessageList
            messages={active?.messages ?? []}
            pending={pending}
            progress={progress}
            sessionPath={
              active?.path && active.path !== "(pending)" ? active.path : null
            }
            capturingIndex={capturingIndex}
            onCaptureMessage={captureMessage}
          />
        </div>

        <Composer
          disabled={pending}
          onSend={send}
          cancel={
            pending && activeKind && attachedJobId
              ? { onCancel: cancelCli, cancelling }
              : null
          }
        />
      </section>
    </div>
  );
}
