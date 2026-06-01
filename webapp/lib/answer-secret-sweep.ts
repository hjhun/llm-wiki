import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { WIKI_ROOT } from "./paths";
import {
  redactSecrets,
  summarizeFindings,
  type SecretFinding,
} from "./secret-scan";

/**
 * Code-enforced backstop for the web `/query --save` path. Unlike the Telegram
 * save (which routes through saveAnswerToWiki and its redactSecrets gate), the
 * web/chat save is performed by the coding-agent CLI writing wiki/answers files
 * directly, so the deterministic secret gate never sees it — only the prompt
 * asks the agent to behave. This module sweeps wiki/answers files that changed
 * during a chat operation and masks any high-confidence secret in place, so a
 * credential can't persist in the durable wiki regardless of which path wrote
 * it. See CLAUDE.md §9.
 */

const ANSWERS_DIR = path.join(WIKI_ROOT, "answers");
const LINT_DIR = path.join(WIKI_ROOT, "lint");

/** Map of answer filename -> mtimeMs, used to detect files touched by an op. */
export type AnswerMtimes = Map<string, number>;

export async function snapshotAnswerMtimes(): Promise<AnswerMtimes> {
  const map: AnswerMtimes = new Map();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(ANSWERS_DIR, { withFileTypes: true });
  } catch {
    return map; // dir may not exist yet
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    try {
      const st = await fs.stat(path.join(ANSWERS_DIR, e.name));
      map.set(e.name, st.mtimeMs);
    } catch {
      /* skip unreadable */
    }
  }
  return map;
}

/**
 * Pure: filenames that are new or have a newer mtime than the baseline,
 * sorted for stable output.
 */
export function selectChangedAnswers(
  baseline: AnswerMtimes,
  current: AnswerMtimes,
): string[] {
  const changed: string[] = [];
  for (const [name, mtime] of current) {
    const prev = baseline.get(name);
    if (prev === undefined || mtime > prev) changed.push(name);
  }
  return changed.sort();
}

export type SweepResult = {
  /** Number of changed answer files inspected. */
  scanned: number;
  /** POSIX paths of files that had a secret masked. */
  maskedFiles: string[];
  findings: SecretFinding[];
};

function fmtDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtDateTime(date: Date): string {
  const time =
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0");
  return `${fmtDate(date)} ${time}`;
}

async function appendSweepLint(
  findings: SecretFinding[],
  maskedFiles: string[],
  now: Date,
): Promise<void> {
  const summary = summarizeFindings(findings);
  if (summary.length === 0) return;
  const lintPath = path.join(LINT_DIR, `${fmtDate(now)}.md`);
  const section = [
    "",
    `## [${fmtDateTime(now)}] secret-scan | wiki/answers sweep`,
    `- Targets: ${maskedFiles.map((f) => `\`${f}\``).join(", ")}`,
    "- Action: auto-masked after a chat save operation",
    "- Findings:",
    ...summary.map((s) => `  - ${s.kind} ×${s.count}`),
    "",
  ].join("\n");
  await fs.mkdir(LINT_DIR, { recursive: true });
  await fs.appendFile(lintPath, section, "utf8").catch(() => undefined);
}

/**
 * Re-scan answer files changed since `baseline` and mask any high-confidence
 * secret in place. Findings are recorded in the day's lint report (rule kind
 * and target only — never the secret material).
 */
export async function sweepAnswersForSecrets(
  baseline: AnswerMtimes,
): Promise<SweepResult> {
  const current = await snapshotAnswerMtimes();
  const changed = selectChangedAnswers(baseline, current);
  const maskedFiles: string[] = [];
  const allFindings: SecretFinding[] = [];
  for (const name of changed) {
    const abs = path.join(ANSWERS_DIR, name);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const { redacted, findings } = redactSecrets(content);
    if (findings.length > 0 && redacted !== content) {
      await fs.writeFile(abs, redacted, "utf8");
      maskedFiles.push(`wiki/answers/${name}`);
      allFindings.push(...findings);
    }
  }
  if (allFindings.length > 0) {
    await appendSweepLint(allFindings, maskedFiles, new Date());
  }
  return { scanned: changed.length, maskedFiles, findings: allFindings };
}
