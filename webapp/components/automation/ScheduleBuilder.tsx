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
