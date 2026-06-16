import "server-only";

import { listDir, readText, type WsKey } from "./files";
import { readGraphStats } from "./graph";
import { lintLockExists } from "./lint-lock";
import { loadConfig } from "./config";
import { readRuntimeState as readAutoIngestRuntime } from "./auto-ingest/runtime-state";
import { readRuntimeState as readAutoLintRuntime } from "./auto-lint/runtime-state";
import { readAutomationRuntime } from "./automation/runtime-state";

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
    issues: LintCounts | null;
  };
  autonomous: AutonomousStatus;
  recentLog: LogEntry[];
  generatedAt: string;
};

export type JobRunStatus = "idle" | "running" | "skipped" | "disabled";

export type AutonomousStatus = {
  autoIngest: {
    enabled: boolean;
    status: JobRunStatus;
    mode: "watch" | "schedule" | null;
    reason: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastHalt: string | null;
  };
  autoLint: {
    enabled: boolean;
    status: JobRunStatus;
    reason: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    suggested: boolean;
    counter: { value: number; threshold: number };
  };
  automation: {
    enabled: boolean;
    jobs: AutomationJobStatus[];
  };
};

export type AutomationJobStatus = {
  id: string;
  name: string;
  enabled: boolean;
  status: JobRunStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export type LintCounts = {
  todo: number;
  done: number;
  warnings: number;
};

/**
 * Heuristic counts from a lint report: open checklist items (`- [ ]`), resolved
 * items (`- [x]`), and warning markers (⚠️). Format-agnostic on purpose.
 */
export function parseLintCounts(text: string): LintCounts {
  const todo = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  const warnings = (text.match(/⚠️|⚠/gu) ?? []).length;
  return { todo, done, warnings };
}

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
  const entries = await listDir(ws, rel);
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (shouldSkip(entry.path)) continue;
    if (entry.kind === "dir") subdirs.push(entry.path);
    else files.push(entry.path);
  }
  // Recurse into sibling directories concurrently; on a network share the
  // per-directory listDir latency dominates, so fanning out cuts wall time.
  const nested = await Promise.all(
    subdirs.map((dir) => walkFiles(ws, dir, shouldSkip)),
  );
  for (const group of nested) files.push(...group);
  return files;
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

/** 자율 작업(auto-ingest / auto-lint / automation)의 런타임 상태를 모은다. */
async function collectAutonomous(): Promise<AutonomousStatus> {
  const [cfg, ingest, lint, automation] = await Promise.all([
    loadConfig().catch(() => null),
    readAutoIngestRuntime().catch(() => null),
    readAutoLintRuntime().catch(() => null),
    readAutomationRuntime().catch(() => null),
  ]);

  const automationCfg = cfg?.automation;
  const jobs: AutomationJobStatus[] = (automationCfg?.jobs ?? []).map((job) => {
    const rt = automation?.jobs?.[job.id];
    return {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      status: (rt?.status ?? (job.enabled ? "idle" : "disabled")) as JobRunStatus,
      nextRunAt: rt?.nextRunAt ?? null,
      lastRunAt: rt?.lastRunAt ?? null,
    };
  });

  return {
    autoIngest: {
      enabled: cfg?.autoIngest.enabled ?? false,
      status: (ingest?.status ?? "disabled") as JobRunStatus,
      mode: ingest?.mode ?? null,
      reason: ingest?.reason ?? null,
      nextRunAt: ingest?.nextRunAt ?? null,
      lastRunAt: ingest?.lastRunAt ?? null,
      lastHalt: ingest?.lastResult?.halt ?? null,
    },
    autoLint: {
      enabled: cfg?.autoLint.enabled ?? false,
      status: (lint?.status ?? "disabled") as JobRunStatus,
      reason: lint?.reason ?? null,
      nextRunAt: lint?.nextRunAt ?? null,
      lastRunAt: lint?.lastRunAt ?? null,
      suggested: lint?.counter.suggested ?? false,
      counter: {
        value: lint?.counter.value ?? 0,
        threshold: lint?.counter.threshold ?? 10,
      },
    },
    automation: {
      enabled: automationCfg?.enabled ?? false,
      jobs,
    },
  };
}

/**
 * Short in-process cache. The dashboard auto-refreshes every 30s and several
 * clients may poll at once; the two recursive `raw/`+`wiki/` walks are the
 * expensive part, so a brief shared cache collapses that to one scan without
 * making the view feel stale.
 */
const DASHBOARD_CACHE_MS = 5_000;
let dashboardCache: { expiresAt: number; value: Promise<DashboardData> } | null =
  null;

/** 대시보드 카드 한 화면에 필요한 현황을 한 객체로 집계한다. */
export async function collectDashboard(): Promise<DashboardData> {
  if (dashboardCache && dashboardCache.expiresAt > Date.now()) {
    return dashboardCache.value;
  }
  const value = computeDashboard();
  value.catch(() => {
    if (dashboardCache?.value === value) dashboardCache = null;
  });
  dashboardCache = { expiresAt: Date.now() + DASHBOARD_CACHE_MS, value };
  return value;
}

async function computeDashboard(): Promise<DashboardData> {
  const [rawFiles, wikiFiles, graphStats, lintLocked, latestLint, logText, autonomous] =
    await Promise.all([
      walkFiles("raw", "", (p) => p === ".trash" || p.startsWith(".trash/")).catch(
        () => [] as string[],
      ),
      walkFiles("wiki", "", (p) => p === "archive" || p.startsWith("archive/")).catch(
        () => [] as string[],
      ),
      readGraphStats().catch(() => null),
      lintLockExists().catch(() => false),
      latestLintReport(),
      readTextSafe("wiki", "log.md"),
      collectAutonomous(),
    ]);

  const sourceRels = wikiFiles
    .filter((path) => path.startsWith("sources/") && path.endsWith(".md"))
    .map((path) => stripPrefix(path, "sources/"))
    .filter((rel) => rel !== "index.md");

  const wikiPages = wikiFiles.filter((path) => path.endsWith(".md")).length;

  const lintText = latestLint
    ? await readTextSafe("wiki", `lint/${latestLint}`)
    : null;

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
      status: graphStats?.status ?? "missing",
      nodes: graphStats?.nodes ?? 0,
      edges: graphStats?.edges ?? 0,
      communities: graphStats?.communities ?? 0,
      updatedAt: graphStats?.updatedAt ?? null,
    },
    lint: {
      latest: latestLint,
      locked: lintLocked,
      issues: lintText ? parseLintCounts(lintText) : null,
    },
    autonomous,
    recentLog: logText ? parseRecentLog(logText, 6) : [],
    generatedAt: new Date().toISOString(),
  };
}
