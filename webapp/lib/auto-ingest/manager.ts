import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { loadConfig, type Config } from "../config";
import type { CliName } from "../cli";
import { PROJECT_ROOT, RAW_ROOT, WIKI_LOG_PATH } from "../paths";
import { newSession } from "../sessions";
import {
  lockFileExists,
  runIngestLoop,
  type RunIngestLoopResult,
} from "../ingest-loop";
import { lintLockExists } from "../lint-lock";
import {
  readRuntimeState,
  writeRuntimeState,
  type AutoIngestRuntime,
} from "./runtime-state";
import { getAutoIngestEvents } from "./events";

type TriggerSource = "watch" | "schedule" | "manual";

type AutoIngestConfig = Config["autoIngest"];

const globalRef = globalThis as unknown as {
  __autoIngestManager?: AutoIngestManager;
};

/**
 * Coordinates the background watcher / scheduler that fires the same
 * /ingest-loop driver used by manual ingest. There is exactly one manager
 * per Node.js process — `next dev`'s HMR-driven re-imports are deduplicated
 * via `globalThis.__autoIngestManager`.
 */
export class AutoIngestManager {
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private nextScheduledAt: Date | null = null;
  private inFlight = false;
  private active: AutoIngestConfig | null = null;
  private booting = false;

  async boot(): Promise<void> {
    if (this.booting) return;
    this.booting = true;
    try {
      await this.restart();
    } finally {
      this.booting = false;
    }
  }

  /**
   * Tears down whatever is running and brings up a fresh watcher/scheduler
   * based on the current persisted config. Safe to call repeatedly; cheap
   * when the config did not actually change.
   */
  async restart(): Promise<void> {
    await this.stop();
    const cfg = await loadConfig(true);
    await this.start(cfg.autoIngest);
  }

  private async start(cfg: AutoIngestConfig): Promise<void> {
    this.active = cfg;
    if (!cfg.enabled) {
      await writeRuntimeState({
        status: "disabled",
        reason: "auto-ingest disabled",
        mode: null,
        nextRunAt: null,
      });
      emitState();
      return;
    }
    if (cfg.mode === "watch") {
      await this.startWatcher(cfg);
    } else {
      await this.startScheduler(cfg);
    }
    await writeRuntimeState({
      status: "idle",
      reason: `mode=${cfg.mode} ready`,
      mode: cfg.mode,
      nextRunAt: this.nextScheduledAt
        ? this.nextScheduledAt.toISOString()
        : null,
    });
    emitState();
  }

  private async startWatcher(cfg: AutoIngestConfig): Promise<void> {
    await fs.mkdir(RAW_ROOT, { recursive: true });
    const watcher = chokidar.watch(RAW_ROOT, {
      ignoreInitial: true,
      followSymlinks: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (p) => {
        const base = path.basename(p);
        // Hide dotfiles like .gitkeep, .DS_Store, editor swap files.
        return base.startsWith(".") && base !== ".";
      },
    });
    const onChange = (event: string, p: string) => {
      // Symlink loops and read errors arrive as `error`; treat as warnings.
      if (event === "error") {
        console.warn("[auto-ingest] watcher error:", p);
        return;
      }
      this.scheduleDebouncedTrigger(cfg.watch.debounceMs, "watch", event, p);
    };
    watcher.on("add", (p) => onChange("add", p));
    watcher.on("change", (p) => onChange("change", p));
    watcher.on("unlink", (p) => onChange("unlink", p));
    watcher.on("addDir", (p) => onChange("addDir", p));
    watcher.on("unlinkDir", (p) => onChange("unlinkDir", p));
    watcher.on("error", (err) => {
      console.warn(
        "[auto-ingest] watcher error:",
        err instanceof Error ? err.message : String(err),
      );
    });
    this.watcher = watcher;
  }

  private async startScheduler(cfg: AutoIngestConfig): Promise<void> {
    const intervalMs = Math.max(60_000, cfg.schedule.intervalMinutes * 60_000);
    this.nextScheduledAt = new Date(Date.now() + intervalMs);
    this.interval = setInterval(() => {
      void this.trigger("schedule", `scheduled tick (${cfg.schedule.intervalMinutes}m)`);
      this.nextScheduledAt = new Date(Date.now() + intervalMs);
      void writeRuntimeState({
        nextRunAt: this.nextScheduledAt.toISOString(),
      }).then(() => emitState());
    }, intervalMs);
  }

  private scheduleDebouncedTrigger(
    debounceMs: number,
    source: TriggerSource,
    event: string,
    p: string,
  ): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.trigger(source, `${event} ${path.relative(RAW_ROOT, p) || "."}`);
    }, Math.max(1000, debounceMs));
  }

  private async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch {
        // best effort
      }
      this.watcher = null;
    }
    this.nextScheduledAt = null;
    this.active = null;
  }

  /**
   * Public entry the API uses for the "지금 한 번 실행" button. Runs the
   * trigger in the background and resolves with the runtime state snapshot
   * captured at the moment the call was accepted, so the UI can refresh
   * immediately without waiting for the loop to finish.
   */
  async runNow(): Promise<AutoIngestRuntime> {
    void this.trigger("manual", "manual run-now");
    return readRuntimeState();
  }

  private async trigger(source: TriggerSource, reason: string): Promise<void> {
    if (this.inFlight) {
      await recordSkip(source, "previous auto-ingest run still in flight");
      return;
    }
    const cfg = (await loadConfig()).autoIngest;
    if (!cfg.enabled && source !== "manual") {
      return;
    }
    if (cfg.skipIfBusy && (await lockFileExists())) {
      await recordSkip(source, "ingest lock 존재 — 다음 트리거까지 대기");
      return;
    }
    if (cfg.skipIfBusy && (await lintLockExists())) {
      await recordSkip(source, "lint lock 존재 — auto-lint 실행 중");
      return;
    }
    const agent = (await loadConfig()).agent.default as CliName | null;
    if (!agent) {
      await recordSkip(source, "기본 코딩 에이전트 미설정");
      return;
    }

    this.inFlight = true;
    try {
      const startedAt = new Date();
      await writeRuntimeState({
        status: "running",
        reason: `${source}: ${reason}`,
        startedAt: startedAt.toISOString(),
      });
      emitState();
      getAutoIngestEvents().emitEvent({
        type: "start",
        source,
        startedAt: startedAt.toISOString(),
      });
      await appendWikiLog(
        `## [${formatTimestamp(startedAt)}] ingest | auto-trigger start (mode=${source}, reason=${truncate(reason, 80)})`,
      );

      let sessionPath: string | null = null;
      let result: RunIngestLoopResult | null = null;
      let halt: AutoIngestRuntime["lastResult"] extends infer L
        ? L extends { halt: infer H }
          ? H
          : never
        : never = "normal";
      let haltReason = "";
      let durationMs = 0;
      try {
        const session = await newSession({
          subject: `auto-ingest ${source}`,
          agent,
          origin: "background",
        });
        sessionPath = session.path;
        const cfgNow = await loadConfig();
        const preserveStopFlag = await lockFileExists();
        result = await runIngestLoop({
          cfg: cfgNow,
          agent,
          sessionPath,
          initialPrompt: buildAutoTriggerPrompt({ sessionPath, source, reason }),
          preserveStopFlag,
          onChunk: () => undefined,
        });
        durationMs = result.totalDurationMs;
        if (
          result.iterations <= 1 &&
          !result.anyProgress &&
          result.haltKind === "normal"
        ) {
          halt = "noop";
          haltReason = "변경 없음 (leaf 해시 동일)";
        } else {
          halt = result.haltKind;
          haltReason = result.haltReason;
        }
      } catch (err) {
        halt = "error";
        haltReason = err instanceof Error ? err.message : String(err);
      }

      const endedAt = new Date();
      const summaryLine = `## [${formatTimestamp(endedAt)}] ingest | auto-trigger ${halt} (source=${source}, iter=${result?.iterations ?? 0}, reason=${truncate(haltReason, 60)})`;
      await appendWikiLog(summaryLine);

      const lastResult: AutoIngestRuntime["lastResult"] = {
        halt,
        reason: haltReason,
        iterations: result?.iterations ?? 0,
        durationMs,
        anyProgress: result?.anyProgress ?? false,
        source,
        sessionPath,
      };

      await writeRuntimeState({
        status: "idle",
        reason: `${source} ${halt}`,
        startedAt: null,
        lastRunAt: endedAt.toISOString(),
        lastResult,
        nextRunAt: this.nextScheduledAt
          ? this.nextScheduledAt.toISOString()
          : null,
      });
      emitState();
      getAutoIngestEvents().emitEvent({
        type: "done",
        source,
        halt,
        reason: haltReason,
        iterations: lastResult.iterations,
        durationMs,
        anyProgress: lastResult.anyProgress,
        sessionPath,
      });
    } finally {
      this.inFlight = false;
    }
  }
}

function buildAutoTriggerPrompt(input: {
  sessionPath: string;
  source: TriggerSource;
  reason: string;
}): string {
  return [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md and follow .agents/skills/wiki-ingest/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${input.sessionPath}`,
    `This run was triggered automatically (source=${input.source}, reason=${input.reason}).`,
    "Start exactly like a normal `/ingest` with no path: enumerate `raw/`, update wiki/.progress/ingest/.state.json for new, changed, or stale leaves, then process exactly one pending sub-chunk or one merge-pass unit per the wiki-ingest skill. Exit after that single unit; the backend driver will spawn the next iteration.",
    "",
    "===== CONVERSATION =====",
    "User: /ingest",
    "",
    "Respond now as the assistant.",
  ].join("\n");
}

async function recordSkip(source: TriggerSource, reason: string): Promise<void> {
  await writeRuntimeState({
    status: "skipped",
    reason: `${source} skipped: ${reason}`,
  });
  emitState();
  getAutoIngestEvents().emitEvent({ type: "skipped", source, reason });
  await appendWikiLog(
    `## [${formatTimestamp(new Date())}] ingest | auto-trigger skipped (source=${source}, reason=${truncate(reason, 80)})`,
  );
  // Reset status back to idle after a brief moment so the UI does not stay
  // pinned on "skipped" forever — the badge will surface via lastResult.reason.
  setTimeout(() => {
    void writeRuntimeState({ status: "idle", reason: `${source} skipped` })
      .then(() => emitState())
      .catch(() => undefined);
  }, 2000);
}

async function appendWikiLog(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(WIKI_LOG_PATH), { recursive: true });
    let prefix = "";
    try {
      const buf = await fs.readFile(WIKI_LOG_PATH, "utf8");
      if (buf.length > 0 && !buf.endsWith("\n")) prefix = "\n";
    } catch {
      // create new
    }
    await fs.appendFile(WIKI_LOG_PATH, `${prefix}${line}\n`, "utf8");
  } catch (err) {
    console.warn(
      "[auto-ingest] failed to append wiki/log.md:",
      err instanceof Error ? err.message : err,
    );
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function emitState(): void {
  void readRuntimeState()
    .then((state) => {
      getAutoIngestEvents().emitEvent({ type: "state", state });
    })
    .catch(() => undefined);
}

export function getAutoIngestManager(): AutoIngestManager {
  if (!globalRef.__autoIngestManager) {
    globalRef.__autoIngestManager = new AutoIngestManager();
  }
  return globalRef.__autoIngestManager;
}

// Re-export so callers that already import the manager module can grab the
// projectRoot for diagnostics (kept here so we do not leak the paths module
// from the API layer).
export { PROJECT_ROOT };
