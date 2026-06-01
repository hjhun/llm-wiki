import "server-only";

import { loadConfig, type Config } from "../config";
import { deleteWebhook, getUpdates } from "./api";
import { dispatchUpdate } from "./handlers";
import { noteError } from "./runtime-state";

const POLL_TIMEOUT_SEC = 30;
const ERROR_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000];

type ManagerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "error"
  | "disabled";

type PollingState = {
  status: ManagerStatus;
  startedAt: string | null;
  lastPolledAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  consecutiveErrors: number;
};

let state: PollingState = {
  status: "stopped",
  startedAt: null,
  lastPolledAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  consecutiveErrors: 0,
};

let loopAbort: AbortController | null = null;
let activeToken: string | null = null;
let nextOffset: number | undefined = undefined;

const globalRef = globalThis as unknown as {
  __telegramPolling?: { running: boolean; loop: Promise<void> | null };
};

if (!globalRef.__telegramPolling) {
  globalRef.__telegramPolling = { running: false, loop: null };
}

export function snapshotPolling(): PollingState {
  return { ...state };
}

function setStatus(status: ManagerStatus, extra: Partial<PollingState> = {}) {
  state = { ...state, status, ...extra };
}

async function pollOnce(token: string): Promise<void> {
  const updates = await getUpdates(token, {
    offset: nextOffset,
    timeoutSec: POLL_TIMEOUT_SEC,
  });
  state.lastPolledAt = new Date().toISOString();
  state.consecutiveErrors = 0;
  for (const update of updates) {
    // Advance the offset eagerly so a slow dispatch doesn't replay a
    // partially-processed update on the next poll.
    nextOffset = update.update_id + 1;
    await dispatchUpdate(update).catch((err) => {
      noteError(err instanceof Error ? err.message : String(err));
    });
  }
}

async function runLoop(token: string, signal: AbortSignal): Promise<void> {
  setStatus("running", { startedAt: new Date().toISOString() });
  while (!signal.aborted) {
    try {
      await pollOnce(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.consecutiveErrors += 1;
      state.lastErrorAt = new Date().toISOString();
      state.lastErrorMessage = message.slice(0, 500);
      noteError(`polling: ${message}`);
      setStatus(state.consecutiveErrors > 3 ? "error" : "running");
      const idx = Math.min(state.consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1);
      const backoff = ERROR_BACKOFF_MS[idx] ?? 30_000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
  setStatus("stopped");
}

/**
 * Idempotent start: noop if a loop is already running for the same token.
 * The caller is expected to also clear any active webhook with
 * `deleteWebhook` so Telegram does not split updates between channels.
 */
async function start(cfg: Config["telegram"]): Promise<void> {
  if (loopAbort) await stop();
  if (!cfg.enabled || cfg.mode !== "polling" || !cfg.botToken) {
    setStatus(cfg.enabled ? "disabled" : "stopped");
    return;
  }
  // Ensure no webhook is set; polling and webhook are mutually exclusive
  // on the Telegram side. If a webhook was registered earlier we drop it
  // here so updates start landing on getUpdates.
  try {
    await deleteWebhook(cfg.botToken);
  } catch {
    // Best-effort cleanup. Telegram returns an error if no webhook is set
    // — that is fine and we proceed anyway.
  }
  const controller = new AbortController();
  loopAbort = controller;
  activeToken = cfg.botToken;
  nextOffset = undefined;
  setStatus("starting");
  globalRef.__telegramPolling!.running = true;
  globalRef.__telegramPolling!.loop = runLoop(cfg.botToken, controller.signal)
    .catch((err) => {
      state.lastErrorMessage =
        err instanceof Error ? err.message : String(err);
      setStatus("error");
    })
    .finally(() => {
      globalRef.__telegramPolling!.running = false;
    });
}

export async function stop(): Promise<void> {
  if (loopAbort) {
    loopAbort.abort();
    loopAbort = null;
  }
  if (globalRef.__telegramPolling?.loop) {
    try {
      await globalRef.__telegramPolling.loop;
    } catch {
      // The loop swallows its own errors; ignore.
    }
  }
  activeToken = null;
  globalRef.__telegramPolling!.running = false;
  globalRef.__telegramPolling!.loop = null;
  setStatus("stopped");
}

/**
 * Boot or reboot the poller using the current saved config. Called from
 * instrumentation-node on server start and from the setup route after
 * the admin flips the mode.
 */
export async function rebootPolling(): Promise<void> {
  const cfg = await loadConfig(true);
  await start(cfg.telegram);
}

export function isRunning(): boolean {
  return globalRef.__telegramPolling?.running === true;
}

export function activeTokenFingerprint(): string | null {
  if (!activeToken) return null;
  return activeToken.slice(0, 6) + "…" + activeToken.slice(-4);
}
