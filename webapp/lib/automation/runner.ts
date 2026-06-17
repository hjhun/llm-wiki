import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config";
import { runCli, type CliName } from "../cli";
import { PROJECT_ROOT } from "../paths";
import { slugify } from "../sessions";
import {
  AUTOMATION_ARTIFACTS_ROOT,
  automationArtifactRel,
  ensureAutomationArtifactsMigrated,
} from "./artifacts";
import { automationPlanPrompt, automationRunPrompt } from "./templates";
import { getAutomationEvents } from "./events";
import type {
  AutomationAgentResult,
  AutomationJob,
  AutomationRunResult,
  AutomationSource,
} from "./types";

export async function runAutomationJob(input: {
  job: AutomationJob;
  mode: "plan" | "run";
  source: AutomationSource;
}): Promise<AutomationRunResult> {
  const cfg = await loadConfig();
  const started = new Date();
  const runId = `${formatRunStamp(started)}-${randomUUID().slice(0, 8)}`;
  const jobSlug = slugify(input.job.name) || input.job.id;
  await ensureAutomationArtifactsMigrated();
  const artifactAbs = path.join(AUTOMATION_ARTIFACTS_ROOT, jobSlug, runId);
  const artifactRel = automationArtifactRel(jobSlug, runId);
  await fs.mkdir(artifactAbs, { recursive: true });
  await writeJobArtifacts(input.job, input.mode, input.source, artifactAbs);

  const agents = input.job.selectedAgents as CliName[];
  const settled = await Promise.allSettled(
    agents.map((agent) =>
      runAgent({
        job: input.job,
        agent,
        runId,
        mode: input.mode,
        artifactAbs,
        artifactRel,
        defaultWorkspaceBasePath: cfg.automation.defaultWorkspaceBasePath,
      }),
    ),
  );

  const results: AutomationAgentResult[] = settled.map((item, idx) => {
    if (item.status === "fulfilled") return item.value;
    return {
      agent: agents[idx],
      status: "error",
      workspacePath: "",
      artifactPath: path.posix.join(artifactRel, "cli", agents[idx]),
      exitCode: null,
      durationMs: 0,
      error: item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });

  const ended = new Date();
  const result: AutomationRunResult = {
    jobId: input.job.id,
    jobName: input.job.name,
    runId,
    mode: input.mode,
    source: input.source,
    artifactRoot: artifactRel,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: ended.getTime() - started.getTime(),
    agents: results,
  };
  await fs.writeFile(
    path.join(artifactAbs, "summary.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(artifactAbs, "summary.md"),
    renderSummary(result),
    "utf8",
  );
  return result;
}

async function runAgent(input: {
  job: AutomationJob;
  agent: CliName;
  runId: string;
  mode: "plan" | "run";
  artifactAbs: string;
  artifactRel: string;
  defaultWorkspaceBasePath: string;
}): Promise<AutomationAgentResult> {
  const workspacePath = await prepareWorkspace(input);
  const cliArtifactAbs = path.join(input.artifactAbs, "cli", input.agent);
  const cliArtifactRel = path.posix.join(input.artifactRel, "cli", input.agent);
  await fs.mkdir(cliArtifactAbs, { recursive: true });
  const prompt =
    input.mode === "plan"
      ? automationPlanPrompt(input.job)
      : automationRunPrompt(input.job);
  const started = Date.now();
  try {
    const cfg = await loadConfig();
    const automationTimeout = cfg.cli.timeouts.automation;
    const result = await runCli(input.agent, prompt, {
      cwd: workspacePath,
      projectRoot: workspacePath,
      safeMode: cfg.agent.safeMode,
      timeoutMs: automationTimeout ?? undefined,
      killOnAbort: true,
      onStdout: (chunk) => {
        getAutomationEvents().emitEvent({
          type: "output",
          jobId: input.job.id,
          runId: input.runId,
          agent: input.agent,
          text: chunk,
        });
      },
    });
    const durationMs = result.durationMs || Date.now() - started;
    const body = result.stdout.trim() || result.stderr.trim() || "(empty result)";
    const fileName = input.mode === "plan" ? "plan.md" : "result.md";
    await fs.writeFile(path.join(cliArtifactAbs, fileName), body + "\n", "utf8");
    await fs.writeFile(path.join(cliArtifactAbs, "stdout.log"), result.stdout, "utf8");
    await fs.writeFile(path.join(cliArtifactAbs, "stderr.log"), result.stderr, "utf8");
    const errorMessage = result.timedOut
      ? `automation 실행이 타임아웃(${Math.round((automationTimeout ?? 0) / 1000)}s)으로 중단되었습니다`
      : result.exitCode === 0
        ? null
        : `CLI exitCode=${result.exitCode}`;
    return {
      agent: input.agent,
      status: result.exitCode === 0 ? "success" : "error",
      workspacePath,
      artifactPath: cliArtifactRel,
      exitCode: result.exitCode,
      durationMs,
      error: errorMessage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fs.writeFile(path.join(cliArtifactAbs, "error.log"), message + "\n", "utf8");
    return {
      agent: input.agent,
      status: "error",
      workspacePath,
      artifactPath: cliArtifactRel,
      exitCode: null,
      durationMs: Date.now() - started,
      error: message,
    };
  }
}

async function prepareWorkspace(input: {
  job: AutomationJob;
  agent: CliName;
  runId: string;
  defaultWorkspaceBasePath: string;
}): Promise<string> {
  const base = resolveWorkspaceBase(
    input.job.workspaceBasePath || input.defaultWorkspaceBasePath,
  );
  const workspace = path.join(base, input.job.id, input.runId, input.agent);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AUTOMATION.md"),
    [
      `# ${input.job.name}`,
      "",
      `- job: ${input.job.id}`,
      `- agent: ${input.agent}`,
      `- run: ${input.runId}`,
      `- source project: ${PROJECT_ROOT}`,
      "",
      "This is an isolated automation workspace.",
    ].join("\n") + "\n",
    "utf8",
  );
  return workspace;
}

function resolveWorkspaceBase(raw: string): string {
  if (raw.trim()) {
    return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  }
  return path.join(os.tmpdir(), "clio-automation-workspaces", slugify(PROJECT_ROOT) || "llm-wiki");
}

async function writeJobArtifacts(
  job: AutomationJob,
  mode: "plan" | "run",
  source: AutomationSource,
  dir: string,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, "job.md"),
    [
      `# ${job.name}`,
      "",
      `- id: ${job.id}`,
      `- template: ${job.template}`,
      `- mode: ${mode}`,
      `- source: ${source}`,
      `- external_write_policy: ${job.externalWritePolicy}`,
      `- agents: ${job.selectedAgents.join(", ")}`,
      "",
      "## Prompt",
      "",
      job.prompt.trim() || "(empty)",
    ].join("\n") + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "schedule.md"),
    [
      "# Schedule",
      "",
      `- enabled: ${job.enabled}`,
      `- mode: ${job.schedule.mode}`,
      `- preset: ${job.schedule.preset}`,
      `- cron: ${job.schedule.cron}`,
      `- time: ${pad2(job.schedule.time.hour)}:${pad2(job.schedule.time.minute)}`,
      `- day_of_week: ${job.schedule.dayOfWeek}`,
      `- day_of_month: ${job.schedule.dayOfMonth}`,
      `- timezone: ${job.schedule.timezone || "host"}`,
    ].join("\n") + "\n",
    "utf8",
  );
}

function renderSummary(result: AutomationRunResult): string {
  return [
    `# Automation Run: ${result.jobName}`,
    "",
    `- run: ${result.runId}`,
    `- mode: ${result.mode}`,
    `- source: ${result.source}`,
    `- duration_ms: ${result.durationMs}`,
    "",
    "## Agents",
    "",
    ...result.agents.map(
      (agent) =>
        `- ${agent.agent}: ${agent.status} (${agent.durationMs}ms, exit=${agent.exitCode ?? "n/a"})`,
    ),
    "",
  ].join("\n");
}

function formatRunStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
