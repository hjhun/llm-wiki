import fs from "node:fs/promises";
import path from "node:path";
import { PROGRESS_ROOT, RAW_ROOT } from "../paths";

export const AUTOMATION_ARTIFACTS_REL = "progress/automation/artifacts";
export const LEGACY_AUTOMATION_ARTIFACTS_REL = "raw/automation";

export const AUTOMATION_ARTIFACTS_ROOT = path.join(
  PROGRESS_ROOT,
  "automation",
  "artifacts",
);

const LEGACY_AUTOMATION_ARTIFACTS_ROOT = path.join(RAW_ROOT, "automation");

export function automationArtifactRel(...parts: string[]): string {
  return path.posix.join(AUTOMATION_ARTIFACTS_REL, ...parts);
}

export function normalizeAutomationArtifactPath(rel: string): string {
  if (rel === LEGACY_AUTOMATION_ARTIFACTS_REL) return AUTOMATION_ARTIFACTS_REL;
  if (rel.startsWith(`${LEGACY_AUTOMATION_ARTIFACTS_REL}/`)) {
    return `${AUTOMATION_ARTIFACTS_REL}${rel.slice(LEGACY_AUTOMATION_ARTIFACTS_REL.length)}`;
  }
  return rel;
}

export async function ensureAutomationArtifactsMigrated(): Promise<void> {
  if (!(await exists(LEGACY_AUTOMATION_ARTIFACTS_ROOT))) return;
  await fs.mkdir(path.dirname(AUTOMATION_ARTIFACTS_ROOT), { recursive: true });

  if (!(await exists(AUTOMATION_ARTIFACTS_ROOT))) {
    await movePath(LEGACY_AUTOMATION_ARTIFACTS_ROOT, AUTOMATION_ARTIFACTS_ROOT);
    return;
  }

  await mergeDirectory(LEGACY_AUTOMATION_ARTIFACTS_ROOT, AUTOMATION_ARTIFACTS_ROOT);
  await fs.rm(LEGACY_AUTOMATION_ARTIFACTS_ROOT, { recursive: true, force: true });
}

async function mergeDirectory(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    let dst = path.join(to, entry.name);
    if (await exists(dst)) {
      dst = await uniqueLegacyPath(to, entry.name);
    }
    await movePath(src, dst);
  }
}

async function movePath(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(from, { recursive: true, force: true });
  }
}

async function uniqueLegacyPath(dir: string, name: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  let candidate = path.join(dir, `${name}.legacy-${stamp}`);
  let suffix = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${name}.legacy-${stamp}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
