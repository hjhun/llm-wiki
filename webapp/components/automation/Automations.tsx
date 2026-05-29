"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileText,
  FlaskConical,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
} from "lucide-react";
import { Button, EmptyState, PageHeader, StatusBadge } from "../ui";

type CliName = "codex" | "claude" | "agy" | "cline";
type Template = "youtube-summary" | "github-gerrit-review" | "email-sync" | "custom";

type AutomationJob = {
  id: string;
  name: string;
  enabled: boolean;
  template: Template;
  prompt: string;
  schedule: {
    mode: "preset" | "cron";
    preset: "hourly" | "daily" | "weekly" | "monthly";
    cron: string;
    time: { hour: number; minute: number };
    dayOfWeek: number;
    dayOfMonth: number;
    timezone: string;
  };
  selectedAgents: CliName[];
  workspaceBasePath: string;
  externalWritePolicy: "draft-only";
  autoIngestAfterRun: boolean;
};

type AutomationConfig = {
  enabled: boolean;
  maxConcurrentJobs: number;
  defaultWorkspaceBasePath: string;
  jobs: AutomationJob[];
};

type AutomationRuntime = {
  status: "idle" | "running" | "skipped" | "disabled";
  reason: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  jobs: Record<
    string,
    {
      status: "idle" | "running" | "skipped" | "disabled";
      reason: string | null;
      lastRunAt: string | null;
      nextRunAt: string | null;
      lastResult: {
        artifactRoot: string;
        mode: "plan" | "run";
        agents: Array<AutomationAgentResult>;
      } | null;
    }
  >;
};

type StatusResponse = {
  config: AutomationConfig;
  runtime: AutomationRuntime;
};

type ToolInventory = {
  tools: Array<{
    name: string;
    status: "ready" | "missing";
    path: string | null;
    version: string | null;
    installHint: string | null;
  }>;
  skills: Array<{
    name: string;
    status: "ready" | "missing";
    paths: string[];
    installHint: string | null;
  }>;
};

type BuilderProposal = {
  job: Omit<AutomationJob, "id">;
  requiredTools: string[];
  requiredSkills: string[];
  missingRequirements: string[];
  verificationSteps: string[];
  riskNotes: string[];
  analysisNotes: string[];
};

type AutomationAgentResult = {
  agent: CliName;
  status: "success" | "error";
  workspacePath?: string;
  artifactPath: string;
  exitCode?: number | null;
  durationMs: number;
  error?: string | null;
};

type AutomationResult = {
  artifactRoot: string;
  mode: "plan" | "run";
  agents: AutomationAgentResult[];
};

const CLI_NAMES: CliName[] = ["codex", "claude", "agy", "cline"];
const TEMPLATES: Array<{ value: Template; label: string }> = [
  { value: "youtube-summary", label: "YouTube summary" },
  { value: "github-gerrit-review", label: "GitHub/Gerrit review" },
  { value: "email-sync", label: "Email sync" },
  { value: "custom", label: "Custom" },
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function blankJob(): AutomationJob {
  return {
    id: "",
    name: "New automation",
    enabled: false,
    template: "custom",
    prompt: "",
    schedule: {
      mode: "preset",
      preset: "daily",
      cron: "0 9 * * *",
      time: { hour: 9, minute: 0 },
      dayOfWeek: 1,
      dayOfMonth: 1,
      timezone: "",
    },
    selectedAgents: ["codex"],
    workspaceBasePath: "",
    externalWritePolicy: "draft-only",
    autoIngestAfterRun: false,
  };
}

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function statusTone(status: AutomationRuntime["status"]) {
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

function statusBadgeTone(status: AutomationRuntime["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "skipped":
      return "skipped";
    case "disabled":
      return "disabled";
    case "idle":
    default:
      return "ready";
  }
}

export default function Automations() {
  const [config, setConfig] = useState<AutomationConfig | null>(null);
  const [runtime, setRuntime] = useState<AutomationRuntime | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationJob>(blankJob);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolInventory | null>(null);
  const [builderGoal, setBuilderGoal] = useState("");
  const [builderSchedule, setBuilderSchedule] = useState("daily at 09:00");
  const [builderAgents, setBuilderAgents] = useState<CliName[]>(["codex"]);
  const [analyzerAgent, setAnalyzerAgent] = useState<CliName | "none">("none");
  const [proposal, setProposal] = useState<BuilderProposal | null>(null);
  const [verifyResult, setVerifyResult] = useState<AutomationResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/automation/status", { cache: "no-store" });
    if (!res.ok) throw await asError(res);
    const json = (await res.json()) as StatusResponse;
    setConfig(json.config);
    setRuntime(json.runtime);
    setSelectedId((current) => current ?? json.config.jobs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void load().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [load]);

  const loadTools = useCallback(async () => {
    const res = await fetch("/api/automation/tools", { cache: "no-store" });
    if (!res.ok) return;
    setTools((await res.json()) as ToolInventory);
  }, []);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  useEffect(() => {
    const events = new EventSource("/api/automation/events");
    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type: string; state?: AutomationRuntime };
        if (payload.type === "state" && payload.state) setRuntime(payload.state);
        if (payload.type === "done") void load().catch(() => undefined);
      } catch {
        // best effort
      }
    };
    return () => events.close();
  }, [load]);

  useEffect(() => {
    const selected = config?.jobs.find((job) => job.id === selectedId);
    setDraft(selected ? cloneJob(selected) : blankJob());
  }, [config?.jobs, selectedId]);

  const selectedRuntime = selectedId && runtime ? runtime.jobs[selectedId] : null;
  const jobs = config?.jobs ?? [];

  const globalNextRun = useMemo(() => {
    if (!runtime?.nextRunAt) return "—";
    return formatTime(runtime.nextRunAt);
  }, [runtime?.nextRunAt]);

  async function saveGlobal(next: Partial<AutomationConfig>) {
    if (!config) return;
    setBusy("global");
    setError(null);
    setNotice(null);
    try {
      const body = {
        enabled: next.enabled ?? config.enabled,
        maxConcurrentJobs: next.maxConcurrentJobs ?? config.maxConcurrentJobs,
        defaultWorkspaceBasePath:
          next.defaultWorkspaceBasePath ?? config.defaultWorkspaceBasePath,
      };
      const res = await fetch("/api/automation/jobs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await asError(res);
      await load();
      setNotice("Automation settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveJob() {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const isNew = !draft.id;
      const res = await fetch(
        isNew ? "/api/automation/jobs" : `/api/automation/jobs/${draft.id}`,
        {
          method: isNew ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(withoutId(draft)),
        },
      );
      if (!res.ok) throw await asError(res);
      const json = (await res.json()) as { job: AutomationJob };
      await load();
      setSelectedId(json.job.id);
      setNotice("Automation job saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteJob() {
    if (!draft.id) return;
    setBusy("delete");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automation/jobs/${draft.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await asError(res);
      setSelectedId(null);
      await load();
      setNotice("Automation job deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function trigger(kind: "plan" | "run-now") {
    if (!draft.id) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automation/jobs/${draft.id}/${kind}`, {
        method: "POST",
      });
      if (!res.ok) throw await asError(res);
      await load();
      setNotice(kind === "plan" ? "Plan generation started." : "Run started.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeBuilder() {
    if (!builderGoal.trim()) return;
    setBusy("builder-analyze");
    setError(null);
    setNotice(null);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/automation/builder/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: builderGoal,
          schedulePreference: builderSchedule,
          selectedAgents: builderAgents,
          analyzerAgent: analyzerAgent === "none" ? null : analyzerAgent,
        }),
      });
      if (!res.ok) throw await asError(res);
      const json = (await res.json()) as { proposal: BuilderProposal };
      setProposal(json.proposal);
      setNotice("Builder proposal generated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function verifyProposal() {
    if (!proposal) return;
    setBusy("builder-verify");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/automation/builder/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal.job),
      });
      if (!res.ok) throw await asError(res);
      const json = (await res.json()) as { result: AutomationResult };
      setVerifyResult(json.result);
      setNotice("Dry-run verification completed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function installTool(tool: string) {
    if (tool !== "agent-browser") return;
    const ok = window.confirm(
      "Install agent-browser now?\n\nThis will run: npm install -g agent-browser && agent-browser install",
    );
    if (!ok) return;
    setBusy("install-agent-browser");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/automation/tools/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, confirmed: true }),
      });
      if (!res.ok) throw await asError(res);
      await loadTools();
      setNotice("agent-browser install command completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function applyProposal() {
    if (!proposal) return;
    setSelectedId(null);
    setDraft({ id: "", ...cloneJobLike(proposal.job) });
    setNotice("Builder draft applied. Review it, then save the job.");
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PageHeader
        eyebrow="scheduled agents"
        title="Automations"
        meta="cron jobs · multi-CLI isolated workspaces · draft-only external writes"
        actions={
          <>
            <StatusBadge tone={statusBadgeTone(runtime?.status ?? "disabled")}>
              {runtime?.status ?? "disabled"}
            </StatusBadge>
            <Button
              onClick={() => void load()}
              disabled={busy != null}
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <div className="border-b border-danger/50 bg-danger/10 px-4 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="border-b border-emerald-900/60 bg-emerald-950/30 px-4 py-1 text-[11px] text-emerald-300">
          {notice}
        </div>
      ) : null}

      {!config ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
          Loading automations.
        </div>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden">
          <aside className="flex min-h-0 flex-col border-r border-line bg-bg-subtle">
            <div className="border-b border-line p-3">
              <label className="flex items-center justify-between gap-3 rounded border border-line bg-bg px-3 py-2">
                <span>
                  <span className="block text-sm font-medium text-ink">Scheduler</span>
                  <span className="block text-[11px] text-ink-faint">
                    next {globalNextRun}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => void saveGlobal({ enabled: e.target.checked })}
                  className="h-4 w-4 accent-accent"
                />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="rounded border border-line bg-bg px-2 py-1.5">
                  <span className="text-[11px] text-ink-faint">Max jobs</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={config.maxConcurrentJobs}
                    onChange={(e) =>
                      void saveGlobal({
                        maxConcurrentJobs: Math.min(
                          8,
                          Math.max(1, Number(e.target.value) || 1),
                        ),
                      })
                    }
                    className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
                  />
                </label>
                <Button
                  onClick={() => {
                    setSelectedId(null);
                    setDraft(blankJob());
                  }}
                  icon={Plus}
                  className="h-full"
                >
                  New job
                </Button>
              </div>
              <label className="mt-2 block rounded border border-line bg-bg px-2 py-1.5">
                <span className="text-[11px] text-ink-faint">
                  Default workspace base
                </span>
                <input
                  value={config.defaultWorkspaceBasePath}
                  onChange={(e) =>
                    setConfig((current) =>
                      current
                        ? { ...current, defaultWorkspaceBasePath: e.target.value }
                        : current,
                    )
                  }
                  onBlur={(e) =>
                    void saveGlobal({ defaultWorkspaceBasePath: e.target.value })
                  }
                  placeholder="system temp directory"
                  className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {jobs.length === 0 ? (
                <EmptyState
                  title="No automation jobs yet."
                  description="Create a job from the prompt builder or start from a blank automation."
                  className="min-h-40"
                />
              ) : (
                <div className="space-y-2">
                  {jobs.map((job) => {
                    const rt = runtime?.jobs[job.id];
                    const active = draft.id === job.id;
                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => setSelectedId(job.id)}
                        className={[
                          "block w-full rounded-md border bg-bg p-3 text-left transition-colors",
                          active
                            ? "border-accent"
                            : "border-line hover:bg-bg-panel",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-ink">
                              {job.name}
                            </div>
                            <div className="mt-1 text-[11px] text-ink-faint">
                              {TEMPLATES.find((tpl) => tpl.value === job.template)?.label}
                            </div>
                          </div>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(
                              rt?.status ?? (job.enabled ? "idle" : "disabled"),
                            )}`}
                          >
                            {rt?.status ?? (job.enabled ? "idle" : "off")}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {job.selectedAgents.map((agent) => (
                            <span
                              key={agent}
                              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                            >
                              {agent}
                            </span>
                          ))}
                        </div>
                        <div className="mt-2 truncate font-mono text-[10px] text-ink-faint">
                          next {formatTime(rt?.nextRunAt ?? null)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-auto p-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-4">
                <Panel title="Build from prompt" eyebrow="job builder">
                  <label className="block rounded border border-line bg-bg px-3 py-2">
                    <span className="text-xs text-ink-faint">What should run on a schedule?</span>
                    <textarea
                      value={builderGoal}
                      onChange={(e) => setBuilderGoal(e.target.value)}
                      rows={4}
                      placeholder="Example: Every morning, check a YouTube channel for new videos, summarize transcripts, and record findings."
                      className="mt-1 block w-full resize-y rounded border border-line bg-bg px-2 py-1.5 text-sm leading-relaxed text-ink outline-none focus:border-accent"
                    />
                  </label>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <TextField
                      label="Schedule preference"
                      value={builderSchedule}
                      onChange={setBuilderSchedule}
                    />
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Analyzer CLI</span>
                      <select
                        value={analyzerAgent}
                        onChange={(e) =>
                          setAnalyzerAgent(e.target.value as CliName | "none")
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        <option value="none">Local heuristic</option>
                        {CLI_NAMES.map((agent) => (
                          <option key={agent} value={agent}>
                            {agent}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 rounded border border-line bg-bg px-3 py-2">
                    <div className="text-xs text-ink-faint">Preferred execution CLIs</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {CLI_NAMES.map((agent) => (
                        <label
                          key={agent}
                          className="flex cursor-pointer items-center gap-2 rounded border border-line px-2 py-1.5 font-mono text-xs text-ink-dim hover:bg-bg-panel"
                        >
                          <input
                            type="checkbox"
                            checked={builderAgents.includes(agent)}
                            onChange={() => toggleBuilderAgent(agent)}
                            className="accent-accent"
                          />
                          {agent}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      onClick={() => void analyzeBuilder()}
                      disabled={busy != null || !builderGoal.trim()}
                      variant="primary"
                      icon={Wand2}
                    >
                      {busy === "builder-analyze" ? "Analyzing..." : "Analyze prompt"}
                    </Button>
                    <Button
                      onClick={() => void loadTools()}
                      disabled={busy != null}
                      icon={RefreshCw}
                    >
                      Refresh tools
                    </Button>
                  </div>

                  {proposal ? (
                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="rounded border border-line bg-bg px-3 py-2">
                        <div className="text-xs uppercase tracking-widest text-ink-faint">
                          proposal
                        </div>
                        <div className="mt-2 text-sm font-medium text-ink">
                          {proposal.job.name}
                        </div>
                        <div className="mt-1 text-xs text-ink-faint">
                          {proposal.job.template} · {proposal.job.schedule.preset}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            onClick={applyProposal}
                            icon={Save}
                          >
                            Apply to editor
                          </Button>
                          <Button
                            onClick={() => void verifyProposal()}
                            disabled={busy != null}
                            icon={FlaskConical}
                          >
                            {busy === "builder-verify" ? "Verifying..." : "Dry-run verify"}
                          </Button>
                        </div>
                        {verifyResult ? (
                          <ArtifactLinks result={verifyResult} />
                        ) : null}
                      </div>
                      <div className="rounded border border-line bg-bg px-3 py-2">
                        <div className="text-xs uppercase tracking-widest text-ink-faint">
                          requirements
                        </div>
                        <RequirementList
                          label="Tools"
                          items={proposal.requiredTools}
                          missing={proposal.missingRequirements}
                          onInstall={installTool}
                        />
                        <RequirementList
                          label="Skills"
                          items={proposal.requiredSkills}
                          missing={proposal.missingRequirements}
                          onInstall={installTool}
                        />
                      </div>
                      <Bullets title="Verification" items={proposal.verificationSteps} />
                      <Bullets title="Risks" items={proposal.riskNotes} />
                    </div>
                  ) : null}

                  {tools ? (
                    <div className="mt-4 flex flex-wrap gap-1">
                      {tools.tools.map((tool) => (
                        <span
                          key={tool.name}
                          className={[
                            "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                            tool.status === "ready"
                              ? "border-emerald-900/60 text-emerald-300"
                              : "border-line text-ink-faint",
                          ].join(" ")}
                          title={tool.path ?? tool.installHint ?? undefined}
                        >
                          {tool.name}:{tool.status}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </Panel>

                <Panel title="Job" eyebrow={draft.id ? draft.id : "new"}>
                  <div className="grid gap-3 md:grid-cols-2">
                    <TextField
                      label="Name"
                      value={draft.name}
                      onChange={(value) => setDraft((next) => ({ ...next, name: value }))}
                    />
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Template</span>
                      <select
                        value={draft.template}
                        onChange={(e) =>
                          setDraft((next) => ({
                            ...next,
                            template: e.target.value as Template,
                          }))
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        {TEMPLATES.map((tpl) => (
                          <option key={tpl.value} value={tpl.value}>
                            {tpl.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="mt-3 block rounded border border-line bg-bg px-3 py-2">
                    <span className="text-xs text-ink-faint">Prompt</span>
                    <textarea
                      value={draft.prompt}
                      onChange={(e) =>
                        setDraft((next) => ({ ...next, prompt: e.target.value }))
                      }
                      rows={10}
                      className="mt-1 block w-full resize-y rounded border border-line bg-bg px-2 py-1.5 text-sm leading-relaxed text-ink outline-none focus:border-accent"
                    />
                  </label>
                </Panel>

                <Panel title="Schedule" eyebrow="cron">
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Mode</span>
                      <select
                        value={draft.schedule.mode}
                        onChange={(e) =>
                          updateSchedule((schedule) => {
                            schedule.mode = e.target.value as "preset" | "cron";
                          })
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        <option value="preset">Preset</option>
                        <option value="cron">5-field cron</option>
                      </select>
                    </label>
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Preset</span>
                      <select
                        value={draft.schedule.preset}
                        disabled={draft.schedule.mode !== "preset"}
                        onChange={(e) =>
                          updateSchedule((schedule) => {
                            schedule.preset = e.target.value as AutomationJob["schedule"]["preset"];
                          })
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                      >
                        <option value="hourly">Hourly</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </label>
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Time</span>
                      <input
                        type="time"
                        value={`${pad2(draft.schedule.time.hour)}:${pad2(
                          draft.schedule.time.minute,
                        )}`}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(":").map(Number);
                          updateSchedule((schedule) => {
                            schedule.time = {
                              hour: Math.min(23, Math.max(0, h || 0)),
                              minute: Math.min(59, Math.max(0, m || 0)),
                            };
                          });
                        }}
                        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
                      />
                    </label>
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Cron</span>
                      <input
                        value={draft.schedule.cron}
                        disabled={draft.schedule.mode !== "cron"}
                        onChange={(e) =>
                          updateSchedule((schedule) => {
                            schedule.cron = e.target.value;
                          })
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
                      />
                    </label>
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">Weekday</span>
                      <select
                        value={draft.schedule.dayOfWeek}
                        onChange={(e) =>
                          updateSchedule((schedule) => {
                            schedule.dayOfWeek = Number(e.target.value) || 0;
                          })
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        {WEEKDAYS.map((day, idx) => (
                          <option key={day} value={idx}>
                            {day}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumberField
                      label="Day of month"
                      value={draft.schedule.dayOfMonth}
                      min={1}
                      max={28}
                      onChange={(value) =>
                        updateSchedule((schedule) => {
                          schedule.dayOfMonth = value;
                        })
                      }
                    />
                  </div>
                </Panel>
              </div>

              <aside className="space-y-4">
                <Panel title="Execution" eyebrow="multi-cli">
                  <label className="flex items-center justify-between gap-3 rounded border border-line bg-bg px-3 py-2">
                    <span className="text-sm font-medium text-ink">Enabled</span>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) =>
                        setDraft((next) => ({ ...next, enabled: e.target.checked }))
                      }
                      className="h-4 w-4 accent-accent"
                    />
                  </label>
                  <div className="mt-3 rounded border border-line bg-bg px-3 py-2">
                    <div className="text-xs text-ink-faint">Agents</div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {CLI_NAMES.map((agent) => (
                        <label
                          key={agent}
                          className="flex cursor-pointer items-center gap-2 rounded border border-line px-2 py-1.5 font-mono text-xs text-ink-dim hover:bg-bg-panel"
                        >
                          <input
                            type="checkbox"
                            checked={draft.selectedAgents.includes(agent)}
                            onChange={() => toggleAgent(agent)}
                            className="accent-accent"
                          />
                          {agent}
                        </label>
                      ))}
                    </div>
                  </div>
                  <TextField
                    label="Workspace base override"
                    value={draft.workspaceBasePath}
                    onChange={(value) =>
                      setDraft((next) => ({ ...next, workspaceBasePath: value }))
                    }
                    placeholder="default workspace base"
                  />
                  <label className="mt-3 flex items-center justify-between gap-3 rounded border border-line bg-bg px-3 py-2">
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        Auto-ingest after run
                      </span>
                      <span className="block text-xs text-ink-faint">
                        record under raw/automation
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.autoIngestAfterRun}
                      onChange={(e) =>
                        setDraft((next) => ({
                          ...next,
                          autoIngestAfterRun: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-accent"
                    />
                  </label>
                  <div className="mt-3 rounded border border-line bg-bg px-3 py-2">
                    <div className="text-xs text-ink-faint">External writes</div>
                    <div className="mt-1 text-sm font-medium text-ink">Draft-only</div>
                  </div>
                </Panel>

                <Panel title="Actions" eyebrow="job">
                  <div className="grid gap-2">
                    <Button
                      onClick={() => void saveJob()}
                      disabled={busy != null || draft.selectedAgents.length === 0}
                      variant="primary"
                      icon={Save}
                    >
                      {busy === "save" ? "Saving..." : "Save job"}
                    </Button>
                    <Button
                      onClick={() => void trigger("plan")}
                      disabled={busy != null || !draft.id}
                      icon={FileText}
                    >
                      {busy === "plan" ? "Starting..." : "Generate plan"}
                    </Button>
                    <Button
                      onClick={() => void trigger("run-now")}
                      disabled={busy != null || !draft.id}
                      icon={Play}
                    >
                      {busy === "run-now" ? "Starting..." : "Run now"}
                    </Button>
                    <Button
                      onClick={() => void deleteJob()}
                      disabled={busy != null || !draft.id}
                      variant="danger"
                      icon={Trash2}
                    >
                      Delete
                    </Button>
                  </div>
                </Panel>

                <Panel title="Runtime" eyebrow={selectedRuntime?.status ?? "idle"}>
                  <dl className="grid gap-2 text-xs text-ink-dim">
                    <InfoRow label="Last run" value={formatTime(selectedRuntime?.lastRunAt ?? null)} />
                    <InfoRow label="Next run" value={formatTime(selectedRuntime?.nextRunAt ?? null)} />
                    <InfoRow label="Reason" value={selectedRuntime?.reason ?? "—"} />
                    <InfoRow
                      label="Artifact"
                      value={selectedRuntime?.lastResult?.artifactRoot ?? "—"}
                    />
                  </dl>
                  {selectedRuntime?.lastResult ? (
                    <ArtifactLinks result={selectedRuntime.lastResult} />
                  ) : null}
                </Panel>
              </aside>
            </div>
          </section>
        </main>
      )}
    </div>
  );

  function updateSchedule(mutator: (schedule: AutomationJob["schedule"]) => void) {
    setDraft((current) => {
      const schedule = {
        ...current.schedule,
        time: { ...current.schedule.time },
      };
      mutator(schedule);
      return { ...current, schedule };
    });
  }

  function toggleAgent(agent: CliName) {
    setDraft((current) => {
      const exists = current.selectedAgents.includes(agent);
      const selectedAgents = exists
        ? current.selectedAgents.filter((item) => item !== agent)
        : [...current.selectedAgents, agent];
      return {
        ...current,
        selectedAgents: selectedAgents.length > 0 ? selectedAgents : current.selectedAgents,
      };
    });
  }

  function toggleBuilderAgent(agent: CliName) {
    setBuilderAgents((current) => {
      const exists = current.includes(agent);
      const next = exists
        ? current.filter((item) => item !== agent)
        : [...current, agent];
      return next.length > 0 ? next : current;
    });
  }
}

function Panel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-bg-subtle">
      <header className="border-b border-line px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {eyebrow}
        </div>
        <h2 className="mt-1 text-sm font-semibold text-ink">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="mt-3 block rounded border border-line bg-bg px-3 py-2 first:mt-0">
      <span className="text-xs text-ink-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="rounded border border-line bg-bg px-3 py-2">
      <span className="text-xs text-ink-faint">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))
        }
        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="truncate font-mono text-[11px]">{value}</dd>
    </div>
  );
}

function ArtifactLinks({ result }: { result: AutomationResult }) {
  const resultFile = result.mode === "run" ? "result.md" : "plan.md";
  return (
    <div className="mt-3 rounded border border-line bg-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-widest text-ink-faint">
          artifacts
        </span>
        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
          {result.mode}
        </span>
      </div>
      <div className="mt-2 truncate font-mono text-[11px] text-emerald-300">
        {result.artifactRoot}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <ArtifactLink label="Folder" rawPath={result.artifactRoot} />
        <ArtifactLink
          label="Summary"
          rawPath={joinRawPath(result.artifactRoot, "summary.md")}
        />
        <ArtifactLink
          label="Job"
          rawPath={joinRawPath(result.artifactRoot, "job.md")}
        />
        <ArtifactLink
          label="Schedule"
          rawPath={joinRawPath(result.artifactRoot, "schedule.md")}
        />
      </div>
      <div className="mt-3 space-y-1">
        {result.agents.map((agent) => (
          <div
            key={agent.agent}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded border border-line bg-bg-subtle px-2 py-1 text-[11px]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-ink-dim">{agent.agent}</span>
                <span
                  className={
                    agent.status === "success"
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  {agent.status} · {agent.durationMs}ms
                </span>
              </div>
              {agent.error ? (
                <div className="truncate text-[10px] text-red-300">
                  {agent.error}
                </div>
              ) : null}
            </div>
            <ArtifactLink
              label={resultFile}
              rawPath={joinRawPath(agent.artifactPath, resultFile)}
              compact
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactLink({
  label,
  rawPath,
  compact = false,
}: {
  label: string;
  rawPath: string;
  compact?: boolean;
}) {
  return (
    <a
      href={explorerHref(rawPath)}
      className={[
        "rounded border border-line text-center text-xs font-medium text-ink-dim hover:bg-bg-panel hover:text-ink",
        compact ? "px-2 py-1 text-[11px]" : "px-2 py-1.5",
      ].join(" ")}
    >
      {label}
    </a>
  );
}

function joinRawPath(root: string, child: string): string {
  return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function explorerHref(rawPath: string): string {
  const pathInRaw = rawPath.replace(/^raw\/?/, "");
  const params = new URLSearchParams({ ws: "raw", path: pathInRaw });
  return `/explorer?${params.toString()}`;
}

function RequirementList({
  label,
  items,
  missing,
  onInstall,
}: {
  label: string;
  items: string[];
  missing: string[];
  onInstall: (tool: string) => Promise<void>;
}) {
  if (items.length === 0) {
    return (
      <div className="mt-2 text-[11px] text-ink-faint">
        {label}: none
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => {
          const missingTool = missing.includes(`tool:${item}`);
          const missingSkill = missing.includes(`skill:${item}`);
          const isMissing = missingTool || missingSkill;
          return (
            <span
              key={item}
              className={[
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                isMissing
                  ? "border-red-900/60 text-red-300"
                  : "border-emerald-900/60 text-emerald-300",
              ].join(" ")}
            >
              {item}:{isMissing ? "missing" : "ready"}
              {missingTool && item === "agent-browser" ? (
                <button
                  type="button"
                  onClick={() => void onInstall(item)}
                  className="ml-1 rounded border border-line px-1 text-[10px] text-ink-dim hover:bg-bg-panel"
                >
                  install
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded border border-line bg-bg px-3 py-2">
      <div className="text-xs uppercase tracking-widest text-ink-faint">
        {title}
      </div>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-dim">
        {items.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function cloneJob(job: AutomationJob): AutomationJob {
  return {
    ...job,
    schedule: { ...job.schedule, time: { ...job.schedule.time } },
    selectedAgents: [...job.selectedAgents],
  };
}

function cloneJobLike(job: Omit<AutomationJob, "id">): Omit<AutomationJob, "id"> {
  return {
    ...job,
    schedule: { ...job.schedule, time: { ...job.schedule.time } },
    selectedAgents: [...job.selectedAgents],
  };
}

function withoutId(job: AutomationJob): Omit<AutomationJob, "id"> {
  const { id: _id, ...rest } = job;
  return rest;
}
