import { validateCronExpression } from "./cron";
import type { Language } from "../i18n";

export type FriendlyKind =
  | "minutes"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "advanced";

export type FriendlySchedule = {
  kind: FriendlyKind;
  intervalMinutes?: number; // minutes:  1–59
  intervalHours?: number;   // hourly:   1,2,3,4,6,8,12
  minute?: number;          // hourly/daily/weekly/monthly: 0–59
  hour?: number;            // daily/weekly/monthly:        0–23
  weekdays?: number[];      // weekly:   0(Sun)–6(Sat), >=1
  dayOfMonth?: number;      // monthly:  1–28
  cron?: string;            // advanced: raw 5-field
};

export type FriendlyValidation = { error: string | null; warning: string | null };

const SCHEDULE_TEXT = {
  ko: {
    days: ["일", "월", "화", "수", "목", "금", "토"],
    everyMinutes: (value: number | undefined) => `${value}분마다`,
    hourlyAt: (minute: number | undefined) =>
      `매시간 ${String(minute ?? 0).padStart(2, "0")}분`,
    everyHoursAt: (hours: number | undefined, minute: number | undefined) =>
      `${hours}시간마다 ${String(minute ?? 0).padStart(2, "0")}분`,
    dailyAt: (time: string) => `매일 ${time}`,
    weeklyAt: (days: string, time: string) => `매주 ${days} ${time}`,
    monthlyAt: (day: number | undefined, time: string) => `매월 ${day}일 ${time}`,
    custom: (cron: string) => `사용자 지정 (${cron})`,
    minuteRange: "분 간격은 1–59 사이여야 합니다",
    unevenMinute: (value: number) =>
      `${value}은 60의 약수가 아니라 매시 경계에서 간격이 일정하지 않습니다`,
    hourRange: "시간 간격은 1·2·3·4·6·8·12 중 하나여야 합니다",
    minuteValueRange: "분은 0–59 사이여야 합니다",
    invalidTime: "시각이 올바르지 않습니다",
    weekdayRequired: "요일을 최소 1개 선택하세요",
    dayOfMonthRange: "일자는 1–28 사이여야 합니다",
  },
  en: {
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    everyMinutes: (value: number | undefined) => `Every ${value} minutes`,
    hourlyAt: (minute: number | undefined) =>
      `Every hour at :${String(minute ?? 0).padStart(2, "0")}`,
    everyHoursAt: (hours: number | undefined, minute: number | undefined) =>
      `Every ${hours} hours at :${String(minute ?? 0).padStart(2, "0")}`,
    dailyAt: (time: string) => `Daily at ${time}`,
    weeklyAt: (days: string, time: string) => `Weekly on ${days} at ${time}`,
    monthlyAt: (day: number | undefined, time: string) =>
      `Monthly on day ${day} at ${time}`,
    custom: (cron: string) => `Custom (${cron})`,
    minuteRange: "Minute interval must be between 1 and 59.",
    unevenMinute: (value: number) =>
      `${value} does not divide evenly into 60, so spacing resets at hour boundaries.`,
    hourRange: "Hour interval must be one of 1, 2, 3, 4, 6, 8, or 12.",
    minuteValueRange: "Minute must be between 0 and 59.",
    invalidTime: "Time is invalid.",
    weekdayRequired: "Select at least one weekday.",
    dayOfMonthRange: "Day must be between 1 and 28.",
  },
} as const;

export const KOR_DAYS = SCHEDULE_TEXT.ko.days;

export function isDivisorOf(n: number, base: number): boolean {
  return Number.isInteger(n) && n > 0 && base % n === 0;
}

export function friendlyToCron(f: FriendlySchedule): string {
  switch (f.kind) {
    case "minutes":
      return `*/${f.intervalMinutes ?? 10} * * * *`;
    case "hourly": {
      const n = f.intervalHours ?? 1;
      const m = f.minute ?? 0;
      return n === 1 ? `${m} * * * *` : `${m} */${n} * * *`;
    }
    case "daily":
      return `${f.minute ?? 0} ${f.hour ?? 9} * * *`;
    case "weekly": {
      const days = (f.weekdays && f.weekdays.length > 0 ? f.weekdays : [1])
        .slice()
        .sort((a, b) => a - b);
      return `${f.minute ?? 0} ${f.hour ?? 9} * * ${days.join(",")}`;
    }
    case "monthly":
      return `${f.minute ?? 0} ${f.hour ?? 9} ${f.dayOfMonth ?? 1} * *`;
    case "advanced":
    default:
      return (f.cron ?? "").trim();
  }
}

function hhmm(hour?: number, minute?: number): string {
  return `${String(hour ?? 0).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

export function describeCron(cron: string, language: Language = "ko"): string {
  const f = cronToFriendly(cron);
  const text = SCHEDULE_TEXT[language];
  switch (f.kind) {
    case "minutes":
      return text.everyMinutes(f.intervalMinutes);
    case "hourly":
      return f.intervalHours === 1
        ? text.hourlyAt(f.minute)
        : text.everyHoursAt(f.intervalHours, f.minute);
    case "daily":
      return text.dailyAt(hhmm(f.hour, f.minute));
    case "weekly":
      return text.weeklyAt(
        (f.weekdays ?? []).map((d) => text.days[d]).join("·"),
        hhmm(f.hour, f.minute),
      );
    case "monthly":
      return text.monthlyAt(f.dayOfMonth, hhmm(f.hour, f.minute));
    case "advanced":
    default:
      return text.custom(cron.trim());
  }
}

const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

export function validateFriendly(
  f: FriendlySchedule,
  language: Language = "ko",
): FriendlyValidation {
  const ok: FriendlyValidation = { error: null, warning: null };
  const text = SCHEDULE_TEXT[language];
  switch (f.kind) {
    case "minutes": {
      const n = f.intervalMinutes ?? 0;
      if (!Number.isInteger(n) || n < 1 || n > 59) {
        return { error: text.minuteRange, warning: null };
      }
      if (!isDivisorOf(n, 60)) {
        return { error: null, warning: text.unevenMinute(n) };
      }
      return ok;
    }
    case "hourly": {
      if (!HOURLY_INTERVALS.includes(f.intervalHours ?? 0)) {
        return { error: text.hourRange, warning: null };
      }
      const m = f.minute ?? 0;
      if (m < 0 || m > 59) return { error: text.minuteValueRange, warning: null };
      return ok;
    }
    case "daily":
    case "weekly":
    case "monthly": {
      const m = f.minute ?? 0;
      const h = f.hour ?? 0;
      if (m < 0 || m > 59 || h < 0 || h > 23) {
        return { error: text.invalidTime, warning: null };
      }
      if (f.kind === "weekly" && (!f.weekdays || f.weekdays.length < 1)) {
        return { error: text.weekdayRequired, warning: null };
      }
      if (f.kind === "monthly") {
        const d = f.dayOfMonth ?? 0;
        if (d < 1 || d > 28) return { error: text.dayOfMonthRange, warning: null };
      }
      return ok;
    }
    case "advanced":
    default:
      return { error: validateCronExpression((f.cron ?? "").trim()), warning: null };
  }
}

export function cronToFriendly(cron: string): FriendlySchedule {
  const trimmed = cron.trim();
  const advanced = (): FriendlySchedule => ({ kind: "advanced", cron: trimmed });
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return advanced();
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== "*") return advanced();

  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === "*" && dom === "*" && dow === "*") {
    return { kind: "minutes", intervalMinutes: Number(stepMin[1]) };
  }

  const m = /^(\d+)$/.exec(min);
  if (!m) return advanced();
  const minute = Number(m[1]);

  if (dom === "*" && dow === "*") {
    if (hour === "*") return { kind: "hourly", intervalHours: 1, minute };
    const stepHour = /^\*\/(\d+)$/.exec(hour);
    if (stepHour) return { kind: "hourly", intervalHours: Number(stepHour[1]), minute };
  }

  const h = /^(\d+)$/.exec(hour);
  if (!h) return advanced();
  const hour24 = Number(h[1]);

  if (dom === "*" && dow === "*") {
    return { kind: "daily", minute, hour: hour24 };
  }
  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map((x) => Number(x));
    if (days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { kind: "weekly", minute, hour: hour24, weekdays: days.sort((a, b) => a - b) };
    }
    return advanced();
  }
  if (dow === "*") {
    const d = /^(\d+)$/.exec(dom);
    if (d) return { kind: "monthly", minute, hour: hour24, dayOfMonth: Number(d[1]) };
  }
  return advanced();
}
