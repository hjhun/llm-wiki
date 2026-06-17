import path from "node:path";
import { existsSync } from "node:fs";

/**
 * 위키 저장소 루트를 자동 탐지한다.
 *
 * 우선순위:
 *   1) 환경변수 PROJECT_ROOT
 *   2) cwd부터 부모로 거슬러 올라가며 `llm-wiki.md` 또는 `CLAUDE.md`가
 *      있는 디렉토리를 찾음. webapp/에서 실행되어도 정상 동작.
 *   3) fallback: process.cwd()
 */
function detectProjectRoot(): string {
  if (process.env.PROJECT_ROOT) {
    return path.resolve(process.env.PROJECT_ROOT);
  }
  const markers = ["llm-wiki.md", "CLAUDE.md"];
  let cur = path.resolve(process.cwd());
  while (true) {
    if (markers.some((m) => existsSync(path.join(cur, m)))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = detectProjectRoot();

export const RAW_ROOT = path.join(PROJECT_ROOT, "raw");
export const RAW_CHAT_ROOT = path.join(RAW_ROOT, "chat");
export const WIKI_ROOT = path.join(PROJECT_ROOT, "wiki");
export const PROGRESS_ROOT = path.join(PROJECT_ROOT, "progress");
export const SESSIONS_ROOT = path.join(PROJECT_ROOT, "sessions");
export const TOOLS_ROOT = path.join(PROJECT_ROOT, "tools");
export const CONFIG_ROOT = path.join(PROJECT_ROOT, "config");
export const SKILLS_ROOT = path.join(PROJECT_ROOT, ".agents", "skills");

export const CONFIG_DEFAULT_PATH = path.join(CONFIG_ROOT, "default.json");
export const CONFIG_LOCAL_PATH = path.join(CONFIG_ROOT, "local.json");
export const CLI_DETECTED_PATH = path.join(CONFIG_ROOT, "cli-detected.json");
export const CLI_RUNTIME_DETECTED_PATH = path.join(
  CONFIG_ROOT,
  "cli-runtime-detected.json",
);

export const WIKI_INDEX_PATH = path.join(WIKI_ROOT, "index.md");
export const WIKI_LOG_PATH = path.join(WIKI_ROOT, "log.md");
export const WIKI_GRAPH_PATH = path.join(WIKI_ROOT, "graph", "graph.json");
export const WIKI_GRAPH_REPORT_PATH = path.join(
  WIKI_ROOT,
  "graph",
  "GRAPH_REPORT.md",
);

/**
 * Explorer / Chat / Graph가 접근할 수 있는 워크스페이스 루트 화이트리스트.
 * 이 목록 밖의 경로는 모든 파일 IO에서 거부된다.
 */
export const WORKSPACE_ROOTS = {
  wiki: WIKI_ROOT,
  raw: RAW_ROOT,
  progress: PROGRESS_ROOT,
  sessions: SESSIONS_ROOT,
} as const;

export type WorkspaceKey = keyof typeof WORKSPACE_ROOTS;

/**
 * 사용자 입력 경로가 워크스페이스 안에 있는지 검증.
 * 디렉토리 트래버설(`..`)·심볼릭 링크 탈출을 막는다.
 */
export function resolveSafe(
  workspace: WorkspaceKey,
  relative: string,
): string {
  const root = WORKSPACE_ROOTS[workspace];
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(
      `path escapes workspace '${workspace}': ${relative}`,
    );
  }
  return resolved;
}
