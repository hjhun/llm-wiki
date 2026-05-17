---
name: wiki-search-qmd
description: If qmd is installed, assist wiki-query candidate search with BM25/vector/reranking. Prefer tools/qmd and fall back to qmd from PATH.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-search-qmd

## Purpose

When `wiki-query` is narrowing candidate pages before answering a question, this skill assists search if qmd is installed.

This is an **optional feature**. If qmd is missing, treat it as "inactive" rather than a failure, and let `wiki-query` continue with the default flow: `wiki/index.md` -> candidate pages -> 1-hop expansion.

## Execution Path Rules

Priority:

1. Project-local install under `tools/qmd/`.
2. Global `qmd` found in `PATH`.
3. None -> inactive. Leave installation guidance for the user and return to `wiki-query`.

Candidate execution paths:

- `tools/qmd/bin/qmd`
- `tools/qmd/.venv/bin/qmd`
- `tools/qmd/run.sh`
- `qmd` from `PATH`

## Triggers

- When `wiki-query` checks whether qmd is active during preflight.
- When the user asks "search with qmd" or "run wiki search through qmd".
- Direct command: `wiki-search-qmd "<question>"`

## Input

- One natural-language question.
- Optional flags:
  - `--k=<n>` number of candidates. Default 10.
  - `--scope=wiki|wiki+raw`. Default `wiki`.
  - `--explain` include search scores and selection reasons.

## Output

Return a candidate list for `wiki-query`.

```markdown
## qmd candidates

1. `wiki/concepts/foo.md` — score 0.82 — matches the main keywords in the question
2. `wiki/sources/2026/2026-05/bar.md` — score 0.76 — source summary contains related explanation
```

## Workflow

1. Check the qmd execution path. If unavailable, leave this message and exit:
   > qmd is not installed, so I will continue with the default wiki search. Run `./setup.sh --with-qmd` if you need qmd.
2. Search only `wiki/` by default. Include `raw/` as read-only input only when `--scope=wiki+raw` is explicit.
3. Use `config/default.json` chunk limits (`chunking.maxFiles`, `chunking.maxBytes`) so large inputs are not passed at once.
4. If qmd creates indexes or caches, use `tools/qmd/`, `.cache/`, or qmd's own default cache location. Do not create cache files inside wiki documents.
5. Returned candidates must be real existing paths.
6. `wiki-query` merges these candidates with candidates from `wiki/index.md`, deduplicates them, and then reads the final pages.

## Prohibited

- Do not write the answer from qmd results alone. `wiki-query` must read candidate pages before answering.
- Do not modify `raw/`.
- Do not invent external URLs.
- If API keys or personal data appear in search results, mask them and recommend a follow-up `wiki-lint` check.

## Installation Guidance

Project-local install:

```bash
./setup.sh --with-qmd
```

Manual install:

```bash
cd tools
git clone https://github.com/tobi/qmd.git
```

After installation, check `qmd` status in the Tools section of the Settings tab.

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — uses candidate search results from this skill.
- [wiki-lint](../wiki-lint/SKILL.md) — follow-up check for sensitive information or broken links found during search.
