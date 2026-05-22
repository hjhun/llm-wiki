---
name: clio
description: Use this skill when coding, debugging, reviewing, documenting, planning, or answering with help from a CLIO / LLM Wiki knowledge base. Trigger when the user mentions CLIO, llm-wiki, Code Wiki, wiki/index.md, raw/, graphify, qmd, prior project knowledge, architecture notes, source summaries, or asks to reference existing knowledge during development.
---

# CLIO

Use CLIO as local project memory. CLIO keeps source material in `raw/` and
agent-maintained Markdown knowledge in `wiki/`, including Code Wiki pages under
`wiki/code/`.

## Core Behavior

1. Find the CLIO root before using wiki context.
2. Read `wiki/index.md` first to narrow candidate pages.
3. Read only the relevant pages under `wiki/`, especially `wiki/code/`,
   `wiki/sources/`, `wiki/answers/`, and `wiki/lint/`.
4. Use `wiki/graph/`, qmd, or search helpers only as auxiliary candidate
   discovery. Final answers must still be grounded in pages you actually read.
5. Cite the wiki paths you used in answers, review notes, plans, or code-change
   summaries.
6. Treat `raw/` as immutable source evidence. Do not modify, delete, format,
   vendor-prune, or rewrite `raw/` files.

## When Coding

Before changing code, use CLIO context when the task could depend on previous
architecture decisions, source summaries, module docs, API notes, debug notes,
or known project conventions. Keep the code edit itself in the target project;
CLIO is context unless the user explicitly asks to run a CLIO operation.

## Finding Context

Prefer these bundled helpers when available:

```bash
references/workflow.md
scripts/find-clio-root.sh
scripts/inspect-index.sh
scripts/search-wiki.sh
```

If helpers are unavailable, use ordinary shell tools:

```bash
rg --files wiki
sed -n '1,220p' wiki/index.md
rg -n "term|concept|module" wiki
```

## Routing

- If the user asks to ingest material, run the repository-local CLIO ingest
  workflow rather than inventing a new one.
- If the user asks a knowledge question, query the wiki first and use `raw/`
  only as fallback evidence.
- If the user asks to lint, graph, preprocess, or capture websites, follow the
  project-local CLIO skill for that operation when present.

## Safety

Read `references/safety.md` before any task that might touch `raw/`, credentials,
private source material, or external citations.
