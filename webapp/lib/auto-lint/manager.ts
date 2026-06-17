import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "../config";
import { runCli } from "../cli";
import { resolveAgentForRole } from "../agent-roles";
import { PROJECT_ROOT, WIKI_LOG_PATH } from "../paths";
import { newSession } from "../sessions";
import { lockFileExists } from "../ingest-loop";
import {
  acquireLintLock,
  lintLockExists,
  releaseLintLock,
} from "../lint-lock";
import { getAutoIngestEvents } from "../auto-ingest/events";
import {
  patchCounter,
  readRuntimeState,
  writeRuntimeState,
  type AutoLintRuntime,
} from "./runtime-state";
import { getAutoLintEvents, type AutoLintSource } from "./events";
import { computeNextFire, safeDelay } from "./cron";
import { countIngestSinceLastLint } from "./log-counter";
import { buildAutoLintPrompt } from "./prompt";

type AutoLintConfig = Config["autoLint"];

const COUNTER_TICK_MS = 30_000;

const globalRef = globalThis as unknown as {
  __autoLintManager?: AutoLintManager;
};

/**
 * Coordinates the counter-based suggestion and the preset-based cron trigger
 * for the wiki-lint skill. There is exactly one manager per Node.js process —
 * `next dev`'s HMR-driven re-imports are deduplicated via
 * `globalThis.__autoLintManager`.
 */
export class AutoLintManager {
  private counterInterval: NodeJS.Timeout | null = null;
  private cronTimer: NodeJS.Timeout | null = null;
  private nextFireAt: Date | null = null;
  private inFlight = false;
  private active: AutoLintConfig | null = null;
  private booting = false;
  private ingestUnsubscribe: (() => void) | null = null;

  async boot(): Promise<void> {
    if (this.booting) return;
    this.booting = true;
    try {
      await this.restart();
    } finally {
      this.booting = false;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    const cfg = await loadConfig(true);
    await this.start(cfg.autoLint);
  }

  private async start(cfg: AutoLintConfig): Promise<void> {
    this.active = cfg;
    if (!cfg.enabled) {
      await writeRuntimeState({
        status: "disabled",
        reason: "auto-lint disabled",
        cronEnabled: false,
        nextRunAt: null,
      });
      // Still keep the counter visible in the persisted state, but the
      // suggestion flag should reflect "not active".
      await patchCounter({ threshold: cfg.counter.threshold });
      emitState();
      return;
    }

    // Counter tick: re-parses wiki/log.md tail every 30s. Cheap I/O.
    this.counterInterval = setInterval(() => {
      void this.tickCounter().catch(() => undefined);
    }, COUNTER_TICK_MS);

    // Subscribe to auto-ingest "done" events so the counter recomputes as
    // soon as an ingest finishes rather than waiting up to 30s.
    const bus = getAutoIngestEvents();
    const listener = (event: { type: string }): void => {
      if (event.type === "done" || event.type === "skipped") {
        void this.tickCounter().catch(() => undefined);
      }
    };
    bus.on("event", listener);
    this.ingestUnsubscribe = () => {
      bus.off("event", listener);
    };

    if (cfg.cron.enabled) {
      this.armCronTimer(cfg.cron);
    }

    await writeRuntimeState({
      status: "idle",
      reason: `auto-lint ready (cron=${cfg.cron.enabled ? cfg.cron.preset : "off"})`,
      cronEnabled: cfg.cron.enabled,
      nextRunAt: this.nextFireAt ? this.nextFireAt.toISOString() : null,
    });
    await patchCounter({ threshold: cfg.counter.threshold });
    emitState();
    // Kick the counter once so the UI has fresh data immediately.
    void this.tickCounter().catch(() => undefined);
  }

  private armCronTimer(cron: AutoLintConfig["cron"]): void {
    if (this.cronTimer) clearTimeout(this.cronTimer);
    const target = computeNextFire(new Date(), cron);
    this.nextFireAt = target;
    const delay = safeDelay(target.getTime() - Date.now());
    this.cronTimer = setTimeout(() => {
      this.cronTimer = null;
      // If safeDelay clamped us short of the real target, re-arm without
      // firing.
      if (Date.now() < target.getTime() - 1000) {
        if (this.active?.cron.enabled) this.armCronTimer(cron);
        return;
      }
      void (async () => {
        try {
          await this.trigger("cron", `${cron.preset} ${pad2(cron.time.hour)}:${pad2(cron.time.minute)}`);
        } finally {
          if (this.active?.cron.enabled) {
            this.armCronTimer(cron);
            await writeRuntimeState({
              nextRunAt: this.nextFireAt
                ? this.nextFireAt.toISOString()
                : null,
            });
            emitState();
          }
        }
      })();
    }, delay);
  }

  private async stop(): Promise<void> {
    if (this.counterInterval) {
      clearInterval(this.counterInterval);
      this.counterInterval = null;
    }
    if (this.cronTimer) {
      clearTimeout(this.cronTimer);
      this.cronTimer = null;
    }
    if (this.ingestUnsubscribe) {
      try {
        this.ingestUnsubscribe();
      } catch {
        // ignore
      }
      this.ingestUnsubscribe = null;
    }
    this.nextFireAt = null;
    this.active = null;
  }

  /** Public entry the API uses for the "지금 실행" button. */
  async runNow(): Promise<AutoLintRuntime> {
    void this.trigger("manual", "manual run-now");
    return readRuntimeState();
  }

  private async tickCounter(): Promise<void> {
    const cfg = (await loadConfig()).autoLint;
    const { count, lastIngestAt, lastLintAt } =
      await countIngestSinceLastLint();
    const current = await readRuntimeState();
    const previousLastLintAt = current.counter.lastLintAt;
    const lintAdvanced =
      lastLintAt !== null && lastLintAt !== previousLastLintAt;

    const suggested = lintAdvanced
      ? false
      : current.counter.suggested ||
        (cfg.enabled && count >= cfg.counter.threshold);

    const wasSuggested = current.counter.suggested;
    await patchCounter({
      value: count,
      threshold: cfg.counter.threshold,
      lastIngestAt,
      lastLintAt,
      suggested,
    });
    emitState();

    if (!wasSuggested && suggested) {
      getAutoLintEvents().emitEvent({
        type: "suggestion",
        count,
        threshold: cfg.counter.threshold,
      });
    }
  }

  private async trigger(
    source: AutoLintSource,
    reason: string,
  ): Promise<void> {
    if (this.inFlight) {
      await recordSkip(source, "previous auto-lint run still in flight");
      return;
    }
    const cfg = (await loadConfig()).autoLint;
    if (!cfg.enabled && source !== "manual") {
      return;
    }
    if (cfg.skipIfBusy && (await lockFileExists())) {
      await recordSkip(source, "ingest lock 존재 — 다음 트리거까지 대기");
      return;
    }
    if (cfg.skipIfBusy && (await lintLockExists())) {
      await recordSkip(source, "lint lock 존재 — 다른 lint 실행 중");
      return;
    }
    const agent = resolveAgentForRole(await loadConfig(), "maintenance");
    if (!agent) {
      await recordSkip(source, "기본 코딩 에이전트 미설정");
      return;
    }

    this.inFlight = true;
    let lockHeld = false;
    try {
      await acquireLintLock();
      lockHeld = true;

      const startedAt = new Date();
      await writeRuntimeState({
        status: "running",
        reason: `${source}: ${reason}`,
        startedAt: startedAt.toISOString(),
      });
      emitState();
      getAutoLintEvents().emitEvent({
        type: "start",
        source,
        startedAt: startedAt.toISOString(),
      });
      await appendWikiLog(
        `## [${formatTimestamp(startedAt)}] lint | auto-trigger start (mode=${source}, reason=${truncate(reason, 80)})`,
      );

      let sessionPath: string | null = null;
      let halt: AutoLintRuntime["lastResult"] extends infer L
        ? L extends { halt: infer H }
          ? H
          : never
        : never = "normal";
      let haltReason = "";
      let durationMs = 0;
      let reportPath: string | null = null;

      try {
        const session = await newSession({
          subject: `auto-lint ${source}`,
          agent,
          origin: "background",
        });
        sessionPath = session.path;
        const cfgNow = await loadConfig();
        const lintTimeout = cfgNow.cli.timeouts.lint;
        const prompt = buildAutoLintPrompt({
          sessionPath,
          source,
          reason,
          fix: cfgNow.autoLint.fix,
        });
        const result = await runCli(agent, prompt, {
          safeMode: cfgNow.agent.safeMode,
          timeoutMs: lintTimeout ?? undefined,
          killOnAbort: lintTimeout != null,
          onStdout: () => undefined,
        });
        durationMs = result.durationMs;
        reportPath = await guessLatestReportPath();
        if (result.exitCode !== 0) {
          halt = "error";
          haltReason = `CLI exitCode=${result.exitCode}`;
        } else if (!reportPath) {
          halt = "noop";
          haltReason = "lint completed without writing a report";
        } else {
          halt = "normal";
          haltReason = `report at ${reportPath}`;
        }
      } catch (err) {
        halt = "error";
        haltReason = err instanceof Error ? err.message : String(err);
      }

      const endedAt = new Date();
      await appendWikiLog(
        `## [${formatTimestamp(endedAt)}] lint | auto-trigger ${halt} (source=${source}, reason=${truncate(haltReason, 80)})`,
      );

      const lastResult: AutoLintRuntime["lastResult"] = {
        halt,
        reason: haltReason,
        durationMs,
        source,
        sessionPath,
        reportPath,
      };

      await writeRuntimeState({
        status: "idle",
        reason: `${source} ${halt}`,
        startedAt: null,
        lastRunAt: endedAt.toISOString(),
        lastResult,
        nextRunAt: this.nextFireAt
          ? this.nextFireAt.toISOString()
          : null,
      });
      emitState();
      getAutoLintEvents().emitEvent({
        type: "done",
        source,
        halt,
        reason: haltReason,
        durationMs,
        sessionPath,
        reportPath,
      });
      // The fresh `lint |` entry in wiki/log.md will reset the counter via
      // the next tick — kick one immediately so the UI clears the suggestion.
      void this.tickCounter().catch(() => undefined);
    } finally {
      if (lockHeld) await releaseLintLock();
      this.inFlight = false;
    }
  }
}

async function recordSkip(
  source: AutoLintSource,
  reason: string,
): Promise<void> {
  await writeRuntimeState({
    status: "skipped",
    reason: `${source} skipped: ${reason}`,
  });
  emitState();
  getAutoLintEvents().emitEvent({ type: "skipped", source, reason });
  await appendWikiLog(
    `## [${formatTimestamp(new Date())}] lint | auto-trigger skipped (source=${source}, reason=${truncate(reason, 80)})`,
  );
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
      "[auto-lint] failed to append wiki/log.md:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Best-effort discovery of the report the lint run just wrote. Looks at
 * `wiki/lint/<YYYY-MM-DD>.md` and its same-day siblings (`_2`, `_3`, ...) and
 * returns the most recently modified one. Returns null if the directory has
 * no report for today.
 */
async function guessLatestReportPath(): Promise<string | null> {
  try {
    const dir = path.join(PROJECT_ROOT, "wiki", "lint");
    const entries = await fs.readdir(dir);
    const today = new Date().toISOString().slice(0, 10);
    const candidates = entries.filter(
      (name) => name.startsWith(today) && name.endsWith(".md"),
    );
    if (candidates.length === 0) return null;
    let best: { name: string; mtimeMs: number } | null = null;
    for (const name of candidates) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { name, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // skip
      }
    }
    if (!best) return null;
    return path.posix.join("wiki", "lint", best.name);
  } catch {
    return null;
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function emitState(): void {
  void readRuntimeState()
    .then((state) => {
      getAutoLintEvents().emitEvent({ type: "state", state });
    })
    .catch(() => undefined);
}

export function getAutoLintManager(): AutoLintManager {
  if (!globalRef.__autoLintManager) {
    globalRef.__autoLintManager = new AutoLintManager();
  }
  return globalRef.__autoLintManager;
}
