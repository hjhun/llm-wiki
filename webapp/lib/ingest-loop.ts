import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  runCli,
  cliSupportsResume,
  type CliName,
  type SessionOption,
} from "./cli";
import type { Config } from "./config";
import { buildGraphifyPrompt } from "./graph";
import { runPostMergeMiniLint } from "./post-merge-lint";
import { maybeRefreshQmdIndex } from "./qmd";
import {
  PROJECT_ROOT,
  WIKI_GRAPH_PATH,
} from "./paths";
import { appendMessage } from "./sessions";
import { cleanCliText } from "./cli-output";
import { errorMessage } from "./api";
import {
  mergeParentBlocksScopeCompletion,
  normalizePosixPath,
  normalizeRawScope,
  pathMatchesScope,
  pathSegments,
} from "./ingest/scope";
import {
  CODE_EXTS,
  CODE_MANIFESTS,
  IGNORE_CODE_DIRS,
  collectLeafFiles,
  fileLooksLikeCode,
  fileLooksLikeRuntimeEvidence,
  inferLeafKind,
  isIgnoredCodePath,
} from "./ingest/leaf-classify";
import {
  leafMatchesScope,
  parseStateJsonActionable,
  summarizeIngestState,
} from "./ingest/state";
import {
  finalMaintenanceSkippedNote,
  graphIncrementalDecision,
  ingestFinalMaintenanceDecision,
} from "./ingest/graphify-decision";
import { bootstrapIngestProgress } from "./ingest/bootstrap";
import { reconcileWikiIndex } from "./ingest/index-reconcile";
import { runCliWithIngestLoopRetries } from "./ingest/cli-retry";
import {
  decideCompaction,
  compactionWindowFor,
} from "./ingest/compaction";
import {
  FINAL_GRAPH_SKIPPED_NOTE,
  LOOP_STAGNATION_LIMIT,
  buildLoopContinuationPrompt,
  decideIngestLoopFinalize,
  decideLoopHalt,
  formatStateSummary,
  ingestMadeProgress,
  ingestRoundAdvanced,
  newlyDoneLeaves,
  type IngestLoopFinalizePlan,
  type LoopDecision,
} from "./ingest/loop-decision";
import {
  EMPTY_SNAPSHOT,
  type ProgressScope,
  type ProgressSnapshot,
  type StateSummary,
} from "./ingest/types";
import {
  INGEST_PROGRESS_DASHBOARD_PATH,
  INGEST_PROGRESS_DIR,
  INGEST_PROGRESS_LEAVES_LOCK_DIR,
  INGEST_PROGRESS_LOCK_PATH,
  INGEST_PROGRESS_STATE_PATH,
  INGEST_PROGRESS_STOP_DIR,
  INGEST_PROGRESS_STOP_PATH,
  LEGACY_INGEST_PROGRESS_DIR,
} from "./ingest/progress-paths";

// Re-export the public ingest-loop surface that moved into ./ingest/* so
// existing `@/lib/ingest-loop` importers keep working unchanged.
export {
  normalizeRawScope,
  ingestMadeProgress,
  ingestRoundAdvanced,
  newlyDoneLeaves,
  decideLoopHalt,
  decideIngestLoopFinalize,
  FINAL_GRAPH_SKIPPED_NOTE,
  buildLoopContinuationPrompt,
  formatStateSummary,
  LOOP_STAGNATION_LIMIT,
  EMPTY_SNAPSHOT,
  summarizeIngestState,
};
export type {
  StateSummary,
  ProgressSnapshot,
  ProgressScope,
  LoopDecision,
  IngestLoopFinalizePlan,
};

export const PROGRESS_DASHBOARD_PATH = INGEST_PROGRESS_DASHBOARD_PATH;
export const PROGRESS_STATE_PATH = INGEST_PROGRESS_STATE_PATH;
export const PROGRESS_STOP_PATH = INGEST_PROGRESS_STOP_PATH;
export const PROGRESS_STOP_DIR = INGEST_PROGRESS_STOP_DIR;
export const PROGRESS_LOCK_PATH = INGEST_PROGRESS_LOCK_PATH;
export const PROGRESS_LEAVES_LOCK_DIR = INGEST_PROGRESS_LEAVES_LOCK_DIR;
export const WIKI_LOG_REL = "wiki/log.md";
export const WIKI_INDEX_REL = "wiki/index.md";

let progressMigrationPromise: Promise<void> | null = null;

export async function ensureIngestProgressMigrated(): Promise<void> {
  if (progressMigrationPromise) return progressMigrationPromise;
  progressMigrationPromise = (async () => {
    const nextAbs = path.join(PROJECT_ROOT, INGEST_PROGRESS_DIR);
    const legacyAbs = path.join(PROJECT_ROOT, LEGACY_INGEST_PROGRESS_DIR);
    try {
      await fs.access(nextAbs);
      return;
    } catch {
      // New progress dir does not exist yet; migrate the legacy dir if present.
    }
    try {
      await fs.access(legacyAbs);
    } catch {
      return;
    }
    await fs.mkdir(path.dirname(nextAbs), { recursive: true });
    try {
      await fs.rename(legacyAbs, nextAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fs.cp(legacyAbs, nextAbs, { recursive: true, force: false });
      await fs.rm(legacyAbs, { recursive: true, force: true });
    }
  })();
  return progressMigrationPromise;
}

/**
 * Opaque liveness fingerprint of the ingest state. Combines the mtime+size of
 * the progress `.state.json` with the append-only `wiki/log.md`, the two files
 * the wiki-ingest skill touches on every real unit of work (a sub-chunk/leaf
 * status update, an enumeration that adds leaves, or the per-chunk log line).
 * The loop compares the signature before and after a worker round to tell
 * "the worker did something" from "the worker did nothing", independent of
 * whether a completion counter moved. See `ingestRoundAdvanced`.
 */
export async function ingestActivitySignature(): Promise<string> {
  await ensureIngestProgressMigrated();
  const parts: string[] = [];
  for (const rel of [PROGRESS_STATE_PATH, WIKI_LOG_REL]) {
    try {
      const st = await fs.stat(path.join(PROJECT_ROOT, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join("|");
}

export async function buildProgressReference(): Promise<string | null> {
  await ensureIngestProgressMigrated();
  try {
    const abs = path.join(PROJECT_ROOT, PROGRESS_DASHBOARD_PATH);
    const head = await fs.readFile(abs, "utf8");
    const lines = head.split(/\r?\n/).slice(0, 4).join("\n").trim();
    if (!lines) return null;
    return `Progress reference (${PROGRESS_DASHBOARD_PATH}):\n${lines}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

const ENTITY_REGISTRY_MAX = 400;
const CODE_STATUS_MAX = 20;
const RAW_CODE_SCAN_MAX_FILES = 5000;

function collectCodeOutputs(leaf: Record<string, unknown>): string[] {
  const outputs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) outputs.add(value.trim());
  };
  if (Array.isArray(leaf.code_outputs)) {
    for (const output of leaf.code_outputs) add(output);
  }
  if (Array.isArray(leaf.sub_chunks)) {
    for (const rawSc of leaf.sub_chunks) {
      const sc =
        rawSc && typeof rawSc === "object"
          ? (rawSc as Record<string, unknown>)
          : null;
      if (!sc || !Array.isArray(sc.code_outputs)) continue;
      for (const output of sc.code_outputs) add(output);
    }
  }
  return [...outputs];
}

function collectSourcePages(leaf: Record<string, unknown>): string[] {
  const outputs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) outputs.add(value.trim());
  };
  if (Array.isArray(leaf.source_pages_written)) {
    for (const output of leaf.source_pages_written) add(output);
  }
  if (Array.isArray(leaf.sub_chunks)) {
    for (const rawSc of leaf.sub_chunks) {
      const sc =
        rawSc && typeof rawSc === "object"
          ? (rawSc as Record<string, unknown>)
          : null;
      if (!sc || !Array.isArray(sc.source_pages_written)) continue;
      for (const output of sc.source_pages_written) add(output);
    }
  }
  return [...outputs];
}

// Per-file memo for source/code page frontmatter validation. readProgressSnapshot
// re-validates every recorded wiki page on each rebuild (≈ once per loop round),
// which means re-reading + regex-testing pages that have not changed. Keying the
// result on the page file's own mtime+size — the same invalidation signal used
// for the `.state.json` snapshot cache and the actionable-leaf cache — lets an
// unchanged page skip the read entirely and only pay a `stat`. The cache is
// bounded (LRU by Map insertion order) so it cannot leak memory on large wikis.
type FrontmatterTypeCacheEntry = {
  mtimeMs: number;
  size: number;
  result: string | null;
};
const frontmatterTypeCache = new Map<string, FrontmatterTypeCacheEntry>();
const FRONTMATTER_TYPE_CACHE_MAX = 2048;

async function validMarkdownFrontmatterType(
  relPath: string,
  typePattern: RegExp,
): Promise<string | null> {
  const rel = normalizePosixPath(relPath);
  const abs = path.resolve(PROJECT_ROOT, rel);
  const root = `${PROJECT_ROOT}${path.sep}`;
  if (abs !== PROJECT_ROOT && !abs.startsWith(root)) return null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    const key = `${abs} ${typePattern.source}`;
    const cached = frontmatterTypeCache.get(key);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.result;
    }
    const head = (await fs.readFile(abs, "utf8")).slice(0, 4096);
    const result =
      head.startsWith("---") && typePattern.test(head) ? rel : null;
    if (frontmatterTypeCache.size >= FRONTMATTER_TYPE_CACHE_MAX) {
      const oldest = frontmatterTypeCache.keys().next().value;
      if (oldest !== undefined) frontmatterTypeCache.delete(oldest);
    }
    frontmatterTypeCache.set(key, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      result,
    });
    return result;
  } catch {
    return null;
  }
}

function frontmatterHasTag(markdown: string, expected: string): boolean {
  if (!markdown.startsWith("---")) return false;
  const end = markdown.indexOf("\n---", 3);
  const frontmatter = end >= 0 ? markdown.slice(0, end) : markdown.slice(0, 4096);
  const inline = /\ntags:\s*\[([^\]]*)\]/m.exec(frontmatter);
  const inlineHasTag =
    inline?.[1]
      .split(",")
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
      .includes(expected) ?? false;
  const blockTagPattern = new RegExp(
    `^\\s*-\\s*["']?${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`,
    "m",
  );
  return inlineHasTag || blockTagPattern.test(frontmatter);
}

async function collectValidSourcePages(
  leaf: Record<string, unknown>,
): Promise<string[]> {
  const valid: string[] = [];
  for (const output of collectSourcePages(leaf)) {
    const rel = normalizePosixPath(output);
    if (!rel.startsWith("wiki/sources/") || !rel.endsWith(".md")) continue;
    const checked = await validMarkdownFrontmatterType(
      rel,
      /\ntype:\s*["']?source["']?\b/,
    );
    if (checked) valid.push(checked);
  }
  return valid;
}

async function collectValidCodeOutputs(
  leaf: Record<string, unknown>,
): Promise<string[]> {
  const valid: string[] = [];
  for (const output of collectCodeOutputs(leaf)) {
    const rel = normalizePosixPath(output);
    if (!rel.startsWith("wiki/code/") || !rel.endsWith(".md")) continue;
    const checked = await validMarkdownFrontmatterType(
      rel,
      /\ntype:\s*["']?(code|architecture)["']?\b/,
    );
    if (checked) valid.push(checked);
  }
  return valid;
}

async function collectValidCodeFileOutputs(
  leaf: Record<string, unknown>,
  codeFiles: string[],
): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const output of collectCodeOutputs(leaf)) {
    const rel = normalizePosixPath(output);
    if (!rel.startsWith("wiki/code/") || !rel.endsWith(".md")) {
      continue;
    }
    const checked = await validMarkdownFrontmatterType(
      rel,
      /\ntype:\s*["']?code["']?\b/,
    );
    if (!checked) continue;
    const abs = path.resolve(PROJECT_ROOT, checked);
    const body = await fs.readFile(abs, "utf8").catch(() => "");
    const isLegacyFilePage = rel.includes("/files/");
    const isMirroredFilePage =
      !rel.endsWith("/index.md") && frontmatterHasTag(body, "file");
    if (!isLegacyFilePage && !isMirroredFilePage) continue;
    for (const file of codeFiles) {
      if (body.includes(file)) covered.add(file);
    }
  }
  return covered;
}

async function collectValidCodeDirectoryIndexOutputs(
  leaf: Record<string, unknown>,
): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const output of collectCodeOutputs(leaf)) {
    const rel = normalizePosixPath(output);
    if (
      !rel.startsWith("wiki/code/") ||
      !rel.endsWith("/index.md")
    ) {
      continue;
    }
    const checked = await validMarkdownFrontmatterType(
      rel,
      /\ntype:\s*["']?code["']?\b/,
    );
    if (!checked) continue;
    const abs = path.resolve(PROJECT_ROOT, checked);
    const body = await fs.readFile(abs, "utf8").catch(() => "");
    if (!frontmatterHasTag(body, "directory")) continue;
    covered.add(checked);
  }
  return covered;
}

function projectNameForCodeFile(rawFile: string): string {
  const parts = normalizePosixPath(rawFile).split("/").filter(Boolean);
  if (parts[0] === "raw" && parts[1] === "repos" && parts[2]) return parts[2];
  if (parts[0] === "raw" && parts[1]) return parts[1];
  return "code";
}

function projectRelativeCodeFile(rawFile: string, project: string): string {
  const parts = normalizePosixPath(rawFile).split("/").filter(Boolean);
  if (parts[0] === "raw" && parts[1] === "repos" && parts[2] === project) {
    return parts.slice(3).join("/");
  }
  if (parts[0] === "raw" && parts[1] === project) {
    return parts.slice(2).join("/");
  }
  if (parts[0] === "raw" && parts[1] === "repos" && parts[2]) {
    return parts.slice(3).join("/");
  }
  if (parts[0] === "raw" && parts[1]) {
    return parts.slice(2).join("/");
  }
  return parts.join("/");
}

async function collectRawCodeFilesInScope(
  rawScope?: string | null,
): Promise<string[]> {
  const scope = normalizeRawScope(rawScope) ?? "raw";
  const rawRoot = path.resolve(PROJECT_ROOT, "raw");
  const startAbs = path.resolve(PROJECT_ROOT, scope);
  if (startAbs !== rawRoot && !startAbs.startsWith(`${rawRoot}${path.sep}`)) {
    return [];
  }

  const out = new Set<string>();
  const visitedDirs = new Set<string>();

  const walk = async (abs: string, rel: string): Promise<void> => {
    if (out.size >= RAW_CODE_SCAN_MAX_FILES) return;
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      const normalized = normalizePosixPath(rel);
      if (
        fileLooksLikeCode(normalized) ||
        fileLooksLikeRuntimeEvidence(normalized)
      ) {
        out.add(normalized);
      }
      return;
    }
    if (!st.isDirectory()) return;

    const dirName = path.posix.basename(normalizePosixPath(rel));
    if (IGNORE_CODE_DIRS.has(dirName)) return;

    try {
      const real = await fs.realpath(abs);
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);
    } catch {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= RAW_CODE_SCAN_MAX_FILES) break;
      if (entry.isDirectory() && IGNORE_CODE_DIRS.has(entry.name)) continue;
      await walk(path.join(abs, entry.name), `${rel}/${entry.name}`);
    }
  };

  await walk(startAbs, scope);
  return [...out].sort();
}

function expectedCodeDirectoryIndexPaths(
  leaf: Record<string, unknown>,
  codeFiles: string[],
): string[] {
  const expected = new Set<string>();
  const leafProject =
    typeof leaf.project === "string" && leaf.project.trim()
      ? normalizePosixPath(leaf.project.trim())
      : null;
  for (const file of codeFiles) {
    const project = leafProject ?? projectNameForCodeFile(file);
    const relFile = projectRelativeCodeFile(file, project);
    const dir = path.posix.dirname(relFile);
    expected.add(`wiki/code/${project}/index.md`);
    if (dir && dir !== ".") {
      const parts = dir.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) {
        expected.add(`wiki/code/${project}/${parts.slice(0, i).join("/")}/index.md`);
      }
    }
  }
  return [...expected].sort();
}

/**
 * Compact reference of existing entity/concept page names from wiki/index.md.
 * Injected into ingest worker prompts so parallel, stateless workers reuse
 * canonical page names and [[wikilinks]] instead of minting near-duplicates —
 * the root cause of duplicate, poorly connected graph nodes in multi-agent
 * runs.
 */
export async function buildEntityRegistryReference(): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(
      path.join(PROJECT_ROOT, WIKI_INDEX_REL),
      "utf8",
    );
  } catch {
    return null;
  }
  const names: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].toLowerCase();
      inSection = title.includes("entit") || title.includes("concept");
      continue;
    }
    if (!inSection) continue;
    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const name = m[1].split("|")[0].trim();
      if (name) names.push(name);
    }
  }
  if (names.length === 0) return null;
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = unique.slice(0, ENTITY_REGISTRY_MAX);
  const suffix =
    unique.length > ENTITY_REGISTRY_MAX
      ? ` … (+${unique.length - ENTITY_REGISTRY_MAX} more)`
      : "";
  return (
    `Existing entity/concept pages (${WIKI_INDEX_REL}) — before creating a ` +
    `new entity/concept page, reuse one of these exact names and its ` +
    `[[wikilink]] when it refers to the same target (incl. case/spacing/` +
    `language variants):\n` +
    shown.map((n) => `[[${n}]]`).join(", ") +
    suffix
  );
}

export async function buildCodeWikiStatusReference(
  options: ProgressScope = {},
): Promise<string | null> {
  const snap = await readProgressSnapshot(options);
  const scopeLabel = options.rawScope ? ` for ${options.rawScope}` : "";
  if (snap.codeLeavesTotal === 0) {
    if (snap.missingCodeFiles.length > 0) {
      return [
        `Code Wiki status${scopeLabel}: ${snap.missingCodeFiles.length} code-looking raw files are not represented in ${PROGRESS_STATE_PATH}.`,
        `Missing state coverage for: ${snap.missingCodeFiles.slice(0, CODE_STATUS_MAX).join(", ")}${snap.missingCodeFiles.length > CODE_STATUS_MAX ? ` … (+${snap.missingCodeFiles.length - CODE_STATUS_MAX} more)` : ""}`,
        "During enumeration, create leaf units for direct files in non-leaf directories as well as true leaf directories. Do not create per-file wiki/code pages as a completion requirement; code knowledge is materialized by the follow-up `wiki-graphify update` run.",
      ].join("\n");
    }
    return (
      `Code Wiki status${scopeLabel}: no code/mixed leaves are currently detected in ` +
      `${PROGRESS_STATE_PATH}. During enumeration, classify code leaves by ` +
      "filename/manifest and record `kind`, `project`, and the logical `raw/...` files or `graph_scope`."
    );
  }
  const missing = snap.missingCodeLeaves.slice(0, CODE_STATUS_MAX);
  const suffix =
    snap.missingCodeLeaves.length > CODE_STATUS_MAX
      ? ` … (+${snap.missingCodeLeaves.length - CODE_STATUS_MAX} more)`
      : "";
  const missingLine =
    missing.length > 0
      ? `Missing code leaf progress entries for: ${missing.join(", ")}${suffix}`
      : "All detected code/mixed leaves are represented in ingest progress.";
  return [
    `Code Wiki status${scopeLabel}: ${snap.codeLeavesWithOutputs}/${snap.codeLeavesTotal} code/mixed leaves are graph-ready after ingest.`,
    missingLine,
    snap.missingCodeFiles.length > 0
      ? `Code-looking raw files still missing from progress state: ${snap.missingCodeFiles.slice(0, CODE_STATUS_MAX).join(", ")}${snap.missingCodeFiles.length > CODE_STATUS_MAX ? ` … (+${snap.missingCodeFiles.length - CODE_STATUS_MAX} more)` : ""}`
      : "All detected code files are represented by ingest leaves or sub-chunks.",
    "For a done code/mixed leaf, do not repair by writing mirrored `wiki/code` file or directory pages. Finish the normal source-summary/merge work and rely on the separate `wiki-graphify update` invocation to create or refresh `wiki/graph/graph.json`, `GRAPH_REPORT.md`, and per-leaf graph parts from the code under `raw/`.",
  ].join("\n");
}

export async function buildSourcePageStatusReference(
  options: ProgressScope = {},
): Promise<string | null> {
  const snap = await readProgressSnapshot(options);
  const scopeLabel = options.rawScope ? ` for ${options.rawScope}` : "";
  if (snap.leavesTotal === 0) {
    return (
      `Source page status${scopeLabel}: no leaves are currently detected in ` +
      `${PROGRESS_STATE_PATH}. During enumeration, create one source summary ` +
      "page per original raw file and record it in `source_pages_written`."
    );
  }
  const missing = snap.missingSourceLeaves.slice(0, CODE_STATUS_MAX);
  const suffix =
    snap.missingSourceLeaves.length > CODE_STATUS_MAX
      ? ` … (+${snap.missingSourceLeaves.length - CODE_STATUS_MAX} more)`
      : "";
  return [
    `Source page status${scopeLabel}: ${snap.sourcePagesWritten}/${snap.filesTotal} raw files have recorded source pages.`,
    missing.length > 0
      ? `Missing source page coverage for done leaves: ${missing.join(", ")}${suffix}`
      : "All done leaves have recorded source page coverage.",
    "For a done leaf with missing source page coverage, treat the next unit of work as a source-page repair: write one raw-mirrored `wiki/sources/<raw-relative-path>.md` page per original raw file, then record those paths in the matching sub-chunk `source_pages_written` before reporting completion.",
  ].join("\n");
}

type ProgressSnapshotCacheEntry = {
  mtimeMs: number;
  size: number;
  scopeKey: string;
  snapshot: ProgressSnapshot;
};
const progressSnapshotCache = new Map<string, ProgressSnapshotCacheEntry>();
const PROGRESS_SNAPSHOT_CACHE_MAX = 8;

function progressSnapshotScopeKey(options: ProgressScope): string {
  const norm = normalizeRawScope(options.rawScope);
  return norm ?? "<root>";
}

export async function readProgressSnapshot(
  options: ProgressScope = {},
): Promise<ProgressSnapshot> {
  await ensureIngestProgressMigrated();
  const statePath = path.join(PROJECT_ROOT, PROGRESS_STATE_PATH);
  const scopeKey = progressSnapshotScopeKey(options);
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    stat = await fs.stat(statePath);
  } catch {
    // Fall through; the existing logic handles a missing state file by
    // returning EMPTY_SNAPSHOT from the catch below.
  }
  if (stat) {
    const cached = progressSnapshotCache.get(scopeKey);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.snapshot;
    }
  }
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      merge_pass?: { status?: unknown; pending_parents?: unknown };
      leaves?: Record<string, unknown>;
    };
    const doneLeaves: string[] = [];
    const filePaths = new Set<string>();
    const pendingParents = parsed.merge_pass?.pending_parents;
    const snap: ProgressSnapshot = {
      leavesTotal: 0,
      leavesDone: 0,
      sourcePagesMissing: 0,
      missingSourceLeaves: [],
      codeLeavesTotal: 0,
      codeLeavesWithOutputs: 0,
      codeLeavesMissingOutputs: 0,
      missingCodeLeaves: [],
      codeFilePagesTotal: 0,
      codeFilePagesWithOutputs: 0,
      codeFilePagesMissing: 0,
      missingCodeFiles: [],
      codeDirectoryIndexesTotal: 0,
      codeDirectoryIndexesWithOutputs: 0,
      codeDirectoryIndexesMissing: 0,
      missingCodeDirectories: [],
      codeOutputsWritten: 0,
      subChunksTotal: 0,
      subChunksDone: 0,
      filesTotal: 0,
      bytesTotal: 0,
      sourcePagesWritten: 0,
      mergeDone: parsed.merge_pass?.status === "done",
      mergePendingParents: Array.isArray(pendingParents)
        ? pendingParents.filter((parent) =>
            typeof parent === "string" &&
            mergeParentBlocksScopeCompletion(parent, options.rawScope),
          ).length
        : 0,
      doneLeaves,
    };
    if (parsed.leaves && typeof parsed.leaves === "object") {
      const stateCodeFiles = new Set<string>();
      for (const [leafPath, value] of Object.entries(parsed.leaves)) {
        const leaf = (value ?? {}) as Record<string, unknown>;
        if (leaf.status === "stale") continue;
        if (!leafMatchesScope(leafPath, leaf, options.rawScope)) continue;
        const leafKind = inferLeafKind(leafPath, leaf);
        const codeOutputs = await collectValidCodeOutputs(leaf);
        const validSourcePages = await collectValidSourcePages(leaf);
        const leafFiles = collectLeafFiles(leafPath, leaf).filter(
          (file) => !isIgnoredCodePath(file),
        );
        const codeFiles = leafFiles.filter(
          (file) => fileLooksLikeCode(file) || fileLooksLikeRuntimeEvidence(file),
        );
        for (const file of codeFiles) stateCodeFiles.add(file);
        snap.sourcePagesWritten += validSourcePages.length;
        const isCodeLeaf = leafKind === "code" || leafKind === "mixed";
        const sourceCoverageMissing =
          leaf.status === "done" &&
          leafKind !== "ignore" &&
          leafFiles.length > 0 &&
          validSourcePages.length < leafFiles.length;
        if (sourceCoverageMissing) {
          snap.sourcePagesMissing += 1;
          snap.missingSourceLeaves.push(leafPath);
        }
        if (isCodeLeaf) {
          snap.codeLeavesTotal += 1;
          snap.codeOutputsWritten += codeOutputs.length;
          snap.codeFilePagesTotal += codeFiles.length;
          snap.codeFilePagesWithOutputs += codeFiles.length;
          if (leaf.status === "done" || codeOutputs.length > 0) {
            snap.codeLeavesWithOutputs += 1;
          }
        }
        snap.leavesTotal += 1;
        if (leaf.status === "done") {
          snap.leavesDone += 1;
          doneLeaves.push(leafPath);
        }
        if (Array.isArray(leaf.sub_chunks)) {
          for (const rawSc of leaf.sub_chunks) {
            const sc =
              rawSc && typeof rawSc === "object"
                ? (rawSc as Record<string, unknown>)
                : null;
            if (!sc) continue;
            snap.subChunksTotal += 1;
            if (Array.isArray(sc.files)) {
              for (const filePath of sc.files) {
                if (typeof filePath === "string" && filePath) {
                  filePaths.add(filePath);
                }
              }
            }
            if (sc.status === "done") {
              snap.subChunksDone += 1;
            }
          }
        }
      }
      const rawCodeFiles = await collectRawCodeFilesInScope(options.rawScope);
      for (const file of rawCodeFiles) {
        filePaths.add(file);
        if (stateCodeFiles.has(file)) continue;
        snap.codeFilePagesTotal += 1;
        snap.codeFilePagesMissing += 1;
        snap.missingCodeFiles.push(file);
      }
    }
    doneLeaves.sort();
    snap.missingCodeLeaves.sort();
    snap.missingCodeFiles.sort();
    snap.missingCodeDirectories.sort();
    snap.missingSourceLeaves.sort();
    snap.filesTotal = filePaths.size;
    snap.bytesTotal = await totalRelativeFileBytes(filePaths);
    if (stat) {
      // Bound the cache so a flurry of scoped calls cannot leak memory; LRU
      // by insertion order via Map iteration.
      if (progressSnapshotCache.size >= PROGRESS_SNAPSHOT_CACHE_MAX) {
        const oldest = progressSnapshotCache.keys().next().value;
        if (oldest !== undefined) progressSnapshotCache.delete(oldest);
      }
      progressSnapshotCache.set(scopeKey, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        scopeKey,
        snapshot: snap,
      });
    }
    return snap;
  } catch {
    return { ...EMPTY_SNAPSHOT, doneLeaves: [] };
  }
}

async function totalRelativeFileBytes(filePaths: Iterable<string>): Promise<number> {
  let total = 0;
  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) continue;
    const abs = path.resolve(PROJECT_ROOT, normalized);
    const root = `${PROJECT_ROOT}${path.sep}`;
    if (abs !== PROJECT_ROOT && !abs.startsWith(root)) continue;
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) total += st.size;
    } catch {
      // Best-effort workload estimate; missing files simply do not count.
    }
  }
  return total;
}

export async function readIngestStateSummary(
  options: { sessionPath?: string; rawScope?: string | null } = {},
): Promise<StateSummary | null> {
  await ensureIngestProgressMigrated();
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    return summarizeIngestState(raw, options);
  } catch {
    return null;
  }
}

function sessionStopFlagAbs(sessionPath: string): string {
  const key = createHash("sha1").update(sessionPath).digest("hex");
  return path.join(PROJECT_ROOT, PROGRESS_STOP_DIR, `${key}.stop`);
}

function legacyStopFlagAbs(): string {
  return path.join(PROJECT_ROOT, PROGRESS_STOP_PATH);
}

export async function requestStopFlag(sessionPath: string): Promise<void> {
  await ensureIngestProgressMigrated();
  const abs = sessionStopFlagAbs(sessionPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    JSON.stringify({ sessionPath, requested_at: new Date().toISOString() }) +
      "\n",
    "utf8",
  );
}

export async function stopFlagExists(sessionPath?: string): Promise<boolean> {
  await ensureIngestProgressMigrated();
  try {
    await fs.access(
      sessionPath ? sessionStopFlagAbs(sessionPath) : legacyStopFlagAbs(),
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearStopFlag(sessionPath?: string): Promise<void> {
  await ensureIngestProgressMigrated();
  try {
    await fs.rm(
      sessionPath ? sessionStopFlagAbs(sessionPath) : legacyStopFlagAbs(),
      { force: true },
    );
  } catch {
    // Best-effort cleanup; the next loop run will overwrite or re-check it.
  }
}

/**
 * A lock is considered stale once its owning process is gone or it has simply
 * been held too long. The agent that writes the lock is expected to release it
 * on exit, but a crash, timeout, or hard kill (`killOnAbort`) can orphan one —
 * and because the auto-ingest skip check is a pure existence test, a single
 * orphaned lock would otherwise block every future trigger forever.
 *
 * `started_at` older than this (default ~60 min) is treated as stale even when
 * we cannot verify the pid (e.g. the lock was written by an agent on a
 * different host over a network share, where pid liveness is meaningless).
 */
const STALE_LOCK_MS = 60 * 60 * 1000;

type LockMeta = { pid?: number; started_at?: string };

/** ESRCH ⇒ no such process. EPERM ⇒ exists but not ours, i.e. alive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Decide whether a lock file is stale and, when it is, remove it. Returns true
 * when the lock is live (a real in-flight worker), false when it is absent or
 * was reaped. Conservative on purpose: a young lock whose pid we cannot resolve
 * (missing/foreign-host pid) is kept until the age TTL elapses.
 */
async function lockIsLive(absPath: string): Promise<boolean> {
  let meta: LockMeta = {};
  try {
    meta = JSON.parse(await fs.readFile(absPath, "utf8")) as LockMeta;
  } catch (err) {
    // Unreadable means it was just removed; an unparseable body falls back to
    // the file's age below.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
  }

  const startedMs = meta.started_at ? Date.parse(meta.started_at) : NaN;
  let ageMs = Number.isNaN(startedMs) ? NaN : Date.now() - startedMs;
  if (Number.isNaN(ageMs)) {
    // No usable started_at; fall back to the lock file's mtime.
    ageMs = await fs
      .stat(absPath)
      .then((st) => Date.now() - st.mtimeMs)
      .catch(() => 0);
  }

  const pidDead = typeof meta.pid === "number" && !isPidAlive(meta.pid);
  const tooOld = ageMs > STALE_LOCK_MS;
  if (pidDead || tooOld) {
    await fs.rm(absPath, { force: true }).catch(() => undefined);
    return false;
  }
  return true;
}

export async function lockFileExists(): Promise<boolean> {
  await ensureIngestProgressMigrated();
  // "Busy" under the two-tier lock model means either the global state mutex
  // is held (enumeration / state-write / merge-pass) OR at least one per-leaf
  // lock is held by an active worker. Both indicate an in-flight ingest.
  // Stale locks (dead owner / past the age TTL) are reaped here so a crashed
  // run cannot wedge auto-ingest indefinitely.
  const globalLock = path.join(PROJECT_ROOT, PROGRESS_LOCK_PATH);
  try {
    await fs.access(globalLock);
    if (await lockIsLive(globalLock)) return true;
  } catch {
    // global lock absent; fall through to per-leaf check
  }
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(PROJECT_ROOT, PROGRESS_LEAVES_LOCK_DIR));
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const abs = path.join(PROJECT_ROOT, PROGRESS_LEAVES_LOCK_DIR, name);
    if (await lockIsLive(abs)) return true;
  }
  return false;
}

/**
 * Cap on the number of actionable leaves returned per call. The list seeds a
 * round-robin partition across workers; loop rounds revisit the file later, so
 * we don't need every pending leaf in one shot. Keeping the cap small bounds
 * the streaming scan cost on multi-hundred-MB state files and bounds the
 * eventual prompt size per worker.
 */
const ACTIONABLE_SCAN_CAP = 200;

/**
 * Streaming-scan threshold. Files at or under this size go through
 * `JSON.parse` (cheap, exhaustive). Above it we switch to a regex-based
 * streaming scanner that early-exits after collecting `ACTIONABLE_SCAN_CAP`
 * actionable leaf paths.
 */
const STREAM_SCAN_THRESHOLD_BYTES = 16 * 1024 * 1024;

type ActionableCacheEntry = {
  mtimeMs: number;
  size: number;
  rawScope: string | null;
  data: string[] | null;
};
let actionableCache: ActionableCacheEntry | null = null;

/**
 * Stream-scan `state.json` for actionable leaf paths without loading the full
 * file into memory. Looks for the pattern `"raw/...": {` (always a leaf entry
 * in our state schema), walks the object body once to find its matching `}`
 * with proper string/escape handling, extracts the `status` field, and
 * collects leaf paths whose status is not done/stale/error.
 *
 * Stops as soon as `cap` entries are collected. With `cap = 200` and typical
 * per-leaf objects of ~1-3 KB, the scanner reads roughly the first MB of an
 * arbitrarily large state file. That keeps the API route responsive even at
 * multi-hundred-MB state sizes (a 278 MB file scans in <5 ms in practice).
 */
async function streamScanActionableLeaves(
  filePath: string,
  rawScope: string | null | undefined,
  cap: number,
): Promise<string[] | null> {
  const scope = rawScope ?? null;
  const normalizedScope = scope ? normalizeRawScope(scope) : null;
  const fileMod = await import("node:fs");
  return new Promise((resolve) => {
    const stream = fileMod.createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 256 * 1024,
    });
    let buf = "";
    const results: string[] = [];
    const seen = new Set<string>();
    let finished = false;
    const KEY_RE = /"(raw\/[^"]+\/)"\s*:\s*\{/g;
    const finish = (data: string[] | null) => {
      if (finished) return;
      finished = true;
      stream.destroy();
      resolve(data);
    };

    function processBuffer() {
      let cursor = 0;
      while (true) {
        KEY_RE.lastIndex = cursor;
        const m = KEY_RE.exec(buf);
        if (!m) break;
        const leafPath = m[1];
        // The opening brace lies at the end of the match (the last `{`).
        const objStart = m.index + m[0].length - 1;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = objStart;
        let closed = false;
        for (; j < buf.length; j += 1) {
          const c = buf[j];
          if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
          } else if (c === '"') {
            inStr = true;
          } else if (c === "{") {
            depth += 1;
          } else if (c === "}") {
            depth -= 1;
            if (depth === 0) {
              closed = true;
              break;
            }
          }
        }
        if (!closed) {
          // Incomplete object — wait for more data.
          break;
        }
        const objText = buf.slice(objStart, j + 1);
        cursor = j + 1;
        if (seen.has(leafPath)) continue;
        seen.add(leafPath);
        const statusMatch = /"status"\s*:\s*"([^"]+)"/.exec(objText);
        const status = statusMatch ? statusMatch[1] : "pending";
        if (status === "done" || status === "stale" || status === "error") continue;
        // The streaming path can't inspect each leaf's full file list cheaply,
        // so scope filtering uses the leaf path prefix only. JSON.parse path
        // still applies the exhaustive leafMatchesScope predicate.
        if (normalizedScope && !pathMatchesScope(leafPath, normalizedScope)) {
          continue;
        }
        results.push(leafPath);
        if (results.length >= cap) {
          finish([...results].sort());
          return;
        }
      }
      if (cursor > 0) buf = buf.slice(cursor);
    }

    stream.on("data", (chunkRaw: Buffer | string) => {
      if (finished) return;
      buf += typeof chunkRaw === "string" ? chunkRaw : chunkRaw.toString("utf8");
      processBuffer();
    });
    stream.on("end", () => {
      if (finished) return;
      processBuffer();
      finish([...results].sort());
    });
    stream.on("error", () => finish(null));
  });
}

/**
 * Read pending or partial leaf paths from `.state.json`, optionally filtered by
 * a raw-scope prefix. Returns `null` when the state file does not yet exist
 * (typical bootstrap before the first enumeration). Returns an empty array
 * when the file exists but no actionable leaves remain.
 *
 * Behaviour by file size:
 *   - up to STREAM_SCAN_THRESHOLD_BYTES: full JSON.parse (exhaustive).
 *   - above that:                       streaming scan capped at
 *                                       ACTIONABLE_SCAN_CAP entries.
 *
 * Results are memoized by (mtimeMs, size, rawScope). Subsequent calls on an
 * unchanged state file are O(1), so the loop pays the parse/scan cost only
 * once per actual state mutation.
 */
/**
 * Whether `wiki/.progress/ingest/.state.json` exists on disk. Used to word the
 * bootstrap-worker prompt precisely: `readActionableLeafPaths` returns `null`
 * both when the file is absent and when it holds no actionable leaf for the
 * scope, so the partition alone cannot tell those apart.
 */
export async function ingestStateFileExists(): Promise<boolean> {
  await ensureIngestProgressMigrated();
  try {
    await fs.stat(path.join(PROJECT_ROOT, PROGRESS_STATE_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function readActionableLeafPaths(
  rawScope?: string | null,
): Promise<string[] | null> {
  await ensureIngestProgressMigrated();
  const statePath = path.join(PROJECT_ROOT, PROGRESS_STATE_PATH);
  let stat: { mtimeMs: number; size: number };
  try {
    stat = await fs.stat(statePath);
  } catch {
    return null;
  }
  const scope = rawScope ?? null;
  if (
    actionableCache &&
    actionableCache.mtimeMs === stat.mtimeMs &&
    actionableCache.size === stat.size &&
    actionableCache.rawScope === scope
  ) {
    return actionableCache.data;
  }

  let data: string[] | null;
  if (stat.size <= STREAM_SCAN_THRESHOLD_BYTES) {
    let raw: string;
    try {
      raw = await fs.readFile(statePath, "utf8");
    } catch {
      return null;
    }
    data = parseStateJsonActionable(raw, scope);
  } else {
    data = await streamScanActionableLeaves(
      statePath,
      scope,
      ACTIONABLE_SCAN_CAP,
    );
    // No actionable leaf within scope is the bootstrap signal: promote `[]` to
    // `null` so the partition still grants worker 0 unrestricted scope to run
    // Step 1 enumeration (empty leaves map, an un-enumerated scope subtree, or a
    // changed-but-not-yet-rescanned scope). Matches parseStateJsonActionable.
    if (data != null && data.length === 0) data = null;
  }

  actionableCache = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    rawScope: scope,
    data,
  };
  return data;
}

export type GraphifyAction = "update";

export type MaybeAutoRunGraphifyInput = {
  cfg: Config;
  agent: CliName;
  sessionPath: string;
  signal?: AbortSignal;
  lastExitCode: number;
  before: ProgressSnapshot;
  after: ProgressSnapshot;
  mode: "incremental" | "final";
  onChunk?: (text: string) => void;
};

export type MaybeAutoRunGraphifyResult = {
  note: string;
  action: GraphifyAction | null;
  succeeded: boolean;
};

async function validateGraphifyArtifacts(
  snapshot: ProgressSnapshot,
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(WIKI_GRAPH_PATH, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? "`wiki/graph/graph.json`이 생성되지 않았습니다."
      : `\`wiki/graph/graph.json\`을 읽거나 파싱하지 못했습니다: ${errorMessage(err)}`;
  }
  const root =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  const nodes = Array.isArray(root?.nodes) ? root.nodes : null;
  const edges = Array.isArray(root?.edges)
    ? root.edges
    : Array.isArray(root?.links)
      ? root.links
      : null;
  if (!nodes || !edges) {
    return "`wiki/graph/graph.json` schema가 유효하지 않습니다: nodes 배열과 edges 또는 links 배열이 필요합니다.";
  }
  if (snapshot.sourcePagesWritten > 0 && nodes.length === 0) {
    return (
      "ingest가 source page를 생성했지만 graph update 결과가 빈 그래프입니다. " +
      "대상 leaf extraction 또는 merge pass를 다시 확인해야 합니다."
    );
  }
  return null;
}

export async function maybeAutoRunGraphify(
  input: MaybeAutoRunGraphifyInput,
): Promise<MaybeAutoRunGraphifyResult> {
  const noop: MaybeAutoRunGraphifyResult = {
    note: "",
    action: null,
    succeeded: true,
  };
  if (input.lastExitCode !== 0) return noop;
  if (!input.cfg.graph.autoUpdateOnIngest) return noop;
  if (!ingestMadeProgress(input.before, input.after)) return noop;

  const mergeJustDone = input.after.mergeDone && !input.before.mergeDone;
  const justDoneLeaves = newlyDoneLeaves(input.before, input.after);

  let action: GraphifyAction;
  let leafPaths: string[] | undefined;
  let progressLabel: string;

  if (input.mode === "final") {
    action = "update";
    progressLabel = mergeJustDone
      ? "merge pass 완료 + final merge"
      : `leaves ${input.after.leavesDone}/${
          input.before.leavesDone +
          (input.after.leavesDone - input.before.leavesDone)
        } · final merge`;
  } else if (mergeJustDone) {
    action = "update";
    progressLabel = "merge pass 완료";
  } else if (justDoneLeaves.length > 0) {
    const incrementalDecision = graphIncrementalDecision(input.cfg, input.after);
    if (!incrementalDecision.enabled) {
      return {
        note:
          `\n\n---\n\n[auto graph · scoped update skipped] ` +
          `${incrementalDecision.reason}; final \`wiki-graphify update\` will handle changed leaves.\n`,
        action: null,
        succeeded: true,
      };
    }
    action = "update";
    leafPaths = justDoneLeaves;
    progressLabel =
      `leaf 완료 ${justDoneLeaves.length}건 · scoped update + full merge · ` +
      incrementalDecision.reason;
  } else {
    return noop;
  }

  const commandLabel =
    leafPaths && leafPaths.length > 0
      ? `wiki-graphify ${action} (${leafPaths.join(", ")})`
      : `wiki-graphify ${action}`;

  await appendMessage(
    input.sessionPath,
    "system",
    `ingest 진행 감지 (${progressLabel}); auto-running ${commandLabel}`,
  );
  const graphPrompt = buildGraphifyPrompt(action, input.sessionPath, {
    leafPaths,
  });
  const note = `\n\n---\n\n[auto graph · ${progressLabel}] \`${commandLabel}\`를 별도 CLI 호출로 실행합니다.\n`;
  input.onChunk?.(note);

  const graphTimeout = input.cfg.cli.timeouts.graph;
  try {
    const graphResult = await runCli(input.agent, graphPrompt, {
      safeMode: input.cfg.agent.safeMode,
      timeoutMs: graphTimeout ?? undefined,
      signal: input.signal,
      killOnAbort: input.signal ? true : graphTimeout != null,
      onStdout: (chunk) => {
        input.onChunk?.(chunk);
      },
    });
    const graphReply =
      cleanCliText(graphResult.stdout).trim() ||
      cleanCliText(graphResult.stderr).trim() ||
      `(그래프 업데이트가 빈 응답을 반환했습니다. exitCode=${graphResult.exitCode})`;
    if (graphResult.exitCode !== 0) {
      return {
        note:
          `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
          `그래프 호출이 실패했습니다: exitCode=${graphResult.exitCode}\n\n${graphReply}`,
        action: null,
        succeeded: false,
      };
    }
    const validationError = await validateGraphifyArtifacts(input.after);
    if (validationError) {
      return {
        note:
          `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
          `${validationError}\n\n${graphReply}`,
        action: null,
        succeeded: false,
      };
    }
    return {
      note: `${note}\n\n---\n\n[auto graph result · ${commandLabel}]\n${graphReply}`,
      action,
      succeeded: true,
    };
  } catch (err) {
    const graphError = errorMessage(err);
    await appendMessage(
      input.sessionPath,
      "system",
      `❌ 자동 그래프 호출 실패 (${commandLabel}): ${graphError}`,
    ).catch(() => undefined);
    return {
      note:
        `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
        `ingest는 진행됐지만 자동 그래프 호출이 실패했습니다: ${graphError}`,
      action: null,
      succeeded: false,
    };
  }
}

export type RunIngestLoopInput = {
  cfg: Config;
  agent: CliName;
  sessionPath: string;
  /** Prompt used for the first iteration. Subsequent iterations build their own. */
  initialPrompt: string;
  /** Optional pre-built progress reference. The loop reads a fresh one for later iters. */
  progressRef?: string | null;
  /**
   * Leave an existing stop flag untouched. Auto-ingest uses this when it is
   * invoked while another ingest may own the flag, so it cannot erase a
   * user's "stop after current sub-chunk" request.
   */
  preserveStopFlag?: boolean;
  signal?: AbortSignal;
  /** Streams stdout chunks from the CLI back to the caller. */
  onChunk?: (text: string) => void;
  /** Optional raw/... scope for a targeted /ingest-loop run. */
  rawScope?: string | null;
};

export type RunIngestLoopResult = {
  finalReply: string;
  lastExitCode: number;
  totalDurationMs: number;
  iterations: number;
  haltKind: "normal" | "error" | "stopped" | "capped" | "stalled" | "empty";
  haltReason: string;
  loopBefore: ProgressSnapshot;
  loopAfter: ProgressSnapshot;
  /** True when at least one sub-chunk advanced during the loop. */
  anyProgress: boolean;
};

/**
 * Compact continuation prompt for the single ingest-loop agent resuming its OWN
 * warm CLI conversation across iterations. The operating instructions, the
 * wiki-ingest skill, and the session log were established earlier in the same
 * conversation, so they are deliberately not repeated — that is the point of
 * resume. Only per-iteration dynamics are sent: re-read the latest on-disk
 * state before acting, since the durable source of truth is the wiki +
 * progress files.
 */
function buildIngestLoopDeltaPrompt(input: {
  iteration: number;
  rawScope: string | null;
}): string {
  const scope = input.rawScope ?? "raw/";
  return [
    `Continue this resumed /ingest-loop session — iteration ${input.iteration}.`,
    "Your earlier operating instructions, the wiki-ingest skill, the operation policy, and the active session log from THIS same conversation still apply. Do not reload or restate them.",
    `Before writing, re-read the latest on disk yourself: progress/ingest/.state.json plus the entity registry and any source pages you would touch (scope: ${scope}). Act on the current on-disk state, not on what you remember.`,
    "Process the next pending sub-chunks for the scope per the configured chunking.unitPerCall contract, persisting each source page + state as you go. When the scope's pending/in_progress/partial work reaches zero or you hit a natural stopping point, exit — the backend loop resumes you if anything remains.",
  ].join("\n");
}

export async function runIngestLoop(
  input: RunIngestLoopInput,
): Promise<RunIngestLoopResult> {
  const { cfg, agent, sessionPath, initialPrompt, signal, onChunk } = input;
  const rawScope = normalizeRawScope(input.rawScope);
  if (!input.preserveStopFlag) {
    await clearStopFlag(sessionPath);
  }
  const maxIter = cfg.cli.ingestLoop.maxIterations;
  const stagnationLimit = cfg.cli.ingestLoop.maxStagnantRounds;
  await appendMessage(
    sessionPath,
    "system",
    `🔁 /ingest-loop 시작 (Ralph 루프 · 진행이 있으면 계속, 연속 무진행 ${stagnationLimit}회 시 중단).`,
  ).catch(() => undefined);

  const loopBefore = await readProgressSnapshot({ rawScope });
  let prevSnap: ProgressSnapshot = loopBefore;
  let iteration = 0;
  let idleRounds = 0;
  let lastExitCode = 0;
  let lastDurationMs = 0;
  let haltKind:
    | "normal"
    | "error"
    | "stopped"
    | "capped"
    | "stalled"
    | "empty" = "normal";
  let haltReason = "loop terminated without iterations";
  let aggregateReply = "";
  const kindTimeout = cfg.cli.timeouts["ingest-loop"];
  const progressRef =
    input.progressRef !== undefined
      ? input.progressRef
      : await buildProgressReference();
  // Keep one warm CLI conversation across iterations when the host CLI supports
  // resume-by-id and config enables it. Iteration 1 assigns/captures the id;
  // later iterations resume it with a compact delta prompt instead of a full
  // context re-injection. CLIs without resume support (agy) transparently fall
  // back to the legacy fresh-process + full-prompt path.
  const canResume =
    cfg.cli.ingestLoop.resumeSessions && cliSupportsResume(agent);
  let sessionId: string | null = null;
  let pendingClineCompaction = false;

  while (true) {
    if (await stopFlagExists(sessionPath)) {
      haltKind = "stopped";
      haltReason = "사용자 Stop 요청";
      break;
    }
    if (iteration >= maxIter) {
      haltKind = "capped";
      haltReason = `최대 반복 ${maxIter}회에 도달`;
      break;
    }

    iteration += 1;
    // Resume this iteration only when the warm session is already established
    // (iteration > 1 with a captured/assigned id). Iteration 1 — or any
    // iteration after an id capture failed — starts/assigns a session with the
    // full prompt; later resumed iterations send a compact delta.
    const resuming = canResume && iteration > 1 && sessionId != null;
    const iterPrompt = resuming
      ? buildIngestLoopDeltaPrompt({ iteration, rawScope })
      : iteration === 1
        ? initialPrompt
        : buildLoopContinuationPrompt({
            sessionPath,
            iteration,
            progressRef: progressRef ?? (await buildProgressReference()),
            entityRegistryRef: await buildEntityRegistryReference(),
            sourcePageStatusRef: await buildSourcePageStatusReference({
              rawScope,
            }),
            codeWikiStatusRef: await buildCodeWikiStatusReference({ rawScope }),
            rawScope,
          });
    const session: SessionOption | undefined = canResume
      ? resuming
        ? { id: sessionId as string, resume: true }
        : {}
      : undefined;

    const banner = `\n\n---\n[loop iter ${iteration}/${maxIter}]\n`;
    if (iteration > 1) {
      onChunk?.(banner);
    }

    await bootstrapIngestProgress({ cfg, rawScope });
    const activityBefore = await ingestActivitySignature();
    const attempt = await runCliWithIngestLoopRetries(
      {
        agent,
        prompt: iterPrompt,
        cfg,
        timeoutMs: kindTimeout ?? undefined,
        signal,
        iteration,
        sessionPath,
        onChunk,
        session,
        compact: pendingClineCompaction,
      },
      {
        runCli,
        appendMessage,
        stopFlagExists,
        readIngestStateSummary,
        errorMessage,
      },
    );
    lastDurationMs += attempt.durationMs;
    // The --compaction flag is single-shot: it applied to the call just made.
    pendingClineCompaction = false;
    if (!attempt.ok) {
      lastExitCode = attempt.lastExitCode;
      haltKind = attempt.kind;
      haltReason = attempt.reason;
      break;
    }

    const result = attempt.result;
    // Thread the resolved id forward so the next iteration resumes this same
    // conversation. Keep the prior id if this run reported none (e.g. a codex
    // capture miss) so a later iteration can retry the resume.
    if (canResume) sessionId = result.sessionId ?? sessionId;

    // Context-window compaction: when the host CLI's measured usage reaches the
    // configured ratio of its token window, compact before the next iteration.
    // claude/codex: drop the resume id so the next iteration starts a fresh
    // session that re-reads disk state (.state.json + source pages) = lossless.
    // cline: keep the task but request its native --compaction next iteration.
    const compaction = decideCompaction({
      contextTokens: result.contextTokens ?? null,
      windowTokens: compactionWindowFor(cfg, agent),
      ratio: cfg.cli.ingestLoop.compaction.ratio,
      enabled: cfg.cli.ingestLoop.compaction.enabled,
    });
    if (compaction.compact) {
      const used = compaction.usedTokens ?? 0;
      const note =
        agent === "cline"
          ? `[compaction] 컨텍스트 ${used}/${compaction.limitTokens} 토큰 도달 → 다음 라운드 --compaction`
          : `[compaction] 컨텍스트 ${used}/${compaction.limitTokens} 토큰 도달 → 새 세션으로 리셋`;
      onChunk?.(`\n${note}\n`);
      await appendMessage(sessionPath, "system", note).catch(() => undefined);
      if (agent === "cline") {
        pendingClineCompaction = true;
      } else {
        sessionId = null;
      }
    }
    lastExitCode = result.exitCode;
    const iterReply =
      cleanCliText(result.stdout).trim() ||
      cleanCliText(result.stderr).trim() ||
      `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
    await appendMessage(sessionPath, "assistant", iterReply, agent).catch(
      () => undefined,
    );
    aggregateReply += (aggregateReply ? banner : "") + iterReply;

    const summary = await readIngestStateSummary({ rawScope });
    const snap = await readProgressSnapshot({ rawScope });
    const activityAfter = await ingestActivitySignature();
    idleRounds = ingestRoundAdvanced({
      before: prevSnap,
      after: snap,
      activityBefore,
      activityAfter,
    })
      ? 0
      : idleRounds + 1;

    // No per-iteration graphify or mini-lint. The agent drives the whole
    // leaf-first + merge pass within one warm session, so spawning a graphify
    // CLI between iterations just adds redundant agent calls that the single
    // final graphify (and the closing mini-lint) already cover. Keeping graph
    // sync to loop exit is the simplification that matches the warm-session
    // model — the backend stops micro-managing the agent mid-loop.
    prevSnap = snap;

    const decision = decideLoopHalt({
      exitCode: result.exitCode,
      summary,
      mergeDone: snap.mergeDone,
      mergePending: snap.mergePendingParents > 0,
      idleRounds,
      stopRequested: await stopFlagExists(sessionPath),
      iteration,
      maxIter,
      stagnationLimit,
      sourcePagesMissing: snap.sourcePagesMissing,
      codeLeavesMissingOutputs: snap.codeLeavesMissingOutputs,
      codeFilePagesMissing: snap.codeFilePagesMissing,
      codeDirectoryIndexesMissing: snap.codeDirectoryIndexesMissing,
      rawScope,
    });
    if (decision.halt) {
      haltKind = decision.kind;
      haltReason = decision.reason;
      break;
    }
  }

  if (!input.preserveStopFlag) {
    await clearStopFlag(sessionPath);
  }

  let finalReply =
    aggregateReply || `(/ingest-loop 가 한 번도 실행되지 못했습니다.)`;
  finalReply += `\n\n---\n\n[/ingest-loop ${haltKind}] ${haltReason} · iterations=${iteration}`;

  const loopAfter = await readProgressSnapshot({ rawScope });
  const finalMaintenance = ingestFinalMaintenanceDecision(cfg, loopAfter);
  const finalize = decideIngestLoopFinalize({
    driver: "single",
    haltKind,
    aborted: false,
    progressed: ingestMadeProgress(loopBefore, loopAfter),
    // Unused by the "single" branch (which never gates on full completion); the
    // single-agent path historically finalized on progress, not completeness.
    workComplete: false,
    // No incremental graphify runs during the loop anymore, so the final
    // graphify is never redundant — always run it once at loop exit.
    graphAlreadyCoversLatest: false,
    finalMaintenanceEnabled: finalMaintenance.enabled,
  });
  if (
    !finalMaintenance.enabled &&
    haltKind !== "error" &&
    ingestMadeProgress(loopBefore, loopAfter)
  ) {
    finalReply += finalMaintenanceSkippedNote(finalMaintenance.reason);
  }
  if (finalize.runQmd) {
    const qmd = await maybeRefreshQmdIndex({ cfg, signal, onChunk });
    if (qmd.note) finalReply += qmd.note;
  }
  if (finalize.runGraph) {
    const final = await maybeAutoRunGraphify({
      cfg,
      agent,
      sessionPath,
      signal,
      lastExitCode,
      before: loopBefore,
      after: loopAfter,
      mode: "final",
      onChunk,
    });
    if (final.note) finalReply += final.note;
  } else if (finalize.graphSkipped) {
    finalReply += FINAL_GRAPH_SKIPPED_NOTE;
  }
  // Deterministically catalog every managed synthesis page into wiki/index.md
  // before the closing lint. The agent often finishes the merge pass with index
  // entries missing (index.md is the concept's query retrieval backbone, so a
  // missing page is undiscoverable); this fills the gap with no extra LLM call
  // and is a byte-for-byte no-op when nothing is missing.
  if (haltKind !== "error" && ingestMadeProgress(loopBefore, loopAfter)) {
    const reconcile = await reconcileWikiIndex();
    if (reconcile.note) finalReply += reconcile.note;
  }
  // Final post-merge mini-lint at loop exit. The per-iteration call only fires
  // on the merge-just-done transition; single-leaf runs or scopes that never
  // flip mergeDone still benefit from a closing health check.
  if (finalize.runLint) {
    const lint = await runPostMergeMiniLint({ signal });
    if (lint.note) finalReply += lint.note;
  }

  await appendMessage(
    sessionPath,
    "system",
    `🔁 /ingest-loop 종료: ${haltReason} (iterations=${iteration}).`,
  ).catch(() => undefined);

  return {
    finalReply,
    lastExitCode,
    totalDurationMs: lastDurationMs,
    iterations: iteration,
    haltKind,
    haltReason,
    loopBefore,
    loopAfter,
    anyProgress: ingestMadeProgress(loopBefore, loopAfter),
  };
}
