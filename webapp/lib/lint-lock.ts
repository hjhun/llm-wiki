import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";

export const LINT_LOCK_PATH = "wiki/.progress/lint/.lock";

function absPath(): string {
  return path.join(PROJECT_ROOT, LINT_LOCK_PATH);
}

export async function lintLockExists(): Promise<boolean> {
  try {
    await fs.access(absPath());
    return true;
  } catch {
    return false;
  }
}

export async function acquireLintLock(): Promise<void> {
  const abs = absPath();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
}

export async function releaseLintLock(): Promise<void> {
  try {
    await fs.rm(absPath(), { force: true });
  } catch {
    // best effort
  }
}
