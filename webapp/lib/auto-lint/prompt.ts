import type { AutoLintSource } from "./events";

export function buildAutoLintPrompt(input: {
  sessionPath: string;
  source: AutoLintSource;
  reason: string;
  fix: boolean;
}): string {
  const command = input.fix ? "/lint --fix" : "/lint";
  return [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md and follow .agents/skills/wiki-lint/SKILL.md.",
    `Active session log: sessions/${input.sessionPath}`,
    `This run was triggered automatically (source=${input.source}, reason=${input.reason}).`,
    `Run exactly like a normal \`${command}\` invocation: enumerate wiki pages, check the categories listed in the wiki-lint skill, write the report to \`wiki/lint/<YYYY-MM-DD>.md\` (suffix \`_2\`, \`_3\` on same-day reruns), append a single \`## [YYYY-MM-DD HH:MM] lint | auto-trigger\` line to \`wiki/log.md\`, and update \`wiki/index.md\` if needed. Exit when the report and log entry are persisted.`,
    "",
    "===== CONVERSATION =====",
    `User: ${command}`,
    "",
    "Respond now as the assistant.",
  ].join("\n");
}
