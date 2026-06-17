"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../i18n";
import type { SettingsConfig } from "./types";

type AutoLintRuntime = {
  status: "idle" | "running" | "skipped" | "disabled";
  reason: string | null;
  counter: {
    value: number;
    threshold: number;
    lastIngestAt: string | null;
    lastLintAt: string | null;
    suggested: boolean;
  };
  startedAt: string | null;
  lastRunAt: string | null;
  lastResult: {
    halt: "normal" | "error" | "skipped" | "noop";
    reason: string;
    durationMs: number;
    source: "cron" | "manual";
    sessionPath: string | null;
    reportPath: string | null;
  } | null;
  nextRunAt: string | null;
  cronEnabled: boolean;
};

type StatusResponse = {
  config: SettingsConfig["autoLint"];
  runtime: AutoLintRuntime;
};

function statusTone(status: AutoLintRuntime["status"]) {
  switch (status) {
    case "running":
      return "status-warning";
    case "skipped":
      return "status-skipped";
    case "disabled":
      return "status-disabled";
    case "idle":
    default:
      return "status-ready";
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export default function AutoLintPanel({
  draft,
  onChange,
}: {
  draft: SettingsConfig["autoLint"];
  onChange: (next: SettingsConfig["autoLint"]) => void;
}) {
  const { t, formatDateTime } = useLanguage();
  const [runtime, setRuntime] = useState<AutoLintRuntime | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-lint/status", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as StatusResponse;
      setRuntime(json.runtime);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const runNow = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/auto-lint/run-now", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const statusLabel = (() => {
    if (!runtime) return t.settings.autoIngestStatusIdle;
    switch (runtime.status) {
      case "running":
        return t.settings.autoIngestStatusRunning;
      case "skipped":
        return t.settings.autoIngestStatusSkipped;
      case "disabled":
        return t.settings.autoIngestStatusDisabled;
      case "idle":
      default:
        return t.settings.autoIngestStatusIdle;
    }
  })();

  const presetTime = `${pad2(draft.cron.time.hour)}:${pad2(draft.cron.time.minute)}`;
  const weeklyActive = draft.cron.preset === "weekly";
  const monthlyActive = draft.cron.preset === "monthly";

  return (
    <section className="rounded-md border border-line bg-bg-subtle">
      <header className="border-b border-line px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          auto trigger
        </div>
        <h2 className="mt-1 text-sm font-semibold text-ink">
          {t.settings.autoLint}
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          {t.settings.autoLintDesc}
        </p>
      </header>
      <div className="space-y-4 p-4">
        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span className="text-sm font-medium text-ink">
            {t.settings.autoLintEnabled}
          </span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <div className="rounded border border-line bg-bg px-3 py-2">
          <div className="text-xs uppercase tracking-widest text-ink-faint">
            {t.settings.autoLintCounter}
          </div>
          <label className="mt-2 block">
            <span className="text-xs text-ink-faint">
              {t.settings.autoLintThreshold}
            </span>
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              value={draft.counter.threshold}
              onChange={(e) =>
                onChange({
                  ...draft,
                  counter: {
                    ...draft.counter,
                    threshold: Math.max(1, Number(e.target.value) || 1),
                  },
                })
              }
              className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          </label>
        </div>

        <div className="rounded border border-line bg-bg px-3 py-2">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-ink">
              {t.settings.autoLintCronEnabled}
            </span>
            <input
              type="checkbox"
              checked={draft.cron.enabled}
              onChange={(e) =>
                onChange({
                  ...draft,
                  cron: { ...draft.cron, enabled: e.target.checked },
                })
              }
              className="h-4 w-4 accent-accent"
            />
          </label>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs text-ink-faint">
                {t.settings.autoLintCronPreset}
              </span>
              <select
                value={draft.cron.preset}
                disabled={!draft.cron.enabled}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    cron: {
                      ...draft.cron,
                      preset: e.target
                        .value as SettingsConfig["autoLint"]["cron"]["preset"],
                    },
                  })
                }
                className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="daily">{t.settings.autoLintCronPresetDaily}</option>
                <option value="weekly">{t.settings.autoLintCronPresetWeekly}</option>
                <option value="monthly">{t.settings.autoLintCronPresetMonthly}</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-ink-faint">
                {t.settings.autoLintCronTime}
              </span>
              <input
                type="time"
                value={presetTime}
                disabled={!draft.cron.enabled}
                onChange={(e) => {
                  const [hStr, mStr] = e.target.value.split(":");
                  const hour = Math.min(23, Math.max(0, Number(hStr) || 0));
                  const minute = Math.min(59, Math.max(0, Number(mStr) || 0));
                  onChange({
                    ...draft,
                    cron: { ...draft.cron, time: { hour, minute } },
                  });
                }}
                className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <label
              className={[
                "block",
                weeklyActive && draft.cron.enabled ? "" : "opacity-50",
              ].join(" ")}
            >
              <span className="text-xs text-ink-faint">
                {t.settings.autoLintCronDayOfWeek}
              </span>
              <select
                value={draft.cron.dayOfWeek}
                disabled={!draft.cron.enabled || !weeklyActive}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    cron: {
                      ...draft.cron,
                      dayOfWeek: Math.min(
                        6,
                        Math.max(0, Number(e.target.value) || 0),
                      ),
                    },
                  })
                }
                className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed"
              >
                {t.settings.autoLintWeekdayShort.map((label, idx) => (
                  <option key={idx} value={idx}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={[
                "block",
                monthlyActive && draft.cron.enabled ? "" : "opacity-50",
              ].join(" ")}
            >
              <span className="text-xs text-ink-faint">
                {t.settings.autoLintCronDayOfMonth}
              </span>
              <input
                type="number"
                min={1}
                max={28}
                step={1}
                value={draft.cron.dayOfMonth}
                disabled={!draft.cron.enabled || !monthlyActive}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    cron: {
                      ...draft.cron,
                      dayOfMonth: Math.min(
                        28,
                        Math.max(1, Number(e.target.value) || 1),
                      ),
                    },
                  })
                }
                className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed"
              />
            </label>
          </div>
        </div>

        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span>
            <span className="block text-sm font-medium text-ink">
              {t.settings.autoLintFix}
            </span>
            <span className="block text-xs text-ink-faint">
              {t.settings.autoLintFixDesc}
            </span>
          </span>
          <input
            type="checkbox"
            checked={draft.fix}
            onChange={(e) => onChange({ ...draft, fix: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span>
            <span className="block text-sm font-medium text-ink">
              {t.settings.autoLintSkipIfBusy}
            </span>
            <span className="block text-xs text-ink-faint">
              {t.settings.autoLintSkipIfBusyDesc}
            </span>
          </span>
          <input
            type="checkbox"
            checked={draft.skipIfBusy}
            onChange={(e) =>
              onChange({ ...draft, skipIfBusy: e.target.checked })
            }
            className="h-4 w-4 accent-accent"
          />
        </label>

        <div className="rounded border border-line bg-bg px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-widest text-ink-faint">
              {t.settings.autoLintStatus}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(
                runtime?.status ?? "disabled",
              )}`}
            >
              {statusLabel}
            </span>
          </div>
          <dl className="mt-3 grid gap-1 text-xs text-ink-dim">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">
                {t.settings.autoLintCounter.split(" ")[0]}
              </dt>
              <dd className="font-mono text-[11px]">
                {runtime
                  ? t.settings.autoLintCounterStatus(
                      runtime.counter.value,
                      runtime.counter.threshold,
                    )
                  : "—"}
                {runtime?.counter.suggested ? " ⚠️" : ""}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">{t.settings.autoLintLastRun}</dt>
              <dd className="font-mono text-[11px]">
                {runtime?.lastRunAt
                  ? `${formatDateTime(runtime.lastRunAt)} · ${runtime.lastResult?.halt ?? "?"}`
                  : t.settings.autoLintNoLastRun}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">{t.settings.autoLintNextRun}</dt>
              <dd className="font-mono text-[11px]">
                {runtime?.cronEnabled && runtime?.nextRunAt
                  ? formatDateTime(runtime.nextRunAt)
                  : t.settings.autoLintNoNextRun}
              </dd>
            </div>
            {runtime?.lastResult?.reportPath ? (
              <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
                {runtime.lastResult.reportPath}
              </div>
            ) : null}
            {runtime?.reason ? (
              <div className="mt-1 truncate text-[11px] text-ink-faint">
                {runtime.reason}
              </div>
            ) : null}
          </dl>
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={busy}
            className="mt-3 h-8 w-full rounded border border-line bg-bg text-xs font-medium text-ink hover:bg-bg-panel disabled:opacity-40"
          >
            {busy
              ? t.settings.autoLintRunningNow
              : t.settings.autoLintRunNow}
          </button>
        </div>
      </div>
    </section>
  );
}
