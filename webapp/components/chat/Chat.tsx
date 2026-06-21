"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, Database, ListChecks, Pencil, X } from "lucide-react";
import AutoIngestBanner from "./AutoIngestBanner";
import AutoLintHint from "./AutoLintHint";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SessionList from "./SessionList";
import { useLanguage } from "../i18n";
import { useToast } from "../ui/Toast";
import { IconButton, PageHeader, StatusBadge } from "../ui";
import type {
  ChatJobSnapshot,
  ChatKind,
  SequencedChatSendEvent,
} from "@/lib/chat-events";
import type {
  ChatAgentProgress,
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
  if (head.startsWith("/")) return "chat";
  return "query";
}

function latestUserMessage(messages: ChatMessage[] | undefined): string {
  const found = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  return found?.content ?? "";
}

function operationTarget(kind: ChatKind | null, message: string): string {
  const trimmed = message.trim();
  if (kind === "lint") return "wiki/";
  if (kind === "graph") return "wiki/graph/";
  if (kind === "preprocess") {
    return trimmed.replace(/^\/preprocess\b/i, "").trim() || "raw/";
  }
  if (kind === "ingest" || kind === "ingest-loop") {
    return trimmed.replace(/^\/(?:ingest-loop|ingest)\b/i, "").trim() || "raw/";
  }
  return "wiki/";
}

function operationLabel(kind: ChatKind | null): string {
  if (!kind) return "agent";
  return kind;
}

function currentWork(progress: ChatProgress | null): string | null {
  const activeAgent =
    progress?.agents.find(
      (agent) =>
        agent.status === "running" || agent.status === "consolidating",
    ) ?? progress?.agents.at(-1);
  return (
    activeAgent?.detail ??
    progress?.summary ??
    progress?.log.at(-1)?.detail ??
    null
  );
}

function activeRound(progress: ChatProgress | null): number | null {
  const agent =
    progress?.agents.find(
      (candidate) =>
        candidate.status === "running" || candidate.status === "consolidating",
    ) ?? progress?.agents.at(-1);
  return agent?.round ?? null;
}

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function RunningOperationBar({
  kind,
  target,
  progress,
  elapsedMs,
}: {
  kind: ChatKind | null;
  target: string;
  progress: ChatProgress | null;
  elapsedMs: number;
}) {
  const { t } = useLanguage();
  const label = operationLabel(kind);
  const activeTarget = progress?.active ?? target;
  const work = currentWork(progress) ?? t.chat.processing;
  const round = activeRound(progress);

  return (
    <div
      className="chat-operation-bar px-4 py-2"
      data-kind={kind ?? "agent"}
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Activity aria-hidden className="h-4 w-4 shrink-0 animate-pulse text-accent" />
          <span className="chat-operation-kicker shrink-0 font-mono text-[10px] uppercase tracking-widest">
            {t.chat.operationStatus}
          </span>
          <span className="shrink-0 rounded border border-line bg-bg/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
            {label}
          </span>
          {round ? (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {t.chat.operationRound(round)}
            </span>
          ) : null}
          <span
            className="shrink-0 font-mono text-[10px] tabular-nums tracking-widest text-accent"
            aria-label={t.chat.operationElapsed}
            title={t.chat.operationElapsed}
          >
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div className="grid min-w-0 flex-1 gap-1 md:grid-cols-[minmax(9rem,0.7fr)_minmax(14rem,1.3fr)]">
          <div className="flex min-w-0 items-center gap-1.5">
            <Database aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="chat-operation-label shrink-0 text-[11px]">
              {t.chat.operationTarget}
            </span>
            <span className="chat-operation-target min-w-0 truncate font-mono text-[11px]">
              {activeTarget}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <ListChecks aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="chat-operation-label shrink-0 text-[11px]">
              {t.chat.operationCurrent}
            </span>
            <span className="chat-operation-current min-w-0 truncate text-[11.5px]">
              {work}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { t } = useLanguage();
  const { notify } = useToast();
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [pending, setPending] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  // Tracks the active operation kind for status/reattach bookkeeping.
  const [activeKind, setActiveKind] = useState<ChatKind | null>(null);
  const [attachedJobId, setAttachedJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamTokenRef = useRef(0);
  const streamSeqRef = useRef<Record<string, number>>({});

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    const dir = `uploads/${date}`;
    const form = new FormData();
    form.set("ws", "raw");
    form.set("dir", dir);
    for (const file of files) form.append("files", file);
    try {
      const res = await fetch("/api/files/upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw await asError(res);
      notify(t.chat.dropUploaded(files.length), "success");
      // Suggest ingesting what was just dropped.
      setPrefill(`/ingest raw/${dir}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

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
  // Live elapsed-time counter for the running-operation bar. Coding-agent CLIs
  // (codex exec / claude -p) buffer stdout until exit, so the answer often
  // arrives in one burst at the end; a ticking timer reassures the user the
  // run is still progressing instead of staring at a frozen screen.
  useEffect(() => {
    if (!pending) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const handle = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(handle);
  }, [pending]);

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

    function handleEvent(event: SequencedChatSendEvent) {
      if (streamTokenRef.current !== token) return;
      if (typeof event.seq === "number") {
        const lastSeq = streamSeqRef.current[event.jobId] ?? -1;
        if (event.seq <= lastSeq) return;
        streamSeqRef.current[event.jobId] = event.seq;
      }
      setAttachedJobId(event.jobId);
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
          const agents: ChatAgentProgress[] = current?.agents ?? [];
          if (event.phase === "agent") {
            const updated = new Date().toISOString();
            const nextAgent: ChatAgentProgress = {
              agentId: event.agentId,
              name: event.name,
              role: event.role,
              detail: event.detail,
              ascii: event.ascii,
              status: event.status,
              cli: event.cli,
              round: event.round,
              durationMs: event.durationMs,
              accent: event.accent,
              updated,
            };
            const existingIndex = agents.findIndex(
              (agent) => agent.agentId === event.agentId,
            );
            const nextAgents =
              existingIndex >= 0
                ? agents.map((agent, index) =>
                    index === existingIndex ? nextAgent : agent,
                  )
                : [...agents, nextAgent];
            return {
              summary: current?.summary ?? null,
              active: current?.active ?? null,
              log,
              agents: nextAgents,
              updated,
            };
          }
          if (event.phase === "state") {
            return {
              summary: event.summary,
              active: event.active,
              log,
              agents,
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
            agents,
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
          const event = JSON.parse(line) as SequencedChatSendEvent;
          handleEvent(event);
          if (event.type === "error") failed = true;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = JSON.parse(buffer) as SequencedChatSendEvent;
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
      u.searchParams.set("after", String(streamSeqRef.current[job.id] ?? -1));
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
  const runningTarget = operationTarget(
    activeKind,
    latestUserMessage(active?.messages),
  );

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg/72">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-bg-panel/54">
        <div className="min-h-0 flex-1">
          <SessionList
            sessions={sessions}
            activePath={active?.path ?? null}
            onSelect={openSession}
            onNew={newSessionDraft}
            onDelete={deleteSessions}
            deleting={deleting}
            running={pending}
          />
        </div>
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
        <div
          className="relative min-h-0 flex-1 overflow-auto bg-[linear-gradient(180deg,rgb(var(--color-bg)_/_0.72),rgb(var(--color-bg-subtle)_/_0.42))]"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false);
          }}
          onDrop={handleDrop}
        >
          {dragging ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/60 bg-accent/10 backdrop-blur-sm">
              <span className="rounded-md bg-bg-panel/90 px-3 py-1.5 text-sm font-medium text-accent">
                {t.chat.dropHint}
              </span>
            </div>
          ) : null}
          <MessageList
            messages={active?.messages ?? []}
            pending={pending}
            progress={progress}
            onSaveAnswer={(question) => {
              if (pending) return;
              notify(t.chat.saveRequested, "info");
              void send(`/query --save ${question}`);
            }}
          />
        </div>

        {pending ? (
          <RunningOperationBar
            kind={activeKind}
            target={runningTarget}
            progress={progress}
            elapsedMs={elapsedMs}
          />
        ) : null}

        <Composer
          disabled={pending}
          onSend={send}
          prefill={prefill}
          onPrefillConsumed={() => setPrefill(null)}
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
