import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { RAW_CHAT_ROOT } from "./paths";
import { readSession, slugify } from "./sessions";

export type ChatCaptureRef = {
  path: string;
  title: string;
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function escapeYaml(value: string): string {
  if (!value) return '""';
  if (/[:#\n"'[\]{}]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

function previousUserPrompt(
  messages: Awaited<ReturnType<typeof readSession>>["messages"],
  messageIndex: number,
): string | null {
  for (let i = messageIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i].content.trim()) {
      return messages[i].content.trim();
    }
  }
  return null;
}

function renderCapture(input: {
  title: string;
  capturedAt: Date;
  sessionPath: string;
  messageIndex: number;
  role: string;
  agent: string | null;
  prompt: string | null;
  content: string;
}): string {
  const capturedAt = input.capturedAt.toISOString();
  const frontmatter = [
    "---",
    `title: ${escapeYaml(input.title)}`,
    "type: external-capture",
    "source_context: chat",
    `captured_at: ${capturedAt}`,
    `session: ${escapeYaml(`sessions/${input.sessionPath}`)}`,
    `message_index: ${input.messageIndex}`,
    `role: ${input.role}`,
    `agent: ${escapeYaml(input.agent ?? "")}`,
    "ingest_status: pending",
    "tags: [chat-capture]",
    "---",
    "",
  ].join("\n");

  const lines = [
    `# ${input.title}`,
    "",
    "## Context",
    "",
    `- session: \`sessions/${input.sessionPath}\``,
    `- message_index: ${input.messageIndex}`,
    `- captured_at: ${capturedAt}`,
    input.agent ? `- agent: ${input.agent}` : "- agent: unknown",
    "",
  ];

  if (input.prompt) {
    lines.push("## User Prompt", "", input.prompt, "");
  }

  lines.push("## Captured Content", "", input.content.trim(), "");
  return frontmatter + lines.join("\n");
}

export async function saveChatCapture(input: {
  sessionPath: string;
  messageIndex: number;
  title?: string;
}): Promise<ChatCaptureRef> {
  const { meta, messages } = await readSession(input.sessionPath);
  const message = messages[input.messageIndex];
  if (!message) {
    throw new Error(`message not found: ${input.messageIndex}`);
  }
  if (message.role !== "assistant") {
    throw new Error("only assistant messages can be saved as chat captures");
  }
  if (!message.content.trim()) {
    throw new Error("message is empty");
  }

  const capturedAt = new Date();
  const date = formatDate(capturedAt);
  const sessionSlug =
    slugify(meta.title) ||
    slugify(path.basename(input.sessionPath, ".md")) ||
    "untitled";
  const title = (input.title?.trim() || `${meta.title} capture`).slice(0, 120);
  const prompt = previousUserPrompt(messages, input.messageIndex);
  const body = renderCapture({
    title,
    capturedAt,
    sessionPath: input.sessionPath,
    messageIndex: input.messageIndex,
    role: message.role,
    agent: message.agent ?? meta.agent,
    prompt,
    content: message.content,
  });

  const baseName = `${formatTime(capturedAt)}-message-${String(
    input.messageIndex + 1,
  ).padStart(3, "0")}`;
  const dirAbs = path.join(RAW_CHAT_ROOT, date, sessionSlug);
  await fs.mkdir(dirAbs, { recursive: true });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const fileName = `${baseName}${suffix}.md`;
    const abs = path.join(dirAbs, fileName);
    try {
      await fs.writeFile(abs, body, { encoding: "utf8", flag: "wx" });
      const rel = path.posix.join("raw", "chat", date, sessionSlug, fileName);
      return { path: rel, title };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  throw new Error("could not create a unique chat capture filename");
}
