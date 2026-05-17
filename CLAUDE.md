# AGENTS.md / CLAUDE.md - LLM Wiki Operating Rules

> This file is synchronized with its counterpart (`AGENTS.md` or `CLAUDE.md`) so Codex, Claude, Gemini, cline, and other coding agents follow the same rules.
> **The two files must always stay in sync.** If one is updated, update the other as well.

---

> This repository is an **LLM Wiki** implementation of Andrej Karpathy's [`llm-wiki.md`](./llm-wiki.md) pattern.
> You, the coding agent, are the **maintainer** of this wiki. The user is the curator.
> See [`IDEATION.md`](./IDEATION.md) for the design background.

---

## 1. Purpose and Roles

- The user gathers source material in `raw/`. They decide what to read and what to ask.
- You incrementally **build and maintain** the Markdown wiki under `wiki/`.
  - Create summary pages, update entity/concept pages, fill indexes and logs, and flag contradictions.
  - You handle the maintenance work: summarizing, cross-referencing, organizing, and preserving consistency.
- The wiki should be searchable and understandable as a coherent work that another person can read.

## 2. Path Rules

| Path | Owner | Mutability | Purpose |
|---|---|---|---|
| `raw/` | User | **Immutable (read only)** | Original material: articles, papers, notes, images. Never modify or delete it. |
| `wiki/` | LLM | LLM may freely write/update | Main wiki body. All generated artifacts go here. |
| `wiki/sources/` | LLM | LLM | One summary page per original source. |
| `wiki/answers/` | LLM | LLM | Pages fed back from query answers. |
| `wiki/lint/` | LLM | LLM | Lint reports (`<date>.md`). |
| `wiki/graph/` | LLM (graphify) | LLM | Knowledge graph artifacts: `graph.json`, `GRAPH_REPORT.md`, `parts/`, `.state.json`. |
| `wiki/archive/` | LLM | LLM | Old pages moved here instead of being deleted. |
| `wiki/index.md` | LLM | LLM | Category catalog. |
| `wiki/log.md` | LLM | append-only | Chronological operation log. |
| `sessions/` | System | append-only | Chat session Markdown. Never edit manually. |
| `tools/` | setup.sh | System | Project-local helper tools such as qmd. graphify uses the global install. |
| `.agents/skills/` | Project | Change via PR | Project-local skills. **They take priority over global skills.** |
| `webapp/`, `config/` | System | User/admin | Next.js full-stack web UI and settings. Do not touch during wiki operations (`/ingest`, `/query`, `/lint`). |

## 3. Operations - Ingest / Query / Lint

Each of the three operations maps to one skill. If these rules conflict with a skill body, **the skill body takes precedence** within its scope.

### 3.1 Ingest (`/ingest`, [`.agents/skills/wiki-ingest/SKILL.md`](.agents/skills/wiki-ingest/SKILL.md))
- Input: new material under `raw/`, either a single file, URL, or folder.
- Always follow the **leaf-directory chunks + merge pass** principle (Section 7).
- Trigger: manual (`/ingest`, `/ingest-loop`) or **automatic** via Settings → 자동 인제스트 패널 (`raw/` 파일 이벤트 또는 주기 실행). 자동 트리거는 `webapp/lib/auto-ingest/`의 매니저가 동일한 `runIngestLoop()` 헬퍼를 호출하며, 기본 설정(`skipIfBusy: true`)에서는 `.lock` 존재 시 스킵된다.
- Outputs:
  - `wiki/sources/<slug>.md` summary page with YAML frontmatter
  - New or updated related entity/concept pages
  - Updated `wiki/index.md` and `wiki/log.md`
  - `wiki-graphify update` when needed

### 3.2 Query (`/query`, [`.agents/skills/wiki-query/SKILL.md`](.agents/skills/wiki-query/SKILL.md))
- Read `wiki/index.md` first to narrow candidate pages. Use original material in `raw/` only as a fallback when the wiki is insufficient.
- If optional `wiki-search-qmd` is active, delegate search to it.
- If `wiki/graph/graph.json` exists, `wiki-graphify` may be used as an auxiliary graph-context tool, similar to qmd: use it for related nodes, 1-hop neighbors, communities, and cited-page clues, but still read candidate wiki/source pages before answering.
- Choose the response shape freely: Markdown, table, Marp slides, chart, and so on.
- With user consent, feed the answer back into `wiki/answers/<slug>.md` and update `index.md` and `log.md`.

### 3.3 Lint (`/lint`, [`.agents/skills/wiki-lint/SKILL.md`](.agents/skills/wiki-lint/SKILL.md))
- Wiki health check: contradictions, stale claims, orphan pages, broken wikilinks, missing metadata, and frequently mentioned concepts without their own page.
- Write results to `wiki/lint/<YYYY-MM-DD>.md` and separate automatically fixable items from items needing manual review.

## 4. Page Conventions

### 4.1 Page Types
- **Entity**: individual people, places, organizations, products, works, and similar targets.
- **Concept**: topics, theories, patterns.
- **Source**: one page per original source (`wiki/sources/`).
- **Answer**: fed-back query answer (`wiki/answers/`).
- **Comparison/Analysis**: synthesis page comparing or analyzing two or more targets.

### 4.2 Required YAML Frontmatter

```yaml
---
title: <page title>
type: entity | concept | source | answer | comparison | analysis
tags: [tag1, tag2]
sources: [wiki/sources/<slug>.md, ...]   # source summaries supporting this page
updated: YYYY-MM-DD
---
```

### 4.3 Writing Rules
- Use **wikilinks** `[[Page Name]]` or relative Markdown links for all internal links.
- Use external URLs only when the user provided them or they exist in `raw/`. **Do not guess URLs.**
- When citing, put the source on the same line or in a footnote. Example: `... according to the source ([[wiki/sources/foo]]).`
- If a contradiction is found, add a block quote to the affected page:
  ```markdown
  > ⚠️ Conflicts with [[wiki/sources/bar]]: this source claims X. Follow-up review needed.
  ```
- Instead of deleting a page, move it to `wiki/archive/<original-path>` and leave a one-line reason.

## 5. Index and Log Rules

### 5.1 `wiki/index.md`
- Category catalog. Each item is one line: `- [[Page Name]] — One-line summary`.
- Categories: `Entities`, `Concepts`, `Sources`, `Answers`, `Comparisons`, `Lint Reports`, `Graph`.
- At the final step of each ingest/query/lint merge pass, sort and deduplicate the index in bulk.

### 5.2 `wiki/log.md`
- Format, with a one-line heading and optional body:
  ```markdown
  ## [YYYY-MM-DD HH:MM] ingest | <source title or folder name>
  - Changed files: `wiki/sources/foo.md`, `wiki/concepts/bar.md`
  - Notes: N chunks, merge pass complete
  ```
- Operation types: `ingest`, `query`, `lint`, `graph`.
- **Append-only**. Do not edit old entries; append a new entry to correct or supplement them.

## 6. Skill Routing

| User input pattern | Skill to call |
|---|---|
| `/ingest <path|url>`, "summarize this material", `+ -> ingest` | [`wiki-ingest`](.agents/skills/wiki-ingest/SKILL.md) |
| `/query <question>`, general questions | [`wiki-query`](.agents/skills/wiki-query/SKILL.md) |
| `/lint`, "check the wiki" | [`wiki-lint`](.agents/skills/wiki-lint/SKILL.md) |
| "build/update/query the graph" | [`wiki-graphify`](.agents/skills/wiki-graphify/SKILL.md) |
| Optional qmd installed | [`wiki-search-qmd`](.agents/skills/wiki-search-qmd/SKILL.md) |
| Optional marp installed | [`wiki-marp`](.agents/skills/wiki-marp/SKILL.md) |

**Priority**: `.agents/skills/` (project-local) > global skills. graphify execution uses the **global `graphify` command from `PATH`**. If missing, `setup.sh` installs the official `graphifyy` package and runs `graphify install`.

## 7. Shared Operation Principle - Leaf-First + Merge (Required)

This applies to both ingest and graphify. Never start by throwing the whole root into one operation.

1. **Find leaf directories**: in the target tree (`raw/`, `wiki/`), find directories with no child directories.
2. **Process by chunk**: group only the files in each leaf and process them once.
3. **Preserve partial outputs**:
   - ingest: immediately save chunk-level summaries/entity pages.
   - graphify: save partial graphs to `wiki/graph/parts/<path-hash>.json`.
4. **Merge pass as a separate step**:
   - ingest: update parent-level pages -> root synthesis page -> reorder `index.md`.
   - graphify: merge all partial graphs with node normalization and community recomputation, then finalize `wiki/graph/graph.json`.
5. **Persist state**:
   - ingest: record chunk checklists in `sessions/<date>/<time>_ingest.md`.
   - graphify: record last build time and hash per leaf in `wiki/graph/.state.json`.
6. **Resumability**: if interrupted, continue from unfinished chunks next time. Skip already completed chunks.
7. **Chunk limits**: file count and byte limits per chunk follow `config/default.json`. Tune them to the host CLI context limit.

## 8. Graph Integration

- Graph creation, update, and query operations must go through the [`wiki-graphify`](.agents/skills/wiki-graphify/SKILL.md) skill.
- The web app Graph tab does not execute graphify directly. It sends `wiki-graphify build/update` requests to the coding agent CLI selected in Settings, and the coding agent follows this repository's rules and skills to run graphify, chunk processing, and the merge pass.
- Wiki pages must not call the `graphify` binary directly. The coding agent running `wiki-graphify` chooses the execution path: global `graphify`, or `python3 -m graphify` when needed.
- `wiki-query` may optionally use graph context from `wiki/graph/GRAPH_REPORT.md`, node adjacency, or `wiki-graphify query` as an auxiliary candidate/context source; it must still ground final answers in wiki/source pages.
- At the end of an ingest merge pass, calling `wiki-graphify update` is recommended, depending on user settings.

## 9. Hard Rules

- Do **not** modify, delete, or move files under `raw/`. Only the user adds to it.
- Do **not** arbitrarily delete files under `wiki/`. Retire pages by moving them to `wiki/archive/` and recording the reason.
- Do **not** invent external URLs. If there is no source, mark it as "source unknown" and record it in the operation log.
- Do **not** manually edit `sessions/`, `config/local.json`, or `.env*`.
- Do not leave credentials, API keys, or personal data in plaintext in wiki pages. If found, mask them and report them under `wiki/lint/`.
- Do not try to ingest all of `raw/` in one pass. Always follow the chunk policy in Section 7.

## 10. Host Coding Agent CLI

This repository is operated through one of the coding agent CLIs installed on the host PC.

| CLI | Invocation shape | Non-interactive/yolo flag |
|---|---|---|
| `codex` | `codex exec "<prompt>"` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude -p "<prompt>"` | `--dangerously-skip-permissions` |
| `gemini` | `gemini --prompt "<prompt>"` | `--approval-mode yolo` (`--include-directories` helper) |
| `cline` | `cline -y "<prompt>"` | `-y` (auto-approval) |

- Any agent entering this repository treats these operating rules as the primary local rules.
- yolo mode must apply **only inside this repository**. The adapter forces `cwd`, so behavior that leaks outside the wiki path must be rejected.

## 11. Writing Language

- Unless the user specifies otherwise, wiki pages, logs, and answers should prefer **Korean**. Identifiers such as filenames, tags, frontmatter keys, commands, URLs, and code stay in English.
- If the original source is English, provide a Korean summary together with short key quotes in the original English when useful.

## 12. Override Order

1. Direct instructions from the user in the current session.
2. This `AGENTS.md` / `CLAUDE.md` file.
3. Each skill's `SKILL.md` body, within that skill's scope.
4. External/global rules such as `~/.codex` or `~/.claude/CLAUDE.md`.
5. System defaults.

If this file is updated, synchronize the counterpart file as well.

---

## Appendix A - Quick Checklist

Mental checklist for one ingest run:

- [ ] Did you list leaf directories from the input tree?
- [ ] Is the chunk within the file-count and byte limits?
- [ ] Did you write `wiki/sources/<slug>.md` for each chunk?
- [ ] Did you append one line to `wiki/log.md` for each chunk?
- [ ] Did you organize parent pages and `index.md` in the merge pass?
- [ ] Optional: did you call `wiki-graphify update`?
- [ ] Did you record progress in the session Markdown?
