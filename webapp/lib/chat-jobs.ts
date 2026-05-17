import "server-only";

import { randomUUID } from "node:crypto";
import type { CliName } from "./cli";
import type {
  ChatJobSnapshot,
  ChatJobStatus,
  ChatKind,
  ChatSendEvent,
  SequencedChatSendEvent,
} from "./chat-events";

type StoredEvent = {
  seq: number;
  event: ChatSendEvent;
};

type Listener = (event: SequencedChatSendEvent) => void;

const DONE_RETENTION_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_JOB = 800;
const encoder = new TextEncoder();

export class ChatJob {
  readonly id: string;
  readonly sessionPath: string;
  readonly kind: ChatKind;
  readonly agent: CliName;
  readonly started: string;
  updated: string;
  status: ChatJobStatus = "running";

  private nextSeq = 0;
  private events: StoredEvent[] = [];
  private listeners = new Set<Listener>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: { sessionPath: string; kind: ChatKind; agent: CliName }) {
    const now = new Date().toISOString();
    this.id = randomUUID();
    this.sessionPath = input.sessionPath;
    this.kind = input.kind;
    this.agent = input.agent;
    this.started = now;
    this.updated = now;
  }

  append(event: ChatSendEvent): void {
    if (this.status !== "running") return;
    const seq = this.nextSeq++;
    this.updated = new Date().toISOString();
    if (event.type === "done") this.status = "done";
    if (event.type === "error") this.status = "error";

    this.events.push({ seq, event });
    if (this.events.length > MAX_EVENTS_PER_JOB) {
      this.events = this.events.slice(-MAX_EVENTS_PER_JOB);
    }

    const sequenced = { ...event, jobId: this.id, seq };
    for (const listener of this.listeners) listener(sequenced);

    if (this.status !== "running") {
      this.scheduleCleanup();
    }
  }

  subscribe(afterSeq: number, listener: Listener): () => void {
    for (const { seq, event } of this.events) {
      if (seq > afterSeq) listener({ ...event, jobId: this.id, seq });
    }
    if (this.status === "running") {
      this.listeners.add(listener);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): ChatJobSnapshot {
    return {
      id: this.id,
      sessionPath: this.sessionPath,
      kind: this.kind,
      agent: this.agent,
      status: this.status,
      started: this.started,
      updated: this.updated,
    };
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      getStore().jobs.delete(this.id);
    }, DONE_RETENTION_MS);
  }
}

type ChatJobStore = {
  jobs: Map<string, ChatJob>;
};

declare global {
  // eslint-disable-next-line no-var
  var __llmWikiChatJobStore: ChatJobStore | undefined;
}

function getStore(): ChatJobStore {
  if (!globalThis.__llmWikiChatJobStore) {
    globalThis.__llmWikiChatJobStore = { jobs: new Map() };
  }
  return globalThis.__llmWikiChatJobStore;
}

export function createChatJob(input: {
  sessionPath: string;
  kind: ChatKind;
  agent: CliName;
}): ChatJob {
  const job = new ChatJob(input);
  getStore().jobs.set(job.id, job);
  return job;
}

export function getChatJob(id: string): ChatJob | null {
  return getStore().jobs.get(id) ?? null;
}

export function listChatJobs(): ChatJobSnapshot[] {
  return [...getStore().jobs.values()]
    .map((job) => job.snapshot())
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export function listRunningChatJobs(): ChatJobSnapshot[] {
  return listChatJobs().filter((job) => job.status === "running");
}

export function createChatJobStream(
  job: ChatJob,
  input: { signal?: AbortSignal; afterSeq?: number } = {},
): ReadableStream<Uint8Array> {
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let abortHandler: (() => void) | null = null;

  const detach = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (abortHandler) {
      input.signal?.removeEventListener("abort", abortHandler);
      abortHandler = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        detach();
        controller.close();
      };

      const send = (event: SequencedChatSendEvent) => {
        if (closed || input.signal?.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        if (event.type === "done" || event.type === "error") close();
      };

      abortHandler = close;
      input.signal?.addEventListener("abort", abortHandler, { once: true });
      unsubscribe = job.subscribe(input.afterSeq ?? -1, send);
      if (job.status !== "running") queueMicrotask(close);
    },
    cancel() {
      // Navigating away should unsubscribe this HTTP stream only. The job keeps
      // running in the server process and can be reattached from /api/chat/jobs.
      closed = true;
      detach();
    },
  });
}
