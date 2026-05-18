/**
 * Node-only boot logic for the auto-ingest and auto-lint managers. Lives in a
 * separate module so the Edge runtime bundle never references
 * `node:child_process` transitively through `lib/cli.ts`.
 */
import { getAutoIngestManager } from "./lib/auto-ingest/manager";
import { getAutoLintManager } from "./lib/auto-lint/manager";
import { getAutomationManager } from "./lib/automation/manager";

export async function bootAutoIngest(): Promise<void> {
  try {
    await getAutoIngestManager().boot();
  } catch (err) {
    console.warn(
      "[auto-ingest] boot failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function bootAutoLint(): Promise<void> {
  try {
    await getAutoLintManager().boot();
  } catch (err) {
    console.warn(
      "[auto-lint] boot failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function bootAutomation(): Promise<void> {
  try {
    await getAutomationManager().boot();
  } catch (err) {
    console.warn(
      "[automation] boot failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
