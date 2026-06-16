import { validateCronExpression } from "./cron";

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

export const KOR_DAYS = ["일", "월", "화", "수", "목", "금", "토"];

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

export function describeCron(cron: string): string {
  const f = cronToFriendly(cron);
  switch (f.kind) {
    case "minutes":
      return `${f.intervalMinutes}분마다`;
    case "hourly":
      return f.intervalHours === 1
        ? `매시간 ${String(f.minute ?? 0).padStart(2, "0")}분`
        : `${f.intervalHours}시간마다 ${String(f.minute ?? 0).padStart(2, "0")}분`;
    case "daily":
      return `매일 ${hhmm(f.hour, f.minute)}`;
    case "weekly":
      return `매주 ${(f.weekdays ?? []).map((d) => KOR_DAYS[d]).join("·")} ${hhmm(f.hour, f.minute)}`;
    case "monthly":
      return `매월 ${f.dayOfMonth}일 ${hhmm(f.hour, f.minute)}`;
    case "advanced":
    default:
      return `사용자 지정 (${cron.trim()})`;
  }
}

const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

export function validateFriendly(f: FriendlySchedule): FriendlyValidation {
  const ok: FriendlyValidation = { error: null, warning: null };
  switch (f.kind) {
    case "minutes": {
      const n = f.intervalMinutes ?? 0;
      if (!Number.isInteger(n) || n < 1 || n > 59) {
        return { error: "분 간격은 1–59 사이여야 합니다", warning: null };
      }
      if (!isDivisorOf(n, 60)) {
        return { error: null, warning: `${n}은 60의 약수가 아니라 매시 경계에서 간격이 일정하지 않습니다` };
      }
      return ok;
    }
    case "hourly": {
      if (!HOURLY_INTERVALS.includes(f.intervalHours ?? 0)) {
        return { error: "시간 간격은 1·2·3·4·6·8·12 중 하나여야 합니다", warning: null };
      }
      const m = f.minute ?? 0;
      if (m < 0 || m > 59) return { error: "분은 0–59 사이여야 합니다", warning: null };
      return ok;
    }
    case "daily":
    case "weekly":
    case "monthly": {
      const m = f.minute ?? 0;
      const h = f.hour ?? 0;
      if (m < 0 || m > 59 || h < 0 || h > 23) {
        return { error: "시각이 올바르지 않습니다", warning: null };
      }
      if (f.kind === "weekly" && (!f.weekdays || f.weekdays.length < 1)) {
        return { error: "요일을 최소 1개 선택하세요", warning: null };
      }
      if (f.kind === "monthly") {
        const d = f.dayOfMonth ?? 0;
        if (d < 1 || d > 28) return { error: "일자는 1–28 사이여야 합니다", warning: null };
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
