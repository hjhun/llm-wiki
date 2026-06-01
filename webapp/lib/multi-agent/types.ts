/**
 * Shared data shapes for the multi-agent orchestrator. Extracted from
 * multi-agent.ts so the pure partition/util helpers can depend on the types
 * without importing the stateful orchestration module. multi-agent.ts
 * re-exports the public ones (OrchestratedKind, MultiAgentResult,
 * AgentProgressEvent).
 */

import type { CliName, RunResult } from "../cli";
import type { ChatKind, ChatSendEvent } from "../chat-events";

export type OrchestratedKind = Extract<
  ChatKind,
  "ingest" | "ingest-loop" | "lint"
>;

export type MultiAgentResult = {
  finalReply: string;
  lastExitCode: number;
  totalDurationMs: number;
  assistantAgent: string;
};

export type Worker = {
  index: number;
  id: string;
  name: string;
  glyph: string[];
  cli: CliName;
  role: string;
  detail: string;
  asciiTask: string;
  accent: string;
};

export type AgentProgressEvent = Extract<
  ChatSendEvent,
  { type: "progress"; phase: "agent" }
>;

export type WorkerRun = {
  worker: Worker;
  round: number;
  result: RunResult | null;
  error: string | null;
};

export type MissionProfile = {
  role: string;
  detail: string;
  asciiTask: string;
};
