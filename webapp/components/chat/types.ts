export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  ts: string;
  agent?: string;
  content: string;
};

export type SessionMeta = {
  title: string;
  agent: string | null;
  origin?: "chat" | "background";
  created: string;
  updated: string;
};

export type SessionRef = {
  path: string;
  meta: SessionMeta;
};

export type ChatProgressLog = {
  ts: string;
  op: string;
  detail: string;
};

export type ChatAgentProgressStatus =
  | "assigned"
  | "running"
  | "done"
  | "error"
  | "consolidating";

export type ChatAgentProgress = {
  agentId: string;
  name: string;
  role: string;
  detail: string;
  ascii?: string;
  status: ChatAgentProgressStatus;
  cli: string;
  round: number;
  durationMs?: number;
  accent?: string;
  updated: string;
};

export type ChatProgress = {
  summary: string | null;
  active: string | null;
  log: ChatProgressLog[];
  agents: ChatAgentProgress[];
  updated: string;
};
