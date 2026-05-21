"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../i18n";
import type { SettingsConfig } from "./types";

type AutoIngestRuntime = {
  status: "idle" | "running" | "skipped" | "disabled";
  reason: string | null;
  startedAt: string | null;
  lastRunAt: string | null;
  lastResult: {
    halt:
      | "normal"
      | "error"
      | "stopped"
      | "capped"
      | "stalled"
      | "skipped"
      | "noop";
    reason: string;
    iterations: number;
    durationMs: number;
    anyProgress: boolean;
    source: "watch" | "schedule" | "manual";
    sessionPath: string | null;
  } | null;
  nextRunAt: string | null;
  mode: "watch" | "schedule" | null;
};

type StatusResponse = {
  config: SettingsConfig["autoIngest"];
  runtime: AutoIngestRuntime;
};

function statusTone(status: AutoIngestRuntime["status"]) {
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

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function AutoIngestPanel({
  draft,
  onChange,
}: {
  draft: SettingsConfig["autoIngest"];
  onChange: (next: SettingsConfig["autoIngest"]) => void;
}) {
  const { t } = useLanguage();
  const [runtime, setRuntime] = useState<AutoIngestRuntime | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-ingest/status", { cache: "no-store" });
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
      await fetch("/api/auto-ingest/run-now", { method: "POST" });
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

  const watchActive = draft.mode === "watch";
  const scheduleActive = draft.mode === "schedule";

  return (
    <section className="rounded-md border border-line bg-bg-subtle">
      <header className="border-b border-line px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          auto trigger
        </div>
        <h2 className="mt-1 text-sm font-semibold text-ink">
          {t.settings.autoIngest}
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          {t.settings.autoIngestDesc}
        </p>
      </header>
      <div className="space-y-4 p-4">
        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span className="text-sm font-medium text-ink">
            {t.settings.autoIngestEnabled}
          </span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <div className="rounded border border-line bg-bg px-3 py-2">
          <div className="text-xs text-ink-faint">
            {t.settings.autoIngestMode}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label
              className={[
                "flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-sm",
                watchActive
                  ? "border-accent bg-accent/10 text-ink"
                  : "border-line text-ink-dim hover:bg-bg-panel",
              ].join(" ")}
            >
              <input
                type="radio"
                name="auto-ingest-mode"
                value="watch"
                checked={watchActive}
                onChange={() => onChange({ ...draft, mode: "watch" })}
                className="accent-accent"
              />
              {t.settings.autoIngestModeWatch}
            </label>
            <label
              className={[
                "flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-sm",
                scheduleActive
                  ? "border-accent bg-accent/10 text-ink"
                  : "border-line text-ink-dim hover:bg-bg-panel",
              ].join(" ")}
            >
              <input
                type="radio"
                name="auto-ingest-mode"
                value="schedule"
                checked={scheduleActive}
                onChange={() => onChange({ ...draft, mode: "schedule" })}
                className="accent-accent"
              />
              {t.settings.autoIngestModeSchedule}
            </label>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label
            className={[
              "block rounded border bg-bg px-3 py-2",
              watchActive ? "border-line" : "border-line opacity-50",
            ].join(" ")}
          >
            <span className="text-xs text-ink-faint">
              {t.settings.autoIngestDebounce}
            </span>
            <input
              type="number"
              min={1000}
              max={60000}
              step={500}
              value={draft.watch.debounceMs}
              disabled={!watchActive}
              onChange={(e) =>
                onChange({
                  ...draft,
                  watch: {
                    ...draft.watch,
                    debounceMs: Math.max(1000, Number(e.target.value) || 1000),
                  },
                })
              }
              className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed"
            />
          </label>
          <label
            className={[
              "block rounded border bg-bg px-3 py-2",
              scheduleActive ? "border-line" : "border-line opacity-50",
            ].join(" ")}
          >
            <span className="text-xs text-ink-faint">
              {t.settings.autoIngestInterval}
            </span>
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={draft.schedule.intervalMinutes}
              disabled={!scheduleActive}
              onChange={(e) =>
                onChange({
                  ...draft,
                  schedule: {
                    ...draft.schedule,
                    intervalMinutes: Math.max(
                      1,
                      Number(e.target.value) || 1,
                    ),
                  },
                })
              }
              className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed"
            />
          </label>
        </div>

        <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
          <span>
            <span className="block text-sm font-medium text-ink">
              {t.settings.autoIngestSkipIfBusy}
            </span>
            <span className="block text-xs text-ink-faint">
              {t.settings.autoIngestSkipIfBusyDesc}
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
              {t.settings.autoIngestStatus}
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
              <dt className="text-ink-faint">{t.settings.autoIngestLastRun}</dt>
              <dd className="font-mono text-[11px]">
                {runtime?.lastRunAt
                  ? `${formatTime(runtime.lastRunAt)} · ${runtime.lastResult?.halt ?? "?"} (iter=${runtime.lastResult?.iterations ?? 0})`
                  : t.settings.autoIngestNoLastRun}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">{t.settings.autoIngestNextRun}</dt>
              <dd className="font-mono text-[11px]">
                {runtime?.nextRunAt
                  ? formatTime(runtime.nextRunAt)
                  : t.settings.autoIngestNoNextRun}
              </dd>
            </div>
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
              ? t.settings.autoIngestRunningNow
              : t.settings.autoIngestRunNow}
          </button>
        </div>
      </div>
    </section>
  );
}
