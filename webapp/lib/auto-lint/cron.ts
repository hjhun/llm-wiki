import type { Config } from "../config";

export type CronConfig = Config["autoLint"]["cron"];

/**
 * Returns the next firing time strictly after `now` for the given preset.
 * Pure date math; no library required.
 *
 * - daily   → today at HH:MM if still in the future, else tomorrow.
 * - weekly  → next occurrence of `dayOfWeek` at HH:MM. If that's today
 *             but HH:MM has already passed, jumps a week.
 * - monthly → next occurrence of `dayOfMonth` (1..28) at HH:MM. If that's
 *             today and HH:MM has passed, jumps to next month.
 */
export function computeNextFire(now: Date, cfg: CronConfig): Date {
  const { preset, time, dayOfWeek, dayOfMonth } = cfg;
  const base = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    time.hour,
    time.minute,
    0,
    0,
  );

  if (preset === "daily") {
    if (base.getTime() > now.getTime()) return base;
    return addDays(base, 1);
  }

  if (preset === "weekly") {
    const target = clampWeekday(dayOfWeek);
    const current = now.getDay();
    let delta = target - current;
    if (delta < 0) delta += 7;
    const candidate = addDays(base, delta);
    if (candidate.getTime() <= now.getTime()) {
      return addDays(candidate, 7);
    }
    return candidate;
  }

  // monthly
  const day = clampDayOfMonth(dayOfMonth);
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    day,
    time.hour,
    time.minute,
    0,
    0,
  );
  if (candidate.getTime() > now.getTime()) return candidate;
  return new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    day,
    time.hour,
    time.minute,
    0,
    0,
  );
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + n);
  return next;
}

function clampWeekday(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  if (i > 6) return 6;
  return i;
}

function clampDayOfMonth(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > 28) return 28;
  return i;
}

/**
 * Node's setTimeout caps at ~24.8 days. For monthly schedules the delay can
 * exceed that. Caller should arm a single timeout whose value is clamped to
 * `MAX_DELAY_MS`; on fire, if the real target time has not yet arrived, the
 * caller re-computes and re-arms.
 */
export const MAX_DELAY_MS = 23 * 24 * 60 * 60 * 1000;

export function safeDelay(delayMs: number): number {
  if (delayMs <= 0) return 0;
  if (delayMs > MAX_DELAY_MS) return MAX_DELAY_MS;
  return delayMs;
}
