/**
 * Lightweight in-process stats for the Telegram webhook handler. Survives
 * for the lifetime of the Node process and is reset on restart. Persisting
 * it to disk is intentionally deferred until we have a clearer use case
 * past the M2 admin status panel.
 */
export type TelegramRuntimeStats = {
  startedAt: string;
  webhookRequests: number;
  dispatched: number;
  rejected: number;
  skipped: number;
  /** Messages dropped by the per-chat rate limiter (distinct from skipped). */
  throttled: number;
  errors: number;
  lastWebhookAt: string | null;
  lastDispatchAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
};

let stats: TelegramRuntimeStats = {
  startedAt: new Date().toISOString(),
  webhookRequests: 0,
  dispatched: 0,
  rejected: 0,
  skipped: 0,
  throttled: 0,
  errors: 0,
  lastWebhookAt: null,
  lastDispatchAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

export function snapshotStats(): TelegramRuntimeStats {
  return { ...stats };
}

export function noteWebhookRequest(): void {
  stats.webhookRequests += 1;
  stats.lastWebhookAt = new Date().toISOString();
}

export function noteDispatched(): void {
  stats.dispatched += 1;
  stats.lastDispatchAt = new Date().toISOString();
}

export function noteRejected(): void {
  stats.rejected += 1;
}

export function noteSkipped(): void {
  stats.skipped += 1;
}

export function noteThrottled(): void {
  stats.throttled += 1;
}

export function noteError(message: string): void {
  stats.errors += 1;
  stats.lastErrorAt = new Date().toISOString();
  stats.lastErrorMessage = message.slice(0, 500);
}
