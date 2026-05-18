import type { Config } from "../config";
import type { CliName } from "../cli";

export type AutomationConfig = Config["automation"];
export type AutomationJob = AutomationConfig["jobs"][number];
export type AutomationTemplate = AutomationJob["template"];
export type AutomationSource = "cron" | "manual" | "plan";

export type AutomationAgentResult = {
  agent: CliName;
  status: "success" | "error";
  workspacePath: string;
  artifactPath: string;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
};

export type AutomationRunResult = {
  jobId: string;
  jobName: string;
  runId: string;
  mode: "plan" | "run";
  source: AutomationSource;
  artifactRoot: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agents: AutomationAgentResult[];
};
