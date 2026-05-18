import type { AutomationJob } from "./types";

export const AUTOMATION_TEMPLATE_LABELS: Record<AutomationJob["template"], string> = {
  "youtube-summary": "YouTube summary",
  "github-gerrit-review": "GitHub/Gerrit review",
  "email-sync": "Email sync",
  custom: "Custom",
};

export function templatePrompt(job: AutomationJob): string {
  const base = [
    `Automation job: ${job.name}`,
    `Template: ${AUTOMATION_TEMPLATE_LABELS[job.template]}`,
    "External write policy: draft-only. Do not post comments, send email, mutate remote state, or change external systems.",
    "Work only inside the current working directory unless the user prompt explicitly names another checkout path.",
    "Write a concise Markdown result suitable for an automation record.",
  ];

  if (job.template === "youtube-summary") {
    base.push(
      "Task shape: inspect the requested YouTube source, gather available metadata/transcript text, parse the useful signal, and summarize findings. If access is unavailable, explain the missing input and provide a draft next action.",
    );
  } else if (job.template === "github-gerrit-review") {
    base.push(
      "Task shape: inspect the requested GitHub or Gerrit patch in this isolated workspace, review correctness and risks, and produce draft review comments. Do not upload the review.",
    );
  } else if (job.template === "email-sync") {
    base.push(
      "Task shape: inspect the requested mailbox/source, summarize new messages, and produce draft follow-up actions. Do not mark messages read, send replies, or mutate mail state.",
    );
  } else {
    base.push("Task shape: execute the recurring custom research or maintenance prompt.");
  }

  if (job.prompt.trim()) {
    base.push("", "User prompt:", job.prompt.trim());
  }
  return base.join("\n");
}

export function automationPlanPrompt(job: AutomationJob): string {
  return [
    "Create a concrete execution plan for this recurring Clio automation job.",
    "Do not perform the recurring task yet. Do not mutate external systems.",
    "The plan must include inputs needed, exact steps, expected artifacts, risks, and acceptance criteria.",
    "",
    templatePrompt(job),
  ].join("\n");
}

export function automationRunPrompt(job: AutomationJob): string {
  return [
    "Run this Clio automation job now inside this isolated workspace.",
    "Do not mutate external systems; create draft-only outputs when an upload/send action would otherwise happen.",
    "Return a Markdown report with findings, draft external writes, files created, and follow-up actions.",
    "",
    templatePrompt(job),
  ].join("\n");
}
