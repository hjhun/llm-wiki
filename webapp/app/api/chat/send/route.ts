import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { CLI_NAMES, runCli, type CliName } from "@/lib/cli";
import {
  appendMessage,
  newSession,
  readSession,
  slugify,
} from "@/lib/sessions";

const Body = z.object({
  sessionPath: z.string().min(1).optional(),
  message: z.string().min(1).max(20000),
  agent: z.enum(["codex", "claude", "gemini", "cline"]).nullable().optional(),
});

const TIMEOUT_MS = 5 * 60 * 1000; // 5분

function shorten(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  const cfg = await loadConfig();
  const agent: CliName | null =
    parsed.data.agent === undefined
      ? (cfg.agent.default as CliName | null)
      : (parsed.data.agent as CliName | null);
  if (!agent) {
    return jsonError(
      "기본 코딩 에이전트가 지정되지 않았습니다. Settings에서 골라주세요.",
      400,
    );
  }
  if (!CLI_NAMES.includes(agent)) {
    return jsonError(`unknown agent: ${agent}`, 400);
  }

  // 세션이 없으면 첫 메시지를 기준으로 새 세션 생성.
  let sessionPath = parsed.data.sessionPath;
  if (!sessionPath) {
    const subject = shorten(parsed.data.message, 60) || "untitled";
    const ref = await newSession({ subject, agent });
    sessionPath = ref.path;
  }

  // 사용자 메시지 append
  try {
    await appendMessage(sessionPath, "user", parsed.data.message);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }

  // 컨텍스트 = 세션 md 전체를 다시 읽어 CLI에 그대로 전달 (stateless 호환).
  // CLI는 cwd를 PROJECT_ROOT로 받으므로 CLAUDE.md/AGENTS.md/.agents/skills를 직접 읽을 수 있다.
  let promptBody: string;
  try {
    const session = await readSession(sessionPath);
    const lines = session.messages.map((m) => {
      const tag =
        m.role === "user"
          ? "User"
          : m.role === "assistant"
            ? `Assistant${m.agent ? ` (${m.agent})` : ""}`
            : "System";
      return `${tag} [${m.ts}]:\n${m.content}`;
    });
    promptBody = lines.join("\n\n----\n\n");
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }

  const prompt = [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md in this repository and follow the .agents/skills/ that match the user's intent.",
    `Active session log: sessions/${sessionPath}`,
    "Below is the running conversation. Continue it by writing the assistant's next reply only — no preamble, no markdown frontmatter.",
    "",
    "===== CONVERSATION =====",
    promptBody,
    "",
    "Respond now as the assistant.",
  ].join("\n");

  try {
    const result = await runCli(agent, prompt, {
      safeMode: cfg.agent.safeMode,
      timeoutMs: TIMEOUT_MS,
    });
    const reply =
      (result.stdout.trim() || result.stderr.trim()) ||
      `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;

    const assistantMsg = await appendMessage(
      sessionPath,
      "assistant",
      reply,
      agent,
    );
    return NextResponse.json({
      sessionPath,
      assistant: assistantMsg,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  } catch (err) {
    const msg = errorMessage(err);
    // 실패도 로그로 남긴다 (사용자가 무엇이 잘못됐는지 보도록).
    await appendMessage(
      sessionPath,
      "system",
      `❌ CLI 호출 실패: ${msg}`,
    ).catch(() => undefined);
    return jsonError(msg, 500);
  }
}
