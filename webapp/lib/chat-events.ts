import type { ChatMessage } from "@/components/chat/types";

export type ChatKind =
  | "chat"
  | "ingest"
  | "ingest-loop"
  | "preprocess"
  | "query"
  | "lint"
  | "graph";

export type ChatJobStatus = "running" | "done" | "error";

export type ChatJobSnapshot = {
  id: string;
  sessionPath: string;
  kind: ChatKind;
  agent: string;
  status: ChatJobStatus;
  started: string;
  updated: string;
};

export type ChatSendEvent =
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

export type SequencedChatSendEvent = ChatSendEvent & {
  jobId: string;
  seq: number;
};
