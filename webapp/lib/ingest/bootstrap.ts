import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config";
import { PROJECT_ROOT } from "../paths";
import {
  classifyLeafFromFiles,
  isIgnoredCodePath,
  type LeafKind,
} from "./leaf-classify";
import {
  INGEST_PROGRESS_DASHBOARD_PATH,
  INGEST_PROGRESS_DIR,
  INGEST_PROGRESS_LEAVES_LOCK_DIR,
  INGEST_PROGRESS_LOCK_PATH,
  INGEST_PROGRESS_STATE_PATH,
} from "./progress-paths";
import {
  normalizePosixPath,
  normalizeRawScope,
  pathMatchesScope,
} from "./scope";
import { leafMatchesScope } from "./state";
import { renderIngestDashboard } from "./merge-drain";

type JsonRecord = Record<string, unknown>;

type ScannedFile = {
  path: string;
  size: number;
  mtimeMs: number;
};

type ScannedLeaf = {
  leafPath: string;
  files: ScannedFile[];
  hash: string;
  kind: LeafKind;
  project: string | null;
};

export type BootstrapIngestProgressResult = {
  changed: boolean;
  leaves: number;
  files: number;
  statePath: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeLeafPath(value: string): string {
  const normalized = normalizePosixPath(value);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function statusOf(leaf: JsonRecord): string {
  return typeof leaf.status === "string" ? leaf.status : "pending";
}

function inferProject(files: string[], leafPath: string): string | null {
  const candidates = [leafPath, ...files].map((item) =>
    normalizePosixPath(item).split("/").filter(Boolean),
  );
  for (const parts of candidates) {
    if (parts[0] === "raw" && parts[1] === "repos" && parts[2]) return parts[2];
  }
  for (const parts of candidates) {
    if (parts[0] === "raw" && parts[1]) return parts[1];
  }
  return null;
}

function leafHash(files: ScannedFile[]): string {
  const stable = files
    .map((file) => [file.path, file.size, Math.floor(file.mtimeMs)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return sha1(JSON.stringify(stable));
}

function parentLeafPath(filePath: string): string {
  const dir = path.posix.dirname(normalizePosixPath(filePath));
  return normalizeLeafPath(dir === "." ? "raw" : dir);
}

function shouldSkipPath(relPath: string): boolean {
  return isIgnoredCodePath(relPath);
}

async function statOrNull(abs: string): Promise<{
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
} | null> {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

async function scanRawLeaves(input: {
  projectRoot: string;
  rawScope?: string | null;
}): Promise<ScannedLeaf[]> {
  const scope = normalizeRawScope(input.rawScope) ?? "raw";
  const startAbs = path.resolve(input.projectRoot, scope);
  const rawAbs = path.resolve(input.projectRoot, "raw");
  if (startAbs !== rawAbs && !startAbs.startsWith(`${rawAbs}${path.sep}`)) {
    return [];
  }

  const leaves = new Map<string, ScannedFile[]>();
  const visitedDirs = new Set<string>();

  const addFiles = (leafPath: string, files: ScannedFile[]) => {
    if (files.length === 0) return;
    const normalizedLeaf = normalizeLeafPath(leafPath);
    const existing = leaves.get(normalizedLeaf) ?? [];
    existing.push(...files);
    leaves.set(normalizedLeaf, existing);
  };

  const walk = async (abs: string, logical: string): Promise<void> => {
    const stat = await statOrNull(abs);
    if (!stat) return;

    const logicalPath = normalizePosixPath(logical);
    if (shouldSkipPath(logicalPath)) return;

    if (stat.isFile()) {
      addFiles(parentLeafPath(logicalPath), [
        { path: logicalPath, size: stat.size, mtimeMs: stat.mtimeMs },
      ]);
      return;
    }
    if (!stat.isDirectory()) return;

    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      return;
    }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);

    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    const directFiles: ScannedFile[] = [];
    const childDirs: Array<{ abs: string; logical: string }> = [];

    for (const entry of entries) {
      const childLogical = `${logicalPath}/${entry.name}`;
      if (shouldSkipPath(childLogical)) continue;
      const childAbs = path.join(abs, entry.name);
      const childStat = await statOrNull(childAbs);
      if (!childStat) continue;
      if (childStat.isFile()) {
        directFiles.push({
          path: normalizePosixPath(childLogical),
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
        });
      } else if (childStat.isDirectory()) {
        childDirs.push({ abs: childAbs, logical: normalizePosixPath(childLogical) });
      }
    }

    if (directFiles.length > 0) addFiles(normalizeLeafPath(logicalPath), directFiles);
    for (const child of childDirs) await walk(child.abs, child.logical);
  };

  await walk(startAbs, scope);

  return [...leaves.entries()]
    .map(([leafPath, rawFiles]) => {
      const files = rawFiles
        .filter((file, index, all) =>
          all.findIndex((candidate) => candidate.path === file.path) === index,
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      const kind = classifyLeafFromFiles(files.map((file) => file.path));
      return {
        leafPath,
        files,
        hash: leafHash(files),
        kind,
        project: inferProject(files.map((file) => file.path), leafPath),
      };
    })
    .sort((a, b) => a.leafPath.localeCompare(b.leafPath));
}

function planSubChunks(
  files: ScannedFile[],
  cfg: Config,
): Array<Record<string, unknown>> {
  const chunks: ScannedFile[][] = [];
  let current: ScannedFile[] = [];
  let currentBytes = 0;
  const maxFiles = cfg.chunking.maxFilesPerInvocation;
  const maxBytes = cfg.chunking.maxBytes;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const file of files) {
    const wouldExceedFiles = current.length >= maxFiles;
    const wouldExceedBytes =
      current.length > 0 && currentBytes + file.size > maxBytes;
    if (wouldExceedFiles || wouldExceedBytes) flush();
    current.push(file);
    currentBytes += file.size;
  }
  flush();

  return chunks.map((chunk, index) => ({
    id: `c${index + 1}`,
    files: chunk.map((file) => file.path),
    status: "pending",
    started_at: null,
    ended_at: null,
    source_pages_written: [],
  }));
}

function leafPartFile(leafPath: string): string {
  return `${INGEST_PROGRESS_LEAVES_LOCK_DIR}/${sha1(leafPath)}.json`;
}

function buildLeafState(leaf: ScannedLeaf, cfg: Config): JsonRecord {
  const files = leaf.files.map((file) => file.path);
  const state: JsonRecord = {
    hash: leaf.hash,
    status: leaf.kind === "ignore" ? "stale" : "pending",
    kind: leaf.kind,
    files,
    bytes: leaf.files.reduce((sum, file) => sum + file.size, 0),
    sub_chunks: leaf.kind === "ignore" ? [] : planSubChunks(leaf.files, cfg),
    last_error: null,
    last_session: null,
    attempts: 0,
    part_file: leafPartFile(leaf.leafPath),
  };
  if (leaf.project) state.project = leaf.project;
  if (leaf.kind === "code" || leaf.kind === "mixed") {
    state.graph_scope = leaf.leafPath;
  }
  return state;
}

function buildLeafPart(leaf: ScannedLeaf): JsonRecord {
  return {
    leaf: leaf.leafPath,
    files: leaf.files.map((file) => ({
      path: file.path,
      bytes: file.size,
      sha1: null,
      processed: false,
      summary_page: null,
      truncated: false,
    })),
    takeaways: [],
    entities_touched: [],
    concepts_touched: [],
    contradictions: [],
    next_action: "process files[0]",
  };
}

function baseState(cfg: Config, nowIso: string): JsonRecord {
  return {
    version: 1,
    updated_at: nowIso,
    config_snapshot: {
      maxFilesPerInvocation: cfg.chunking.maxFilesPerInvocation,
      maxBytesPerFile: cfg.chunking.maxBytesPerFile,
      unitPerCall: cfg.chunking.unitPerCall,
    },
    leaves: {},
    merge_pass: {
      status: "idle",
      last_run_at: null,
      pending_parents: [],
    },
  };
}

function normalizeState(raw: unknown, cfg: Config, nowIso: string): JsonRecord {
  if (!isRecord(raw)) return baseState(cfg, nowIso);
  const state = { ...raw };
  state.version = typeof state.version === "number" ? state.version : 1;
  state.leaves = isRecord(state.leaves) ? { ...state.leaves } : {};
  state.merge_pass = isRecord(state.merge_pass)
    ? { ...state.merge_pass }
    : {
        status: "idle",
        last_run_at: null,
        pending_parents: [],
      };
  state.config_snapshot = {
    maxFilesPerInvocation: cfg.chunking.maxFilesPerInvocation,
    maxBytesPerFile: cfg.chunking.maxBytesPerFile,
    unitPerCall: cfg.chunking.unitPerCall,
  };
  return state;
}

function mergeBootstrapState(input: {
  current: unknown;
  scanned: ScannedLeaf[];
  cfg: Config;
  rawScope?: string | null;
  nowIso: string;
}): { state: JsonRecord; changed: boolean; parts: ScannedLeaf[] } {
  const state = normalizeState(input.current, input.cfg, input.nowIso);
  const leaves = isRecord(state.leaves) ? { ...state.leaves } : {};
  const scannedByLeaf = new Map(input.scanned.map((leaf) => [leaf.leafPath, leaf]));
  let changed = false;
  const parts: ScannedLeaf[] = [];

  for (const leaf of input.scanned) {
    const existing = isRecord(leaves[leaf.leafPath])
      ? (leaves[leaf.leafPath] as JsonRecord)
      : null;
    if (!existing || existing.hash !== leaf.hash || statusOf(existing) === "stale") {
      leaves[leaf.leafPath] = buildLeafState(leaf, input.cfg);
      parts.push(leaf);
      changed = true;
    }
  }

  for (const [leafPath, value] of Object.entries(leaves)) {
    const leaf = isRecord(value) ? value : {};
    if (scannedByLeaf.has(leafPath)) continue;
    if (!leafMatchesScope(leafPath, leaf, input.rawScope)) continue;
    if (pathMatchesScope(leafPath, input.rawScope) && statusOf(leaf) !== "stale") {
      leaves[leafPath] = { ...leaf, status: "stale" };
      changed = true;
    }
  }

  if (changed) {
    const mergePass = isRecord(state.merge_pass) ? { ...state.merge_pass } : {};
    if (input.scanned.some((leaf) => leaf.kind !== "ignore")) {
      mergePass.status = "idle";
    }
    if (!Array.isArray(mergePass.pending_parents)) {
      mergePass.pending_parents = [];
    }
    state.merge_pass = mergePass;
    state.updated_at = input.nowIso;
    state.leaves = leaves;
  }
  return { state, changed, parts };
}

async function readState(abs: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(abs, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(abs: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, abs);
}

async function acquireBootstrapLock(projectRoot: string): Promise<boolean> {
  const abs = path.join(projectRoot, INGEST_PROGRESS_LOCK_PATH);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(
      abs,
      JSON.stringify({
        pid: process.pid,
        phase: "backend-bootstrap",
        started_at: new Date().toISOString(),
      }) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function bootstrapIngestProgress(input: {
  cfg: Config;
  rawScope?: string | null;
  projectRoot?: string;
}): Promise<BootstrapIngestProgressResult> {
  const projectRoot = input.projectRoot ?? PROJECT_ROOT;
  const locked = await acquireBootstrapLock(projectRoot);
  const statePath = path.join(projectRoot, INGEST_PROGRESS_STATE_PATH);
  if (!locked) {
    return {
      changed: false,
      leaves: 0,
      files: 0,
      statePath: toPosix(path.relative(projectRoot, statePath)),
    };
  }

  try {
    await fs.mkdir(path.join(projectRoot, INGEST_PROGRESS_DIR), { recursive: true });
    await fs.mkdir(path.join(projectRoot, INGEST_PROGRESS_LEAVES_LOCK_DIR), {
      recursive: true,
    });
    const scanned = await scanRawLeaves({
      projectRoot,
      rawScope: input.rawScope,
    });
    const nowIso = new Date().toISOString();
    const current = await readState(statePath);
    const merged = mergeBootstrapState({
      current,
      scanned,
      cfg: input.cfg,
      rawScope: input.rawScope,
      nowIso,
    });

    if (merged.changed) {
      await writeJsonAtomic(statePath, merged.state);
      await Promise.all(
        merged.parts.map((leaf) =>
          writeJsonAtomic(
            path.join(projectRoot, leafPartFile(leaf.leafPath)),
            buildLeafPart(leaf),
          ),
        ),
      );
      await fs.writeFile(
        path.join(projectRoot, INGEST_PROGRESS_DASHBOARD_PATH),
        renderIngestDashboard(merged.state, nowIso),
        "utf8",
      );
    }

    return {
      changed: merged.changed,
      leaves: scanned.length,
      files: scanned.reduce((sum, leaf) => sum + leaf.files.length, 0),
      statePath: toPosix(path.relative(projectRoot, statePath)),
    };
  } finally {
    await fs
      .rm(path.join(projectRoot, INGEST_PROGRESS_LOCK_PATH), { force: true })
      .catch(() => undefined);
  }
}
