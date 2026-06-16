import type { AutomationJob } from "./types";

type PresetSchedule = AutomationJob["schedule"];

export function computeNextAutomationFire(
  now: Date,
  schedule: PresetSchedule,
): Date {
  if (schedule.mode === "cron") {
    return computeNextCronFire(now, schedule.cron);
  }

  const base = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    schedule.time.hour,
    schedule.time.minute,
    0,
    0,
  );

  if (schedule.preset === "hourly") {
    const next = new Date(now.getTime());
    next.setMinutes(schedule.time.minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setHours(next.getHours() + 1);
    return next;
  }
  if (schedule.preset === "daily") {
    if (base.getTime() > now.getTime()) return base;
    return addDays(base, 1);
  }
  if (schedule.preset === "weekly") {
    let delta = schedule.dayOfWeek - now.getDay();
    if (delta < 0) delta += 7;
    const candidate = addDays(base, delta);
    return candidate.getTime() > now.getTime()
      ? candidate
      : addDays(candidate, 7);
  }

  const day = Math.min(28, Math.max(1, schedule.dayOfMonth));
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    day,
    schedule.time.hour,
    schedule.time.minute,
    0,
    0,
  );
  if (candidate.getTime() > now.getTime()) return candidate;
  return new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    day,
    schedule.time.hour,
    schedule.time.minute,
    0,
    0,
  );
}

export function validateCronExpression(expr: string): string | null {
  try {
    parseCronExpression(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function nextCronFires(
  cron: string,
  count: number,
  from: Date = new Date(),
): Date[] {
  if (validateCronExpression(cron) !== null) return [];
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    try {
      const next = computeNextCronFire(cursor, cron);
      out.push(next);
      cursor = next;
    } catch {
      break;
    }
  }
  return out;
}

function computeNextCronFire(now: Date, expr: string): Date {
  const fields = parseCronExpression(expr);
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Search up to two leap-safe years. Enough for the supported five-field
  // cron shape and avoids unbounded loops on impossible combinations.
  const max = 366 * 2 * 24 * 60;
  for (let i = 0; i < max; i += 1) {
    if (
      fields.minute.has(cursor.getMinutes()) &&
      fields.hour.has(cursor.getHours()) &&
      fields.month.has(cursor.getMonth() + 1) &&
      fields.dayOfMonth.has(cursor.getDate()) &&
      fields.dayOfWeek.has(cursor.getDay())
    ) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error("cron expression has no matching time in the next two years");
}

function parseCronExpression(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must have 5 fields");
  }
  return {
    minute: parseField(parts[0], 0, 59, "minute"),
    hour: parseField(parts[1], 0, 23, "hour"),
    dayOfMonth: parseField(parts[2], 1, 31, "day-of-month"),
    month: parseField(parts[3], 1, 12, "month"),
    dayOfWeek: parseField(parts[4], 0, 6, "day-of-week"),
  };
}

function parseField(raw: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "*") {
      for (let n = min; n <= max; n += 1) out.add(n);
      continue;
    }
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const body = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`${label} step must be a positive integer`);
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(body);
    const start = rangeMatch ? Number(rangeMatch[1]) : Number(body);
    const end = rangeMatch ? Number(rangeMatch[2]) : Number(body);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`${label} field is out of range`);
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return out;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + n);
  return next;
}

export const MAX_DELAY_MS = 23 * 24 * 60 * 60 * 1000;

export function safeAutomationDelay(delayMs: number): number {
  if (delayMs <= 0) return 0;
  if (delayMs > MAX_DELAY_MS) return MAX_DELAY_MS;
  return delayMs;
}
