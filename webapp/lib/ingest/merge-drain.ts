import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "../api";
import { PROJECT_ROOT } from "../paths";
import {
  mergeParentBlocksScopeCompletion,
  normalizePosixPath,
  normalizeRawScope,
} from "./scope";
import { leafMatchesScope } from "./state";

const execFileAsync = promisify(execFile);

const PROGRESS_DIR = "wiki/.progress/ingest";
const PROGRESS_STATE_PATH = `${PROGRESS_DIR}/.state.json`;
const PROGRESS_DASHBOARD_PATH = `${PROGRESS_DIR}/DASHBOARD.md`;
const PROGRESS_LOCK_PATH = `${PROGRESS_DIR}/.lock`;
const WIKI_LOG_PATH = "wiki/log.md";

type JsonRecord = Record<string, unknown>;

export type ScopedMergeDrainResult = {
  drained: boolean;
  parent: string | null;
  note: string | null;
  durationMs: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function statusOf(leaf: JsonRecord): string {
  return typeof leaf.status === "string" ? leaf.status : "pending";
}

function pendingParentsOf(state: JsonRecord): string[] {
  const mergePass = isRecord(state.merge_pass) ? state.merge_pass : {};
  const pending = Array.isArray(mergePass.pending_parents)
    ? mergePass.pending_parents
    : [];
  return pending.filter((value): value is string => typeof value === "string");
}

export function drainScopedMergeState(input: {
  state: unknown;
  rawScope: string | null | undefined;
  nowIso: string;
}): { state: JsonRecord; parent: string } | null {
  const scope = normalizeRawScope(input.rawScope);
  if (!scope || !isRecord(input.state) || !isRecord(input.state.leaves)) {
    return null;
  }

  const scopedLeaves = Object.entries(input.state.leaves).filter(
    ([leafPath, leafValue]) => {
      const leaf = isRecord(leafValue) ? leafValue : {};
      return statusOf(leaf) !== "stale" && leafMatchesScope(leafPath, leaf, scope);
    },
  );
  if (scopedLeaves.length === 0) return null;
  if (scopedLeaves.some(([, leaf]) => statusOf(leaf as JsonRecord) !== "done")) {
    return null;
  }

  const pendingParents = pendingParentsOf(input.state);
  const scopedParents = pendingParents.filter((parent) =>
    mergeParentBlocksScopeCompletion(parent, scope),
  );
  if (scopedParents.length !== 1) return null;

  const parent = scopedParents[0];
  const parentKey = normalizePosixPath(parent);
  const nextState = JSON.parse(JSON.stringify(input.state)) as JsonRecord;
  const nextMergePass = isRecord(nextState.merge_pass)
    ? nextState.merge_pass
    : {};
  const remaining = pendingParents.filter(
    (candidate) => normalizePosixPath(candidate) !== parentKey,
  );
  nextMergePass.pending_parents = remaining;
  nextMergePass.last_run_at = input.nowIso;
  nextMergePass.status = remaining.length === 0 ? "done" : "pending";
  nextState.merge_pass = nextMergePass;
  return { state: nextState, parent };
}

export function renderIngestDashboard(state: unknown, updatedIso: string): string {
  const leaves = isRecord(state) && isRecord(state.leaves) ? state.leaves : {};
  const rows: string[] = [];
  const counts = {
    done: 0,
    in_progress: 0,
    pending: 0,
    partial: 0,
    error: 0,
  };
  let lastActivity: {
    leaf: string;
    subChunk: string;
    status: string;
    at: string;
  } | null = null;

  for (const [leafPath, leafValue] of Object.entries(leaves).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const leaf = isRecord(leafValue) ? leafValue : {};
    const status = statusOf(leaf);
    if (status === "stale") continue;
    if (status in counts) counts[status as keyof typeof counts] += 1;
    else counts.pending += 1;

    const subChunks = Array.isArray(leaf.sub_chunks) ? leaf.sub_chunks : [];
    const doneSubChunks = subChunks.filter(
      (sc) => isRecord(sc) && sc.status === "done",
    ).length;
    const lastError =
      typeof leaf.last_error === "string" && leaf.last_error.trim()
        ? leaf.last_error.trim().replace(/\|/g, "\\|")
        : "—";
    const session =
      typeof leaf.last_session === "string" && leaf.last_session.trim()
        ? `\`${leaf.last_session.trim()}\``
        : "—";
    rows.push(
      `| \`${leafPath}\` | ${status} | ${doneSubChunks}/${subChunks.length} | ${lastError} | ${session} |`,
    );

    for (const scValue of subChunks) {
      if (!isRecord(scValue)) continue;
      const at =
        typeof scValue.ended_at === "string"
          ? scValue.ended_at
          : typeof scValue.started_at === "string"
            ? scValue.started_at
            : "";
      if (!at || (lastActivity && at <= lastActivity.at)) continue;
      lastActivity = {
        leaf: leafPath,
        subChunk: String(scValue.id ?? "?"),
        status: String(scValue.status ?? "?"),
        at,
      };
    }
  }

  const total =
    counts.done +
    counts.in_progress +
    counts.pending +
    counts.partial +
    counts.error;
  const lastLine = lastActivity
    ? `${lastActivity.leaf} — sub-chunk ${lastActivity.subChunk} (${lastActivity.status})`
    : "—";

  return [
    "# Ingest progress",
    "",
    `- Updated: ${updatedIso}`,
    `- Leaves: ${counts.done}/${total} done · ${counts.in_progress} in_progress · ${counts.pending} pending · ${counts.error} error`,
    `- Last activity: ${lastLine}`,
    "",
    "| leaf | status | sub-chunks done/total | last_error | session |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "_Resume by running `/ingest` again — the next sub-chunk is picked from `.state.json` automatically. Or run `/ingest-loop` to let the webapp's backend driver keep re-spawning the CLI until every sub-chunk and the merge pass are done; click \"Stop loop\" in the chat UI to halt after the current sub-chunk._",
    "",
  ].join("\n");
}

async function acquireShortLock(): Promise<boolean> {
  const abs = path.join(PROJECT_ROOT, PROGRESS_LOCK_PATH);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(
      abs,
      JSON.stringify({
        pid: process.pid,
        mode: "backend-scoped-merge",
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

async function appendMergeLog(parent: string, nowIso: string): Promise<void> {
  const stamp = nowIso.slice(0, 16).replace("T", " ");
  const entry = [
    "",
    `## [${stamp}] ingest | merge pass | ${parent}`,
    "- Integrated pages: `wiki/sources/index.md`",
    "- Notes: deterministic backend scoped merge drain",
    "- Checklist: [x] source index refreshed · [x] state persisted · [x] dashboard regenerated · [-] graph (separate)",
    "",
  ].join("\n");
  await fs.appendFile(path.join(PROJECT_ROOT, WIKI_LOG_PATH), entry, "utf8");
}

export async function tryDrainScopedMergeParent(input: {
  rawScope: string | null | undefined;
  signal?: AbortSignal;
}): Promise<ScopedMergeDrainResult> {
  const started = Date.now();
  const lock = await acquireShortLock();
  if (!lock) {
    return {
      drained: false,
      parent: null,
      note: "[backend merge] ingest lock is held; falling back to worker merge.",
      durationMs: Date.now() - started,
    };
  }

  try {
    const nowIso = new Date().toISOString();
    const statePath = path.join(PROJECT_ROOT, PROGRESS_STATE_PATH);
    const raw = await fs.readFile(statePath, "utf8");
    const drained = drainScopedMergeState({
      state: JSON.parse(raw) as unknown,
      rawScope: input.rawScope,
      nowIso,
    });
    if (!drained) {
      return {
        drained: false,
        parent: null,
        note: null,
        durationMs: Date.now() - started,
      };
    }

    await execFileAsync(
      process.execPath,
      [path.join(PROJECT_ROOT, "scripts", "build-sources-index.mjs"), "--root", PROJECT_ROOT],
      {
        cwd: PROJECT_ROOT,
        signal: input.signal,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    await fs.writeFile(
      statePath,
      `${JSON.stringify(drained.state, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(PROJECT_ROOT, PROGRESS_DASHBOARD_PATH),
      renderIngestDashboard(drained.state, nowIso),
      "utf8",
    );
    await appendMergeLog(drained.parent, nowIso);

    const durationMs = Date.now() - started;
    return {
      drained: true,
      parent: drained.parent,
      note: `[backend merge] drained scoped merge parent ${drained.parent} in ${(durationMs / 1000).toFixed(1)}s.`,
      durationMs,
    };
  } catch (err) {
    return {
      drained: false,
      parent: null,
      note: `[backend merge] deterministic scoped merge failed; falling back to worker merge: ${errorMessage(err)}`,
      durationMs: Date.now() - started,
    };
  } finally {
    await fs.rm(path.join(PROJECT_ROOT, PROGRESS_LOCK_PATH), { force: true }).catch(
      () => undefined,
    );
  }
}
