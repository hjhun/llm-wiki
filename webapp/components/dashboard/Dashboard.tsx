"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Cpu,
  Database,
  FileText,
  Inbox,
  Network,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useLanguage } from "../i18n";
import {
  Button,
  EmptyState,
  Panel,
  PageHeader,
  StatusBadge,
  cx,
  type StatusTone,
} from "../ui";

type LogEntry = { timestamp: string; op: string; title: string };

type DashboardData = {
  raw: { totalFiles: number; unprocessed: number };
  wiki: { sources: number; pages: number };
  graph: {
    status: "missing" | "partial-only" | "ready" | "invalid";
    nodes: number;
    edges: number;
    communities: number;
    updatedAt: string | null;
  };
  lint: {
    latest: string | null;
    locked: boolean;
    issues: { todo: number; done: number; warnings: number } | null;
  };
  autonomous: AutonomousStatus;
  recentLog: LogEntry[];
  generatedAt: string;
};

type JobRunStatus = "idle" | "running" | "skipped" | "disabled";

type AutonomousStatus = {
  autoIngest: {
    enabled: boolean;
    status: JobRunStatus;
    mode: "watch" | "schedule" | null;
    reason: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastHalt: string | null;
  };
  autoLint: {
    enabled: boolean;
    status: JobRunStatus;
    reason: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    suggested: boolean;
    counter: { value: number; threshold: number };
  };
};

const GRAPH_TONE: Record<DashboardData["graph"]["status"], StatusTone> = {
  ready: "ready",
  "partial-only": "warning",
  invalid: "error",
  missing: "disabled",
};

const OP_TONE: Record<string, StatusTone> = {
  ingest: "ready",
  query: "info",
  lint: "warning",
  graph: "info",
  init: "disabled",
};

const JOB_TONE: Record<JobRunStatus, StatusTone> = {
  running: "running",
  idle: "ready",
  skipped: "warning",
  disabled: "disabled",
};

export default function Dashboard() {
  const { t, formatDateTime } = useLanguage();
  const td = t.dashboard;
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      setData((await res.json()) as DashboardData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // C1: keep the dashboard live with a light auto-refresh.
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        eyebrow={td.eyebrow}
        title={td.title}
        meta={
          data
            ? `${td.updatedAt}: ${formatDateTime(data.generatedAt)}`
            : undefined
        }
        actions={
          <Button
            icon={RefreshCw}
            onClick={() => void load()}
            disabled={loading}
          >
            {td.refresh}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <EmptyState title={td.error} description={error} />
        ) : !data ? (
          <EmptyState title={t.common.loading} />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={Inbox}
                label={td.rawUnprocessed}
                value={data.raw.unprocessed}
                tone={data.raw.unprocessed > 0 ? "warning" : "ready"}
                hint={
                  data.raw.unprocessed > 0
                    ? td.rawUnprocessedHint
                    : td.rawAllProcessed
                }
                href="/explorer?ws=raw"
                cta={td.openExplorer}
              />
              <StatCard
                icon={FileText}
                label={td.rawTotal}
                value={data.raw.totalFiles}
              />
              <StatCard
                icon={Database}
                label={td.sources}
                value={data.wiki.sources}
              />
              <StatCard
                icon={FileText}
                label={td.pages}
                value={data.wiki.pages}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Panel
                eyebrow="graph"
                title={td.graph}
                actions={
                  <StatusBadge tone={GRAPH_TONE[data.graph.status]}>
                    {data.graph.status}
                  </StatusBadge>
                }
              >
                {data.graph.status === "missing" ? (
                  <EmptyState
                    title={td.graphMissing}
                    action={
                      <Link href="/graph">
                        <Button icon={Network}>{td.openGraph}</Button>
                      </Link>
                    }
                  />
                ) : (
                  <Link href="/graph" className="block no-underline">
                    <div className="grid grid-cols-3 gap-3">
                      <Metric label={td.graphNodes} value={data.graph.nodes} />
                      <Metric label={td.graphEdges} value={data.graph.edges} />
                      <Metric
                        label={td.graphCommunities}
                        value={data.graph.communities}
                      />
                    </div>
                    <span className="mt-3 inline-flex text-xs text-accent hover:underline">
                      {td.openGraph}
                    </span>
                  </Link>
                )}
              </Panel>

              <Panel
                eyebrow="lint"
                title={td.lint}
                actions={
                  data.lint.locked ? (
                    <StatusBadge tone="running">{td.lintRunning}</StatusBadge>
                  ) : null
                }
              >
                <div className="flex items-center gap-2 text-sm text-ink-dim">
                  <ShieldCheck aria-hidden className="h-4 w-4 text-accent" />
                  {data.lint.latest ? (
                    <span className="font-mono text-ink">
                      {data.lint.latest}
                    </span>
                  ) : (
                    <span className="text-ink-faint">{td.lintNone}</span>
                  )}
                </div>
                {data.lint.issues ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <StatusBadge
                      tone={data.lint.issues.todo > 0 ? "warning" : "ready"}
                    >
                      {td.lintTodo} {data.lint.issues.todo}
                    </StatusBadge>
                    <StatusBadge tone="ready">
                      {td.lintDone} {data.lint.issues.done}
                    </StatusBadge>
                    {data.lint.issues.warnings > 0 ? (
                      <StatusBadge tone="warning">
                        ⚠ {data.lint.issues.warnings}
                      </StatusBadge>
                    ) : null}
                  </div>
                ) : null}
              </Panel>

              <Panel eyebrow="raw" title={td.rawUnprocessed}>
                <div className="flex items-baseline gap-2">
                  <span
                    className={cx(
                      "text-3xl font-semibold tabular-nums",
                      data.raw.unprocessed > 0 ? "text-warning" : "text-success",
                    )}
                  >
                    {data.raw.unprocessed}
                  </span>
                  <span className="text-xs text-ink-faint">
                    / {data.raw.totalFiles}
                  </span>
                </div>
                <Link
                  href="/explorer?ws=raw"
                  className="mt-3 inline-flex text-xs text-accent hover:underline"
                >
                  {td.openExplorer}
                </Link>
              </Panel>
            </div>

            <Panel eyebrow="autonomous" title={td.autonomous}>
              <div className="flex flex-col gap-2">
                <JobRow
                  label={td.autoIngest}
                  enabled={data.autonomous.autoIngest.enabled}
                  status={data.autonomous.autoIngest.status}
                  detail={
                    data.autonomous.autoIngest.enabled
                      ? data.autonomous.autoIngest.mode
                        ? `${data.autonomous.autoIngest.mode}`
                        : null
                      : td.disabled
                  }
                  nextRunAt={data.autonomous.autoIngest.nextRunAt}
                  lastRunAt={data.autonomous.autoIngest.lastRunAt}
                  td={td}
                />
                <JobRow
                  label={td.autoLint}
                  enabled={data.autonomous.autoLint.enabled}
                  status={
                    data.autonomous.autoLint.suggested
                      ? "skipped"
                      : data.autonomous.autoLint.status
                  }
                  detail={
                    data.autonomous.autoLint.suggested
                      ? td.lintSuggested
                      : `${data.autonomous.autoLint.counter.value}/${data.autonomous.autoLint.counter.threshold}`
                  }
                  nextRunAt={data.autonomous.autoLint.nextRunAt}
                  lastRunAt={data.autonomous.autoLint.lastRunAt}
                  td={td}
                />
              </div>
            </Panel>

            <Panel eyebrow="log.md" title={td.recentActivity}>
              {data.recentLog.length === 0 ? (
                <div className="text-xs text-ink-faint">{td.noActivity}</div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.recentLog.map((entry, idx) => (
                    <li
                      key={`${entry.timestamp}-${idx}`}
                      className="flex items-center gap-3 rounded-md border border-line bg-bg/40 px-3 py-2"
                    >
                      <Activity
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 text-ink-faint"
                      />
                      <StatusBadge tone={OP_TONE[entry.op] ?? "info"}>
                        {entry.op || "—"}
                      </StatusBadge>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">
                        {entry.title || "—"}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                        {entry.timestamp}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  hint,
  href,
  cta,
}: {
  icon: typeof Inbox;
  label: string;
  value: number;
  tone?: StatusTone;
  hint?: string;
  href?: string;
  cta?: string;
}) {
  return (
    <div className="flex flex-col rounded-md border border-line bg-bg-panel/82 p-4 shadow-[0_18px_46px_rgb(0_0_0_/_0.16)] backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {label}
        </span>
        <Icon aria-hidden className="h-4 w-4 text-ink-faint" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-3xl font-semibold tabular-nums text-ink">
          {value}
        </span>
        {tone && hint ? <StatusBadge tone={tone}>{hint}</StatusBadge> : null}
      </div>
      {href && cta ? (
        <Link
          href={href}
          className="mt-3 inline-flex text-xs text-accent hover:underline"
        >
          {cta}
        </Link>
      ) : null}
    </div>
  );
}

function JobRow({
  label,
  enabled,
  status,
  detail,
  nextRunAt,
  lastRunAt,
  td,
}: {
  label: string;
  enabled: boolean;
  status: JobRunStatus;
  detail: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  td: Record<string, string>;
}) {
  const { formatDateTime } = useLanguage();

  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-bg/40 px-3 py-2">
      <Cpu aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
      {detail ? (
        <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint sm:inline">
          {detail}
        </span>
      ) : null}
      {nextRunAt && enabled ? (
        <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint md:inline">
          {td.nextRun}: {formatDateTime(nextRunAt)}
        </span>
      ) : lastRunAt ? (
        <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint md:inline">
          {td.lastRun}: {formatDateTime(lastRunAt)}
        </span>
      ) : null}
      <StatusBadge tone={JOB_TONE[status]}>{td[`status_${status}`] ?? status}</StatusBadge>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center rounded-md border border-line bg-bg/40 px-2 py-3">
      <span className="text-2xl font-semibold tabular-nums text-ink">
        {value}
      </span>
      <span className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {label}
      </span>
    </div>
  );
}
