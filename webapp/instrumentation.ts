/**
 * Next.js boot hook. Runs exactly once per server process (both `next dev`
 * and `next start`). The actual boot logic lives in `instrumentation-node`
 * so the Edge runtime bundle never has to resolve `node:` imports
 * transitively pulled in by the auto-ingest manager (chokidar, child_process).
 *
 * The manager itself guards against duplicate registration via
 * `globalThis.__autoIngestManager`, so HMR-driven re-evaluation in dev
 * mode does not spawn a second watcher.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const mod = await import("./instrumentation-node");
    await mod.bootAutoIngest();
    await mod.bootAutoLint();
    await mod.bootAutomation();
  }
}
