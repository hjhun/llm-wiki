import "server-only";

import { loadConfig } from "../config";
import { runCli, type CliName } from "../cli";
import { detectAutomationTools, type AutomationToolInventory } from "./tools";
import type { AutomationJob } from "./types";

export type AutomationBuilderProposal = {
  job: Omit<AutomationJob, "id">;
  requiredTools: string[];
  requiredSkills: string[];
  missingRequirements: string[];
  verificationSteps: string[];
  riskNotes: string[];
  analysisNotes: string[];
};

export async function buildAutomationProposal(input: {
  goal: string;
  schedulePreference: string;
  selectedAgents: CliName[];
  analyzerAgent: CliName | null;
}): Promise<AutomationBuilderProposal> {
  const inventory = await detectAutomationTools();
  const fallback = heuristicProposal(input, inventory);
  if (!input.analyzerAgent) return fallback;

  try {
    const cfg = await loadConfig();
    const result = await runCli(input.analyzerAgent, builderPrompt(input), {
      safeMode: cfg.agent.safeMode,
      timeoutMs: 120_000,
    });
    const parsed = parseProposalJson(result.stdout || result.stderr);
    if (!parsed) return fallback;
    return mergeToolStatus(parsed, inventory);
  } catch {
    return fallback;
  }
}

function builderPrompt(input: {
  goal: string;
  schedulePreference: string;
  selectedAgents: CliName[];
}): string {
  return [
    "Analyze this natural-language Clio automation request and return JSON only.",
    "Do not execute the task. Do not install tools. Do not mutate external systems.",
    "External writes must stay draft-only.",
    "Required JSON shape:",
    JSON.stringify(
      {
        job: {
          name: "short name",
          enabled: false,
          template: "custom",
          prompt: "safe recurring task prompt",
          schedule: {
            mode: "preset",
            preset: "daily",
            cron: "0 9 * * *",
            time: { hour: 9, minute: 0 },
            dayOfWeek: 1,
            dayOfMonth: 1,
            timezone: "",
          },
          selectedAgents: input.selectedAgents,
          workspaceBasePath: "",
          externalWritePolicy: "draft-only",
          autoIngestAfterRun: true,
        },
        requiredTools: ["git"],
        requiredSkills: [],
        missingRequirements: [],
        verificationSteps: [],
        riskNotes: [],
        analysisNotes: [],
      },
      null,
      2,
    ),
    "",
    `Goal: ${input.goal}`,
    `Schedule preference: ${input.schedulePreference || "not specified"}`,
    `Selected agents: ${input.selectedAgents.join(", ")}`,
  ].join("\n");
}

function parseProposalJson(text: string): AutomationBuilderProposal | null {
  const raw = text.trim();
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = match ? match[1] : raw;
  try {
    return normalizeProposal(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function normalizeProposal(value: unknown): AutomationBuilderProposal {
  const v = value as AutomationBuilderProposal;
  const job = v.job;
  return {
    job: {
      name: stringOr(job?.name, "New automation"),
      enabled: false,
      template: validTemplate(job?.template),
      prompt: stringOr(job?.prompt, ""),
      schedule: {
        mode: job?.schedule?.mode === "cron" ? "cron" : "preset",
        preset: validPreset(job?.schedule?.preset),
        cron: stringOr(job?.schedule?.cron, "0 9 * * *"),
        time: {
          hour: clampInt(job?.schedule?.time?.hour, 0, 23, 9),
          minute: clampInt(job?.schedule?.time?.minute, 0, 59, 0),
        },
        dayOfWeek: clampInt(job?.schedule?.dayOfWeek, 0, 6, 1),
        dayOfMonth: clampInt(job?.schedule?.dayOfMonth, 1, 28, 1),
        timezone: stringOr(job?.schedule?.timezone, ""),
      },
      selectedAgents: normalizeAgents(job?.selectedAgents),
      workspaceBasePath: stringOr(job?.workspaceBasePath, ""),
      externalWritePolicy: "draft-only",
      autoIngestAfterRun: Boolean(job?.autoIngestAfterRun ?? true),
    },
    requiredTools: arrayOfStrings(v.requiredTools),
    requiredSkills: arrayOfStrings(v.requiredSkills),
    missingRequirements: arrayOfStrings(v.missingRequirements),
    verificationSteps: arrayOfStrings(v.verificationSteps),
    riskNotes: arrayOfStrings(v.riskNotes),
    analysisNotes: arrayOfStrings(v.analysisNotes),
  };
}

function heuristicProposal(
  input: { goal: string; schedulePreference: string; selectedAgents: CliName[] },
  inventory: AutomationToolInventory,
): AutomationBuilderProposal {
  const goal = input.goal.trim();
  const lower = goal.toLowerCase();
  const isYouTube = /youtube|youtu\.be|유튜브/.test(lower);
  const isReview = /github|gerrit|pull request|pr|patch|review|리뷰|패치/.test(lower);
  const isEmail = /email|gmail|outlook|mail|메일|이메일/.test(lower);
  const isBrowser = /web|browser|site|scrape|crawl|웹|브라우저|사이트|크롤|스크랩/.test(lower);
  const template = isYouTube
    ? "youtube-summary"
    : isReview
      ? "github-gerrit-review"
      : isEmail
        ? "email-sync"
        : "custom";
  const requiredTools = [
    ...(isBrowser || isYouTube ? ["agent-browser"] : []),
    ...(isYouTube ? ["yt-dlp"] : []),
    ...(isReview ? ["git"] : []),
    ...(isReview && /github|pull request|pr/.test(lower) ? ["gh"] : []),
  ];
  const requiredSkills = isBrowser || isYouTube ? ["agent-browser"] : [];
  const missingRequirements = missingFromInventory(
    inventory,
    requiredTools,
    requiredSkills,
  );
  const title = titleFromGoal(goal, template);
  return mergeToolStatus(
    {
      job: {
        name: title,
        enabled: false,
        template,
        prompt: safePrompt(goal, requiredTools, missingRequirements),
        schedule: scheduleFromPreference(input.schedulePreference),
        selectedAgents: input.selectedAgents.length > 0 ? input.selectedAgents : ["codex"],
        workspaceBasePath: "",
        externalWritePolicy: "draft-only",
        autoIngestAfterRun: true,
      },
      requiredTools,
      requiredSkills,
      missingRequirements,
      verificationSteps: [
        "Run a dry-run plan in an isolated workspace.",
        "Confirm missing tools or credentials are reported as blockers instead of causing external mutations.",
        "Check raw/automation artifacts for per-agent plan/result logs.",
      ],
      riskNotes: [
        "External writes are draft-only; posting reviews or sending email requires a separate approval flow.",
        "Credentials are not stored in the job definition.",
      ],
      analysisNotes: ["Generated by local heuristic builder; an analyzer CLI can refine it when available."],
    },
    inventory,
  );
}

function mergeToolStatus(
  proposal: AutomationBuilderProposal,
  inventory: AutomationToolInventory,
): AutomationBuilderProposal {
  const missing = new Set(proposal.missingRequirements);
  for (const item of missingFromInventory(
    inventory,
    proposal.requiredTools,
    proposal.requiredSkills,
  )) {
    missing.add(item);
  }
  return {
    ...proposal,
    job: {
      ...proposal.job,
      enabled: false,
      externalWritePolicy: "draft-only",
      prompt: safePrompt(
        proposal.job.prompt || "",
        proposal.requiredTools,
        [...missing],
      ),
    },
    missingRequirements: [...missing],
  };
}

function missingFromInventory(
  inventory: AutomationToolInventory,
  tools: string[],
  skills: string[],
): string[] {
  const missing: string[] = [];
  for (const tool of tools) {
    if (inventory.tools.find((item) => item.name === tool)?.status !== "ready") {
      missing.push(`tool:${tool}`);
    }
  }
  for (const skill of skills) {
    if (inventory.skills.find((item) => item.name === skill)?.status !== "ready") {
      missing.push(`skill:${skill}`);
    }
  }
  return missing;
}

function safePrompt(goal: string, requiredTools: string[], missing: string[]): string {
  return [
    goal.trim(),
    "",
    "Automation safety rules:",
    "- Do not mutate external systems.",
    "- Create draft outputs only for review comments, emails, uploads, or remote writes.",
    "- Use the isolated workspace and write reproducible notes.",
    "- Record missing credentials or tools as blockers instead of guessing.",
    requiredTools.length ? `- Preferred tools: ${requiredTools.join(", ")}.` : "",
    missing.length ? `- Known missing requirements: ${missing.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function scheduleFromPreference(preference: string): AutomationJob["schedule"] {
  const lower = preference.toLowerCase();
  const preset = /hour|시간|매시간/.test(lower)
    ? "hourly"
    : /week|주|weekly/.test(lower)
      ? "weekly"
      : /month|월|monthly/.test(lower)
        ? "monthly"
        : "daily";
  return {
    mode: "preset",
    preset,
    cron: "0 9 * * *",
    time: { hour: 9, minute: 0 },
    dayOfWeek: 1,
    dayOfMonth: 1,
    timezone: "",
  };
}

function titleFromGoal(goal: string, template: AutomationJob["template"]): string {
  const compact = goal.replace(/\s+/g, " ").trim();
  if (compact.length > 0) return compact.slice(0, 80);
  if (template === "youtube-summary") return "YouTube summary automation";
  if (template === "github-gerrit-review") return "Patch review automation";
  if (template === "email-sync") return "Email sync automation";
  return "Custom automation";
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validTemplate(value: unknown): AutomationJob["template"] {
  return value === "youtube-summary" ||
    value === "github-gerrit-review" ||
    value === "email-sync" ||
    value === "custom"
    ? value
    : "custom";
}

function validPreset(value: unknown): AutomationJob["schedule"]["preset"] {
  return value === "hourly" ||
    value === "daily" ||
    value === "weekly" ||
    value === "monthly"
    ? value
    : "daily";
}

function normalizeAgents(value: unknown): CliName[] {
  const valid = new Set(["codex", "claude", "agy", "cline"]);
  const agents = Array.isArray(value)
    ? value.filter((item): item is CliName => typeof item === "string" && valid.has(item))
    : [];
  return agents.length > 0 ? agents : ["codex"];
}
