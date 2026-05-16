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

export type ChatProgress = {
  summary: string | null;
  active: string | null;
  log: ChatProgressLog[];
  updated: string;
};
