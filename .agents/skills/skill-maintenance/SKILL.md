---
name: skill-maintenance
description: Maintain CLIO project-local skills under .agents/skills. Use when adding, revising, auditing, or optimizing skills for the LLM Wiki/Code Wiki, including trigger descriptions, routing tables, eval prompts, and AGENTS.md/CLAUDE.md synchronization.
allowed-cli: [codex, claude, gemini, cline]
---

# skill-maintenance

## Purpose

Keep CLIO's project-local skills coherent, small, and compatible with the
repository operating rules.

Use this instead of copying global skills verbatim. Project skills should encode
CLIO-specific behavior: `raw/` immutability, leaf-first processing, Korean
wiki writing, `wiki/index.md`, `wiki/log.md`, graph integration, and safe
source citation.

## Workflow

1. Read `AGENTS.md` and `CLAUDE.md`; they must stay synchronized.
2. Inspect existing `.agents/skills/*/SKILL.md`.
3. Decide whether the change belongs in:
   - an existing wiki skill,
   - an existing code skill,
   - a new focused skill,
   - global user skills rather than this project.
4. Write the skill with progressive disclosure:
   - concise frontmatter description with trigger phrases,
   - body under roughly 500 lines,
   - references/scripts only when genuinely useful.
5. Update routing tables in both `AGENTS.md` and `CLAUDE.md` if the skill is
   user-facing.
6. Update README only when the capability changes the product surface.
7. Run lightweight checks:
   - every skill has `name` and `description`,
   - skill names match directory names unless there is a strong reason,
   - no skill asks agents to mutate `raw/` outside `/preprocess` or approved
     `raw/chat/` capture,
   - no credentials or personal data are embedded.

## Skill Description Rules

Descriptions should be explicit enough to trigger:

- Include command names, natural-language phrases, and context.
- Say what the skill produces.
- Mention CLIO paths when relevant.

Avoid broad descriptions that steal unrelated work from other skills.

## Eval Prompts

When a skill has objective behavior, add 2-3 manual eval prompts in the final
response or a small `evals/evals.json` if the user asks for eval files.

Useful CLIO eval prompt examples:

- "I added a TypeScript repo under `raw/repos/foo`; build a Code Wiki."
- "Run `/lint --fix` after wiki-ingest reorganized code pages."
- "Capture this local web page and ingest it as a source."

## Prohibited

- Do not copy proprietary skill assets into the project without checking their
  license.
- Do not create overlapping skills with unclear ownership.
- Do not update one of `AGENTS.md` or `CLAUDE.md` without updating the other.
