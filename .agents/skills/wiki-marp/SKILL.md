---
name: wiki-marp
description: If Marp CLI is installed, turn wiki-query answers into presentation Markdown slides and optionally assist HTML/PDF/PPTX export.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-marp

## Purpose

Respond to `wiki-query --format=marp` or a user request such as "turn this answer into slides" by writing Marp Markdown slides backed by wiki evidence.

This is an **optional feature**. If Marp CLI is missing, write only the slide Markdown (`.md`) and skip HTML/PDF/PPTX export with installation guidance.

## Execution Path Rules

Priority:

1. Project-local install under `tools/marp-cli/`.
2. Global `marp` found in `PATH`.
3. None -> generate Markdown slides only and disable export.

Candidate execution paths:

- `tools/marp-cli/node_modules/.bin/marp`
- `tools/marp-cli/bin/marp`
- `marp` from `PATH`

## Triggers

- `/query <question> --format=marp`
- "Turn this answer into slides"
- "Export with Marp"
- Direct command: `wiki-marp <wiki/answers/foo.md|question>`

## Input

- A draft answer from `wiki-query`, or an existing `wiki/answers/*.md`.
- Optional flags:
  - `--slides=<n>` target slide count. Default 6-10.
  - `--export=html|pdf|pptx|none`. Default `none`.
  - `--theme=<name>`. Default `default`.

## Output

- Default artifact: `wiki/answers/<slug>.slides.md`
- If export is requested and Marp CLI is available:
  - `wiki/answers/<slug>.html`
  - `wiki/answers/<slug>.pdf`
  - `wiki/answers/<slug>.pptx`

## Slide Writing Rules

1. Prefer Korean unless the user requested another language. Include short original-language quotes only when useful.
2. Put the title and question/topic on the first slide.
3. Each body slide should carry one message.
4. Cite every factual claim.
   - Wiki source: `[[wiki/sources/foo]]`
   - Graph source: `(graph: community #3, node "Foo")`
   - Original source: `raw/...`
5. Make the final slide "Reference Pages" and list cited wiki pages.
6. Avoid long paragraphs for presentation use; prefer 3-5 bullets.

## Marp Frontmatter

`wiki/answers/<slug>.slides.md` uses this frontmatter.

```yaml
---
marp: true
theme: default
paginate: true
title: <slide title>
description: <original question summary>
---
```

## Export Workflow

1. Check the Marp CLI execution path.
2. If unavailable, save only `.slides.md` and leave this message:
   > Marp CLI is missing, so I saved only the Markdown slides. Run `./setup.sh --with-marp` if you need export.
3. If available, run the requested format command.
   ```bash
   marp wiki/answers/foo.slides.md --html -o wiki/answers/foo.html
   marp wiki/answers/foo.slides.md --pdf -o wiki/answers/foo.pdf
   marp wiki/answers/foo.slides.md --pptx -o wiki/answers/foo.pptx
   ```
4. Link export results in the `Answers` or `Comparisons` section of `wiki/index.md`.
5. Append a slide-generation entry to `wiki/log.md`, associated with the `query` or `graph` operation.

## Prohibited

- Do not include unsupported claims in slides.
- Do not copy long original passages or long copyrighted quotes.
- Do not modify `raw/`.
- Do not hide export failures. Report stderr summary and the Markdown artifact path.

## Installation Guidance

Install through project setup:

```bash
./setup.sh --with-marp
```

Manual install:

```bash
npm install -g @marp-team/marp-cli
```

After installation, check `marp` status in the Tools section of the Settings tab.

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — calls this skill when the answer uses `--format=marp`.
- [wiki-graphify](../wiki-graphify/SKILL.md) — provides evidence context for graph-based presentations.
