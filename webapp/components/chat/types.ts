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
