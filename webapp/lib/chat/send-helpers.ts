/**
 * Pure helpers for the /api/chat/send route: chat-kind classification from the
 * message, the operation target/summary shown while a run starts, the
 * stopped/timed-out reply bodies, and the single-agent /query policy text.
 * No side effects — extracted from the route handler so they can be unit-tested
 * and keep the handler focused on orchestration.
 */

export const CHAT_KINDS = [
  "chat",
  "ingest",
  "ingest-loop",
  "preprocess",
  "query",
  "lint",
  "graph",
] as const;

export type ChatKindInput = (typeof CHAT_KINDS)[number];

export function shorten(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function formatCancelledReply(input: {
  kind: string;
  exitCode: number;
  durationMs: number;
}): string {
  return [
    "⛔ 사용자 Stop 요청으로 중단됨.",
    "",
    `- kind: ${input.kind}`,
    `- exitCode: ${input.exitCode}`,
    `- durationMs: ${input.durationMs}`,
    "- result: 실행 중이던 CLI 프로세스에 SIGTERM을 보냈고, 추가 에이전트 응답 생성은 건너뛰었습니다.",
  ].join("\n");
}

export function formatTimedOutReply(input: {
  kind: string;
  durationMs: number;
}): string {
  return [
    "⏱️ CLI 실행 시간이 설정된 제한을 초과해 중단되었습니다.",
    "",
    `- kind: ${input.kind}`,
    `- durationMs: ${input.durationMs}`,
    "- result: timeout 타이머가 실행 중이던 CLI 프로세스에 SIGTERM을 보냈습니다.",
    "- note: 기본 설정에서는 query timeout이 비활성화되어야 합니다. 이 메시지가 보이면 config/local.json의 cli.timeouts 값을 확인하세요.",
  ].join("\n");
}

export function inferKind(message: string): ChatKindInput {
  const head = message.trimStart().toLowerCase();
  if (head.startsWith("/ingest-loop")) return "ingest-loop";
  if (head.startsWith("/ingest")) return "ingest";
  if (head.startsWith("/preprocess")) return "preprocess";
  if (head.startsWith("/query")) return "query";
  if (head.startsWith("/lint")) return "lint";
  if (head.startsWith("wiki-graphify ")) return "graph";
  if (head.startsWith("/")) return "chat";
  return "query";
}

export function operationTargetFromMessage(
  kind: ChatKindInput,
  message: string,
): string {
  const trimmed = message.trim();
  if (kind === "lint") return "wiki/";
  if (kind === "graph") return "wiki/graph/";
  if (kind === "preprocess") {
    const target = trimmed.replace(/^\/preprocess\b/i, "").trim();
    return target || "raw/";
  }
  if (kind === "ingest" || kind === "ingest-loop") {
    const target = trimmed.replace(/^\/(?:ingest-loop|ingest)\b/i, "").trim();
    return target || "raw/";
  }
  return "wiki/";
}

export function initialOperationSummary(
  kind: ChatKindInput,
  target: string,
): string {
  if (kind === "lint") {
    return `lint 준비: ${target}의 링크, frontmatter, stale claim을 점검합니다.`;
  }
  if (kind === "ingest-loop") {
    return `ingest-loop 준비: ${target} leaf와 source coverage를 반복 정비합니다.`;
  }
  if (kind === "ingest") {
    return `ingest 준비: ${target} source page와 merge 상태를 정비합니다.`;
  }
  if (kind === "preprocess") {
    return `preprocess 준비: ${target} 노이즈 제거 계획을 점검합니다.`;
  }
  if (kind === "graph") {
    return `graph 준비: ${target} 그래프 산출물을 갱신합니다.`;
  }
  return `${kind} 준비: ${target}에서 필요한 증거를 확인합니다.`;
}

export function normalizeKind(
  message: string,
  requested?: ChatKindInput,
): ChatKindInput {
  const inferred = inferKind(message);
  if (!requested || requested === "chat") return inferred;
  return requested;
}

export function querySingleAgentPolicy(): string {
  return [
    "This request is a single-agent /query operation.",
    "Follow the LLM Wiki query pattern: answer from the persistent compiled wiki, not by treating raw documents or search snippets as one-off RAG chunks.",
    "Use wiki-query: infer the user's intent, plan the investigation, read wiki/index.md first, select candidate pages, use available read-only retrieval/context tools such as wiki-search-qmd or wiki-graphify when useful, and read the evidence before answering.",
    "Do not merely return search hits, excerpts, candidate pages, or tool output. Synthesize the evidence into an answer tailored to the user's actual question, with a clear conclusion first when possible.",
    "If the question is a code/API/troubleshooting question, prioritize wiki/code pages and targeted read-only raw/ searches only when the Code Wiki is insufficient.",
    "If the question requires current external facts or a tool outside wiki-query, first check what tools are available in this CLI context and use only read-only tools. Clearly separate external facts from wiki-grounded facts and link or cite only sources that are actually necessary for the answer.",
    "Do not append a sources/references/candidate-pages section just because you inspected wiki/index.md or retrieval helpers. Mention or link wiki pages only when the answer materially relies on them and the link helps the user.",
    "Treat wiki/index.md, wiki/log.md, sessions, progress files, and candidate-page lists as internal navigation unless the user specifically asks about those files.",
    "Do not modify raw/. Only create or edit wiki/answers, wiki/index.md, or wiki/log.md when the user explicitly requested --save or clearly consents to saving the answer. If the answer contains a reusable synthesis, end with a concise save suggestion instead of writing files without consent.",
    "Korean Markdown is a good default for structured query answers. For simple questions, answer briefly without unnecessary sections. Keep any plan summary concise and user-facing; do not expose private chain-of-thought.",
  ].join("\n");
}
