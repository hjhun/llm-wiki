import type { AutomationJob } from "./types";

type PresetSchedule = AutomationJob["schedule"];

/**
 * Compute the next fire time for a schedule, honoring `schedule.timezone` (an
 * IANA zone such as `Asia/Seoul`). When the timezone is empty or invalid the
 * host's local time is used, preserving the original behavior. All wall-clock
 * matching (cron fields, preset times) is evaluated in the target zone, and DST
 * is handled because candidates are stepped/converted as absolute instants via
 * `Intl`.
 */
export function computeNextAutomationFire(
  now: Date,
  schedule: PresetSchedule,
): Date {
  const tz = normalizeTimeZone(schedule.timezone);
  if (schedule.mode === "cron") {
    return computeNextCronFire(now, schedule.cron, tz);
  }

  const { hour, minute } = schedule.time;
  const p = zonedParts(now, tz);

  if (schedule.preset === "hourly") {
    let candidate = wallClock(p.year, p.month, p.day, p.hour, minute, tz);
    if (candidate.getTime() <= now.getTime()) {
      candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
    }
    return candidate;
  }
  if (schedule.preset === "daily") {
    let candidate = wallClock(p.year, p.month, p.day, hour, minute, tz);
    if (candidate.getTime() <= now.getTime()) {
      const d = addCalendarDays(p.year, p.month, p.day, 1);
      candidate = wallClock(d.year, d.month, d.day, hour, minute, tz);
    }
    return candidate;
  }
  if (schedule.preset === "weekly") {
    let delta = schedule.dayOfWeek - p.weekday;
    if (delta < 0) delta += 7;
    const target = addCalendarDays(p.year, p.month, p.day, delta);
    let candidate = wallClock(target.year, target.month, target.day, hour, minute, tz);
    if (candidate.getTime() <= now.getTime()) {
      const next = addCalendarDays(p.year, p.month, p.day, delta + 7);
      candidate = wallClock(next.year, next.month, next.day, hour, minute, tz);
    }
    return candidate;
  }

  // monthly
  const day = Math.min(28, Math.max(1, schedule.dayOfMonth));
  let candidate = wallClock(p.year, p.month, day, hour, minute, tz);
  if (candidate.getTime() <= now.getTime()) {
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    candidate = wallClock(nextYear, nextMonth, day, hour, minute, tz);
  }
  return candidate;
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
  timeZone = "",
): Date[] {
  if (validateCronExpression(cron) !== null) return [];
  const tz = normalizeTimeZone(timeZone);
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    try {
      const next = computeNextCronFire(cursor, cron, tz);
      out.push(next);
      cursor = next;
    } catch {
      break;
    }
  }
  return out;
}

function computeNextCronFire(now: Date, expr: string, timeZone = ""): Date {
  const fields = parseCronExpression(expr);
  const tz = normalizeTimeZone(timeZone);
  // Step as absolute instants aligned to wall-clock minute boundaries (epoch is
  // a whole number of minutes for every supported zone), evaluating the cron
  // fields against the wall clock *in the target zone*.
  let t = Math.floor(now.getTime() / 60000) * 60000 + 60000;

  // Search up to two leap-safe years. Enough for the supported five-field
  // cron shape and avoids unbounded loops on impossible combinations.
  const max = 366 * 2 * 24 * 60;
  for (let i = 0; i < max; i += 1) {
    const p = zonedParts(new Date(t), tz);
    if (
      fields.minute.has(p.minute) &&
      fields.hour.has(p.hour) &&
      fields.month.has(p.month) &&
      fields.dayOfMonth.has(p.day) &&
      fields.dayOfWeek.has(p.weekday)
    ) {
      return new Date(t);
    }
    t += 60000;
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
    // A "*" base in a step (e.g. */10) means the full range for the field;
    // otherwise the body is a single value or an explicit a-b range.
    let start: number;
    let end: number;
    if (body === "*") {
      start = min;
      end = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(body);
      start = rangeMatch ? Number(rangeMatch[1]) : Number(body);
      end = rangeMatch ? Number(rangeMatch[2]) : Number(body);
    }
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

// --- Timezone helpers ---------------------------------------------------
// Implemented with the built-in Intl API so no timezone database dependency is
// needed. An empty/invalid zone falls back to the host's local time, which
// matches the original behavior for jobs without an explicit timezone.

type WallClock = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0(Sun)-6(Sat)
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const validZoneCache = new Map<string, boolean>();

/** Return the zone if it is a usable IANA timezone, otherwise "" (local). */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
  const tz = (timeZone ?? "").trim();
  if (!tz) return "";
  let ok = validZoneCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    validZoneCache.set(tz, ok);
  }
  return ok ? tz : "";
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock fields of an absolute instant in the given zone ("" = local). */
function zonedParts(date: Date, timeZone: string): WallClock {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  const parts: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Offset (ms) of the zone at a given instant: wall-clock-as-UTC minus instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const p: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - instant;
}

/**
 * The absolute instant of a wall-clock time in a zone ("" = local). Uses the
 * standard guess-then-correct algorithm so DST offset changes resolve to the
 * right instant.
 */
function wallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, 0, 0);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = zoneOffsetMs(guess, timeZone);
  let instant = guess - off1;
  const off2 = zoneOffsetMs(instant, timeZone);
  if (off2 !== off1) instant = guess - off2;
  return new Date(instant);
}

/** Pure calendar arithmetic on a date (no DST), returning Y/M/D fields. */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day) + n * 86_400_000);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

export const MAX_DELAY_MS = 23 * 24 * 60 * 60 * 1000;

export function safeAutomationDelay(delayMs: number): number {
  if (delayMs <= 0) return 0;
  if (delayMs > MAX_DELAY_MS) return MAX_DELAY_MS;
  return delayMs;
}
