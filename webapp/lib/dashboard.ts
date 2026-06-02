import "server-only";

import { listDir, readText, type WsKey } from "./files";
import { readGraphState } from "./graph";
import { lintLockExists } from "./lint-lock";

export type LogEntry = {
  timestamp: string;
  op: string;
  title: string;
};

export type DashboardData = {
  raw: {
    totalFiles: number;
    unprocessed: number;
  };
  wiki: {
    sources: number;
    pages: number;
  };
  graph: {
    status: "missing" | "partial-only" | "ready" | "invalid";
    nodes: number;
    edges: number;
    communities: number;
    updatedAt: string | null;
  };
  lint: {
    latest: string | null;
    locked: boolean;
  };
  recentLog: LogEntry[];
  generatedAt: string;
};

/**
 * `wiki/log.md`의 append-only 항목을 파싱한다. 항목 헤딩은
 * `## [YYYY-MM-DD HH:MM] <op> | <title>` 형태이며, 가장 최근(파일 하단)
 * 항목부터 limit개를 반환한다.
 */
export function parseRecentLog(text: string, limit = 6): LogEntry[] {
  const headingRe = /^##\s*\[([^\]]+)\]\s*(.*)$/;
  const entries: LogEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = headingRe.exec(rawLine.trim());
    if (!match) continue;
    const timestamp = match[1].trim();
    const rest = match[2].trim();
    // Skip the format-example heading in log.md's preamble, e.g.
    // "## [YYYY-MM-DD HH:MM] ingest | query | lint | graph | <title>".
    if (/YYYY|HH:MM/.test(timestamp) || /<[a-z ]+>/i.test(rest)) continue;
    const parts = rest
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
    const op = parts[0] ?? "";
    const title = parts.length > 1 ? parts.slice(1).join(" | ") : "";
    entries.push({ timestamp, op, title });
  }
  return entries.slice(-limit).reverse();
}

/**
 * raw 상대 경로를 그에 대응하는 source 페이지 상대 경로(wiki/sources 기준)로
 * 변환한다. 확장자는 `.md`로 바뀌고 논리적 디렉토리 구조는 보존된다.
 * 예: `articles/foo.pdf` -> `articles/foo.md`.
 */
export function expectedSourcePath(rawRel: string): string {
  const noExt = rawRel.replace(/\.[^./]+$/, "");
  return `${noExt}.md`;
}

/**
 * source 페이지가 아직 없는 raw 파일 수를 센다. `.trash/`, 점(.)으로 시작하는
 * 파일은 제외한다. 디렉토리 단위 요약(`<dir>/index.md`)도 처리된 것으로 본다.
 *
 * @param rawRels raw 루트 기준 상대 경로 목록
 * @param sourceRels wiki/sources 기준 상대 경로 목록
 */
export function countUnprocessedRaw(
  rawRels: string[],
  sourceRels: string[],
): number {
  const sources = new Set(sourceRels);
  let count = 0;
  for (const rel of rawRels) {
    if (rel === ".trash" || rel.startsWith(".trash/")) continue;
    const base = rel.split("/").pop() ?? rel;
    if (base.startsWith(".")) continue;
    const expected = expectedSourcePath(rel);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const dirIndex = dir ? `${dir}/index.md` : "index.md";
    if (sources.has(expected) || sources.has(dirIndex)) continue;
    count += 1;
  }
  return count;
}

/** listDir을 재귀적으로 돌아 파일 경로(ws 루트 기준)를 모은다. */
async function walkFiles(
  ws: WsKey,
  rel: string,
  shouldSkip: (path: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const entries = await listDir(ws, rel);
  for (const entry of entries) {
    if (shouldSkip(entry.path)) continue;
    if (entry.kind === "dir") {
      out.push(...(await walkFiles(ws, entry.path, shouldSkip)));
    } else {
      out.push(entry.path);
    }
  }
  return out;
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function readTextSafe(ws: WsKey, rel: string): Promise<string | null> {
  try {
    return await readText(ws, rel);
  } catch {
    return null;
  }
}

/** 최신 lint 리포트 파일명(`YYYY-MM-DD.md`)을 반환한다. */
async function latestLintReport(): Promise<string | null> {
  const entries = await listDir("wiki", "lint").catch(() => []);
  const reports = entries
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  return reports.at(-1) ?? null;
}

/** 대시보드 카드 한 화면에 필요한 현황을 한 객체로 집계한다. */
export async function collectDashboard(): Promise<DashboardData> {
  const rawFiles = await walkFiles("raw", "", (path) =>
    path === ".trash" || path.startsWith(".trash/"),
  ).catch(() => [] as string[]);

  const wikiFiles = await walkFiles("wiki", "", (path) =>
    path === "archive" || path.startsWith("archive/"),
  ).catch(() => [] as string[]);

  const sourceRels = wikiFiles
    .filter((path) => path.startsWith("sources/") && path.endsWith(".md"))
    .map((path) => stripPrefix(path, "sources/"))
    .filter((rel) => rel !== "index.md");

  const wikiPages = wikiFiles.filter((path) => path.endsWith(".md")).length;

  const [graphState, lintLocked, latestLint, logText] = await Promise.all([
    readGraphState().catch(() => null),
    lintLockExists().catch(() => false),
    latestLintReport(),
    readTextSafe("wiki", "log.md"),
  ]);

  return {
    raw: {
      totalFiles: rawFiles.filter((path) => {
        const base = path.split("/").pop() ?? path;
        return !base.startsWith(".");
      }).length,
      unprocessed: countUnprocessedRaw(rawFiles, sourceRels),
    },
    wiki: {
      sources: sourceRels.length,
      pages: wikiPages,
    },
    graph: {
      status: graphState?.status ?? "missing",
      nodes: graphState?.graph?.nodes.length ?? 0,
      edges: graphState?.graph?.edges.length ?? 0,
      communities: graphState?.graph?.communities.length ?? 0,
      updatedAt: graphState?.updatedAt ?? null,
    },
    lint: {
      latest: latestLint,
      locked: lintLocked,
    },
    recentLog: logText ? parseRecentLog(logText, 6) : [],
    generatedAt: new Date().toISOString(),
  };
}
