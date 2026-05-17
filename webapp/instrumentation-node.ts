/**
 * Node-only boot logic for the auto-ingest manager. Lives in a separate
 * module so the Edge runtime bundle never references `node:child_process`
 * transitively through `lib/cli.ts`.
 */
import { getAutoIngestManager } from "./lib/auto-ingest/manager";

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
