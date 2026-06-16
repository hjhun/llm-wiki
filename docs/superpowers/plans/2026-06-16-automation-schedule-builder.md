# Automation Schedule Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 6-field automation Schedule panel with a friendly frequency-type builder (every-N-minutes / hourly / daily / weekly multi-weekday / monthly / advanced cron) that auto-generates and validates cron, with a human-readable summary and next-run preview.

**Architecture:** All frequency types compile to a 5-field cron string stored as `schedule.mode="cron"` + `schedule.cron`, reusing the existing pure `cron.ts` scheduler. A new pure module `schedule-format.ts` handles friendly↔cron mapping, description, and validation. A new `ScheduleBuilder.tsx` client component renders the UI and delegates all logic to those pure modules. No schema, manager, or API changes.

**Tech Stack:** TypeScript, Next.js (React client components), Tailwind CSS, vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `webapp/lib/automation/schedule-format.ts` | NEW. Pure friendly↔cron mapping, `describeCron`, `validateFriendly`, `isDivisorOf`. No React/IO. |
| `webapp/lib/automation/schedule-format.test.ts` | NEW. Unit tests for the above. |
| `webapp/lib/automation/cron.ts` | MODIFY. Add `nextCronFires` preview helper. |
| `webapp/lib/automation/cron.test.ts` | NEW. Unit tests for `nextCronFires`. |
| `webapp/components/automation/ScheduleBuilder.tsx` | NEW. A-style chip + contextual-field builder. |
| `webapp/components/automation/Automations.tsx` | MODIFY. Replace Schedule panel with `<ScheduleBuilder>`, disable Save on invalid schedule. |

Reference (do not change): the `schedule` shape lives in `webapp/lib/config.ts`
(automation jobs) and is mirrored in `Automations.tsx` as
`AutomationJob["schedule"]`:
`{ mode: "preset"|"cron"; preset; cron: string; time: {hour,minute}; dayOfWeek; dayOfMonth; timezone }`.

---

## Task 1: schedule-format types + `friendlyToCron`

**Files:**
- Create: `webapp/lib/automation/schedule-format.ts`
- Test: `webapp/lib/automation/schedule-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webapp/lib/automation/schedule-format.test.ts
import { describe, expect, it } from "vitest";
import { friendlyToCron } from "./schedule-format";

describe("friendlyToCron", () => {
  it("every N minutes", () => {
    expect(friendlyToCron({ kind: "minutes", intervalMinutes: 10 })).toBe("*/10 * * * *");
  });
  it("hourly with interval 1 omits the step", () => {
    expect(friendlyToCron({ kind: "hourly", intervalHours: 1, minute: 30 })).toBe("30 * * * *");
  });
  it("hourly with interval N", () => {
    expect(friendlyToCron({ kind: "hourly", intervalHours: 2, minute: 30 })).toBe("30 */2 * * *");
  });
  it("daily", () => {
    expect(friendlyToCron({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
  });
  it("weekly sorts and joins weekdays", () => {
    expect(
      friendlyToCron({ kind: "weekly", hour: 9, minute: 0, weekdays: [4, 1] }),
    ).toBe("0 9 * * 1,4");
  });
  it("monthly", () => {
    expect(
      friendlyToCron({ kind: "monthly", hour: 9, minute: 0, dayOfMonth: 15 }),
    ).toBe("0 9 15 * *");
  });
  it("advanced passes the raw cron through trimmed", () => {
    expect(friendlyToCron({ kind: "advanced", cron: "  0 9 * * 1-5 " })).toBe("0 9 * * 1-5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: FAIL — `friendlyToCron` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// webapp/lib/automation/schedule-format.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/automation/schedule-format.ts webapp/lib/automation/schedule-format.test.ts
git commit -m "feat(automation): friendlyToCron schedule compiler"
```

---

## Task 2: `cronToFriendly` (cron → friendly, advanced fallback)

**Files:**
- Modify: `webapp/lib/automation/schedule-format.ts`
- Test: `webapp/lib/automation/schedule-format.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `schedule-format.test.ts`:

```ts
import { cronToFriendly } from "./schedule-format";

describe("cronToFriendly", () => {
  it("parses every N minutes", () => {
    expect(cronToFriendly("*/10 * * * *")).toEqual({ kind: "minutes", intervalMinutes: 10 });
  });
  it("parses hourly (no step) as interval 1", () => {
    expect(cronToFriendly("30 * * * *")).toEqual({ kind: "hourly", intervalHours: 1, minute: 30 });
  });
  it("parses hourly with step", () => {
    expect(cronToFriendly("30 */2 * * *")).toEqual({ kind: "hourly", intervalHours: 2, minute: 30 });
  });
  it("parses daily", () => {
    expect(cronToFriendly("0 9 * * *")).toEqual({ kind: "daily", minute: 0, hour: 9 });
  });
  it("parses weekly with multiple days, sorted", () => {
    expect(cronToFriendly("0 9 * * 4,1")).toEqual({
      kind: "weekly", minute: 0, hour: 9, weekdays: [1, 4],
    });
  });
  it("parses monthly", () => {
    expect(cronToFriendly("0 9 15 * *")).toEqual({
      kind: "monthly", minute: 0, hour: 9, dayOfMonth: 15,
    });
  });
  it("falls back to advanced for ranges/unmatched", () => {
    expect(cronToFriendly("0 9 * * 1-5")).toEqual({ kind: "advanced", cron: "0 9 * * 1-5" });
    expect(cronToFriendly("bogus")).toEqual({ kind: "advanced", cron: "bogus" });
  });
  it("round-trips friendly -> cron -> friendly", () => {
    const cases = ["*/10 * * * *", "30 * * * *", "30 */2 * * *", "0 9 * * *", "0 9 * * 1,4", "0 9 15 * *"];
    for (const c of cases) expect(friendlyToCron(cronToFriendly(c))).toBe(c);
  });
});
```

Add `cronToFriendly` to the existing top import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: FAIL — `cronToFriendly` not exported.

- [ ] **Step 3: Implement `cronToFriendly`**

Append to `schedule-format.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/automation/schedule-format.ts webapp/lib/automation/schedule-format.test.ts
git commit -m "feat(automation): cronToFriendly parser with advanced fallback"
```

---

## Task 3: `describeCron` + `validateFriendly`

**Files:**
- Modify: `webapp/lib/automation/schedule-format.ts`
- Test: `webapp/lib/automation/schedule-format.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `schedule-format.test.ts` (add `describeCron`, `validateFriendly` to import):

```ts
import { describeCron, validateFriendly } from "./schedule-format";

describe("describeCron", () => {
  it("describes known kinds in Korean", () => {
    expect(describeCron("*/10 * * * *")).toBe("10분마다");
    expect(describeCron("30 * * * *")).toBe("매시간 30분");
    expect(describeCron("0 9 * * *")).toBe("매일 09:00");
    expect(describeCron("0 9 * * 1,4")).toBe("매주 월·목 09:00");
    expect(describeCron("0 9 15 * *")).toBe("매월 15일 09:00");
  });
  it("describes advanced as 사용자 지정", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("사용자 지정 (0 9 * * 1-5)");
  });
});

describe("validateFriendly", () => {
  it("ok for a normal minutes divisor", () => {
    expect(validateFriendly({ kind: "minutes", intervalMinutes: 10 })).toEqual({ error: null, warning: null });
  });
  it("warns (not errors) for a non-divisor minute interval", () => {
    const v = validateFriendly({ kind: "minutes", intervalMinutes: 7 });
    expect(v.error).toBeNull();
    expect(v.warning).toContain("60");
  });
  it("errors for out-of-range minute interval", () => {
    expect(validateFriendly({ kind: "minutes", intervalMinutes: 0 }).error).not.toBeNull();
  });
  it("errors when weekly has no weekdays", () => {
    expect(validateFriendly({ kind: "weekly", hour: 9, minute: 0, weekdays: [] }).error).not.toBeNull();
  });
  it("errors for monthly day out of 1–28", () => {
    expect(validateFriendly({ kind: "monthly", hour: 9, minute: 0, dayOfMonth: 30 }).error).not.toBeNull();
  });
  it("delegates advanced to cron validation", () => {
    expect(validateFriendly({ kind: "advanced", cron: "0 9 * * *" }).error).toBeNull();
    expect(validateFriendly({ kind: "advanced", cron: "nope" }).error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: FAIL — `describeCron` / `validateFriendly` not exported.

- [ ] **Step 3: Implement both functions**

Append to `schedule-format.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run lib/automation/schedule-format.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/automation/schedule-format.ts webapp/lib/automation/schedule-format.test.ts
git commit -m "feat(automation): describeCron and validateFriendly"
```

---

## Task 4: `nextCronFires` preview helper in cron.ts

**Files:**
- Modify: `webapp/lib/automation/cron.ts` (add exported function near `validateCronExpression`)
- Test: `webapp/lib/automation/cron.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// webapp/lib/automation/cron.test.ts
import { describe, expect, it } from "vitest";
import { nextCronFires } from "./cron";

describe("nextCronFires", () => {
  it("returns the next N distinct fire times in order", () => {
    const from = new Date("2026-06-16T08:00:00");
    const fires = nextCronFires("0 9 * * *", 3, from); // daily 09:00
    expect(fires).toHaveLength(3);
    expect(fires[0].toISOString()).toBe(new Date("2026-06-16T09:00:00").toISOString());
    expect(fires[1].toISOString()).toBe(new Date("2026-06-17T09:00:00").toISOString());
    expect(fires[2].toISOString()).toBe(new Date("2026-06-18T09:00:00").toISOString());
  });
  it("returns an empty array for an invalid cron", () => {
    expect(nextCronFires("not a cron", 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webapp && npx vitest run lib/automation/cron.test.ts`
Expected: FAIL — `nextCronFires` not exported.

- [ ] **Step 3: Implement `nextCronFires`**

In `webapp/lib/automation/cron.ts`, add after `validateCronExpression` (it can call the
file-local `computeNextCronFire`):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd webapp && npx vitest run lib/automation/cron.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/automation/cron.ts webapp/lib/automation/cron.test.ts
git commit -m "feat(automation): nextCronFires preview helper"
```

---

## Task 5: `ScheduleBuilder` component

**Files:**
- Create: `webapp/components/automation/ScheduleBuilder.tsx`

This is a UI component; verification is typecheck + manual browser check (the
project gates on `tsc`, and has no React unit tests). Logic is fully delegated
to the Task 1–4 pure functions.

- [ ] **Step 1: Write the component**

```tsx
// webapp/components/automation/ScheduleBuilder.tsx
"use client";

import {
  cronToFriendly,
  describeCron,
  friendlyToCron,
  validateFriendly,
  type FriendlyKind,
  type FriendlySchedule,
} from "@/lib/automation/schedule-format";
import { nextCronFires } from "@/lib/automation/cron";

type Schedule = {
  mode: "preset" | "cron";
  preset: "hourly" | "daily" | "weekly" | "monthly";
  cron: string;
  time: { hour: number; minute: number };
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
};

const KINDS: Array<{ kind: FriendlyKind; label: string }> = [
  { kind: "minutes", label: "분마다" },
  { kind: "hourly", label: "시간마다" },
  { kind: "daily", label: "매일" },
  { kind: "weekly", label: "매주" },
  { kind: "monthly", label: "매월" },
  { kind: "advanced", label: "고급(cron)" },
];

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const MINUTE_OPTIONS = [5, 10, 15, 20, 30];
const HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

function presetToFriendly(s: Schedule): FriendlySchedule {
  const { hour, minute } = s.time;
  switch (s.preset) {
    case "hourly":
      return { kind: "hourly", intervalHours: 1, minute };
    case "weekly":
      return { kind: "weekly", hour, minute, weekdays: [s.dayOfWeek] };
    case "monthly":
      return { kind: "monthly", hour, minute, dayOfMonth: Math.min(28, Math.max(1, s.dayOfMonth)) };
    case "daily":
    default:
      return { kind: "daily", hour, minute };
  }
}

function deriveFriendly(s: Schedule): FriendlySchedule {
  return s.mode === "cron" ? cronToFriendly(s.cron) : presetToFriendly(s);
}

function withKind(f: FriendlySchedule, kind: FriendlyKind): FriendlySchedule {
  switch (kind) {
    case "minutes":
      return { kind, intervalMinutes: f.intervalMinutes ?? 10 };
    case "hourly":
      return { kind, intervalHours: f.intervalHours ?? 1, minute: f.minute ?? 0 };
    case "daily":
      return { kind, hour: f.hour ?? 9, minute: f.minute ?? 0 };
    case "weekly":
      return {
        kind,
        hour: f.hour ?? 9,
        minute: f.minute ?? 0,
        weekdays: f.weekdays && f.weekdays.length > 0 ? f.weekdays : [1],
      };
    case "monthly":
      return { kind, hour: f.hour ?? 9, minute: f.minute ?? 0, dayOfMonth: f.dayOfMonth ?? 1 };
    case "advanced":
    default:
      return { kind, cron: friendlyToCron(f) || "0 9 * * *" };
  }
}

function timeValue(f: FriendlySchedule): string {
  return `${String(f.hour ?? 9).padStart(2, "0")}:${String(f.minute ?? 0).padStart(2, "0")}`;
}

export default function ScheduleBuilder({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (next: Schedule) => void;
}) {
  const friendly = deriveFriendly(schedule);

  function emit(next: FriendlySchedule) {
    onChange({ ...schedule, mode: "cron", cron: friendlyToCron(next) });
  }

  function setTime(value: string) {
    const [h, m] = value.split(":").map(Number);
    emit({ ...friendly, hour: Math.min(23, Math.max(0, h || 0)), minute: Math.min(59, Math.max(0, m || 0)) });
  }

  function toggleWeekday(day: number) {
    const cur = friendly.weekdays ?? [];
    const on = cur.includes(day);
    // Keep at least one weekday selected.
    if (on && cur.length === 1) return;
    const weekdays = on ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b);
    emit({ ...friendly, weekdays });
  }

  const cron = schedule.mode === "cron" ? schedule.cron : friendlyToCron(friendly);
  const v = validateFriendly(friendly);
  const fires = nextCronFires(cron, 3);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => emit(withKind(friendly, kind))}
            className={[
              "rounded-full border px-3 py-1 text-xs",
              friendly.kind === kind
                ? "border-accent bg-accent/15 text-ink"
                : "border-line bg-bg text-ink-dim hover:text-ink",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {friendly.kind === "minutes" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-dim">
          매
          {MINUTE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => emit({ kind: "minutes", intervalMinutes: n })}
              className={chip(friendly.intervalMinutes === n)}
            >
              {n}
            </button>
          ))}
          <input
            type="number"
            min={1}
            max={59}
            value={friendly.intervalMinutes ?? 10}
            onChange={(e) =>
              emit({ kind: "minutes", intervalMinutes: Math.min(59, Math.max(1, Number(e.target.value) || 1)) })
            }
            className="w-16 rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
          />
          분마다
        </div>
      ) : null}

      {friendly.kind === "hourly" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-dim">
          매
          {HOUR_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => emit({ ...friendly, kind: "hourly", intervalHours: n })}
              className={chip(friendly.intervalHours === n)}
            >
              {n}
            </button>
          ))}
          시간마다,
          <input
            type="number"
            min={0}
            max={59}
            value={friendly.minute ?? 0}
            onChange={(e) =>
              emit({ ...friendly, kind: "hourly", minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })
            }
            className="w-16 rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
          />
          분에
        </div>
      ) : null}

      {friendly.kind === "daily" ? (
        <label className="flex items-center gap-2 text-sm text-ink-dim">
          매일
          <input
            type="time"
            value={timeValue(friendly)}
            onChange={(e) => setTime(e.target.value)}
            className="rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
          />
          에
        </label>
      ) : null}

      {friendly.kind === "weekly" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {WEEKDAY_LABELS.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => toggleWeekday(idx)}
                className={[
                  "h-8 w-8 rounded-lg border text-xs",
                  (friendly.weekdays ?? []).includes(idx)
                    ? "border-emerald-500 bg-emerald-500 text-black"
                    : "border-line bg-bg text-ink-dim",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-dim">
            시각
            <input
              type="time"
              value={timeValue(friendly)}
              onChange={(e) => setTime(e.target.value)}
              className="rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
            />
          </label>
        </div>
      ) : null}

      {friendly.kind === "monthly" ? (
        <label className="flex items-center gap-2 text-sm text-ink-dim">
          매월
          <input
            type="number"
            min={1}
            max={28}
            value={friendly.dayOfMonth ?? 1}
            onChange={(e) =>
              emit({ ...friendly, dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })
            }
            className="w-16 rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
          />
          일
          <input
            type="time"
            value={timeValue(friendly)}
            onChange={(e) => setTime(e.target.value)}
            className="rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-ink"
          />
          에
        </label>
      ) : null}

      {friendly.kind === "advanced" ? (
        <input
          value={schedule.mode === "cron" ? schedule.cron : friendlyToCron(friendly)}
          onChange={(e) => onChange({ ...schedule, mode: "cron", cron: e.target.value })}
          placeholder="0 9 * * 1-5"
          className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink"
        />
      ) : null}

      <div className="rounded border border-line bg-bg-subtle px-3 py-2">
        <div className="text-xs uppercase tracking-widest text-ink-faint">요약</div>
        <div className="mt-0.5 text-sm text-ink">{describeCron(cron)}</div>
        {fires.length > 0 ? (
          <div className="mt-1 text-xs text-ink-dim">
            다음: {fires.map((d) => formatFire(d)).join(" · ")}
          </div>
        ) : null}
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="font-mono text-accent">{cron || "—"}</span>
          {v.error ? (
            <span className="text-red-400">{v.error}</span>
          ) : v.warning ? (
            <span className="text-amber-400">{v.warning}</span>
          ) : (
            <span className="text-emerald-400">✓ 유효</span>
          )}
        </div>
      </div>
    </div>
  );
}

function chip(on: boolean): string {
  return [
    "rounded-full border px-2.5 py-0.5 text-xs",
    on ? "border-accent bg-accent/15 text-ink" : "border-line bg-bg text-ink-dim",
  ].join(" ");
}

function formatFire(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd webapp && npx tsc --noEmit`
Expected: no errors. (If `@/lib/...` alias fails, confirm `tsconfig.json` `paths` maps `@/*` to project root — it does for existing imports.)

- [ ] **Step 3: Commit**

```bash
git add webapp/components/automation/ScheduleBuilder.tsx
git commit -m "feat(automation): ScheduleBuilder friendly schedule UI component"
```

---

## Task 6: Wire `ScheduleBuilder` into Automations.tsx + Save guard

**Files:**
- Modify: `webapp/components/automation/Automations.tsx`

- [ ] **Step 1: Import the builder and validator**

Near the existing imports (after the `MarkdownPreview` import added earlier), add:

```tsx
import ScheduleBuilder from "./ScheduleBuilder";
import { validateFriendly, cronToFriendly } from "@/lib/automation/schedule-format";
```

- [ ] **Step 2: Replace the Schedule panel**

Replace the entire `<Panel title="Schedule" eyebrow="cron"> ... </Panel>` block
(currently `Automations.tsx` ~869–966, the grid of Mode/Preset/Time/Cron/Weekday/
Day-of-month) with:

```tsx
                <Panel title="Schedule" eyebrow="cron">
                  <ScheduleBuilder
                    schedule={draft.schedule}
                    onChange={(next) =>
                      setDraft((current) => ({ ...current, schedule: next }))
                    }
                  />
                </Panel>
```

- [ ] **Step 3: Disable Save when the schedule is invalid**

Compute a schedule-validity flag in the component body (near other derived
values such as `selectedRuntime`):

```tsx
  const scheduleError = useMemo(() => {
    const f =
      draft.schedule.mode === "cron"
        ? cronToFriendly(draft.schedule.cron)
        : null;
    return f ? validateFriendly(f).error : null;
  }, [draft.schedule]);
```

Then extend the existing "Save job" button's `disabled` prop (currently
`disabled={busy != null || draft.selectedAgents.length === 0}`):

```tsx
                      disabled={
                        busy != null ||
                        draft.selectedAgents.length === 0 ||
                        scheduleError != null
                      }
```

- [ ] **Step 4: Remove now-unused helpers (only if unreferenced)**

The old panel was the only user of `WEEKDAYS` and possibly `NumberField`. Run:

```bash
cd webapp && grep -n "WEEKDAYS\|NumberField" components/automation/Automations.tsx
```

If `WEEKDAYS` (line ~130) now has no remaining references, delete its declaration.
If `NumberField` (line ~1177) is still referenced elsewhere, keep it; otherwise
delete it. Do not delete `pad2` (used elsewhere).

- [ ] **Step 5: Typecheck**

Run: `cd webapp && npx tsc --noEmit`
Expected: no errors, no "declared but never used" for removed helpers.

- [ ] **Step 6: Commit**

```bash
git add webapp/components/automation/Automations.tsx
git commit -m "feat(automation): use ScheduleBuilder in the job editor"
```

---

## Task 7: Full gate + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automation test + typecheck gate**

Run: `cd webapp && npx tsc --noEmit && npx vitest run lib/automation`
Expected: tsc clean; all `schedule-format` and `cron` tests pass.

- [ ] **Step 2: Manual browser check**

Start dev (`cd webapp && npm run dev`), open the Automations tab (`:9091`, authenticated `lw_session`), select/create a job, and verify:
- Switching chips (분마다/시간마다/매일/매주/매월/고급) swaps the contextual fields.
- Weekly multi-select toggles days and refuses to clear the last one.
- The summary, next-run preview, and cron pill update live; invalid advanced cron shows a red error and disables "Save job".
- Save, reload, reopen the job: the builder restores the same kind/fields from the stored cron.

- [ ] **Step 3: Commit (if any manual fixes were needed)**

```bash
git add -A && git commit -m "fix(automation): schedule builder manual-test follow-ups"
```

---

## Self-Review Notes

- Spec §3 compile-to-cron → Tasks 1–4 (pure mapping) + Task 6 (parent writes `mode="cron"`).
- Spec §4 module API → Task 1 (`friendlyToCron`, types), Task 2 (`cronToFriendly`), Task 3 (`describeCron`, `validateFriendly`, `isDivisorOf`).
- Spec §5 `nextCronFires` → Task 4.
- Spec §6 component → Task 5; §7 data flow + §8 edge cases (last-weekday guard, monthly clamp, Save-disable on error) → Tasks 5–6.
- Spec §9 tests → Tasks 1–4 test steps + Task 7 gate.
- Names are consistent across tasks: `FriendlySchedule`, `friendlyToCron`, `cronToFriendly`, `describeCron`, `validateFriendly` (returns `{error, warning}`), `nextCronFires`, `ScheduleBuilder`.
- Out of scope (spec §1 비목표): timezone application, run history — not in any task.
