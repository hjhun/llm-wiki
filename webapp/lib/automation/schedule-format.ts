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
