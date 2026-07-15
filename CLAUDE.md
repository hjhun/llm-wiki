# AGENTS.md / CLAUDE.md / GEMINI.md - LLM Wiki Operating Rules

> This file is synchronized with its counterparts (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) so Codex, Claude, agy, gemini, cline, and other coding agents follow the same rules.
> **All three files must always stay byte-identical.** If one is updated, update the others as well.

---

> This repository is an **LLM Wiki** implementation of Andrej Karpathy's [`llm-wiki.md`](./llm-wiki.md) pattern.
> You, the coding agent, are the **maintainer** of this wiki. The user is the curator.
> These operating rules preserve the core `llm-wiki.md` idea (immutable raw
> sources, persistent generated wiki, schema-driven LLM maintenance) while
> specializing it for CLIO's web UI, resumable ingest loop, and Code Wiki workflows.
> CLIO also supports a **Code Wiki** mode: source code stored under `raw/` (or
> approved `raw/` symlinks) is summarized into Markdown under `wiki/`.

---

## 1. Purpose and Roles

- The user gathers source material in `raw/`. They decide what to read and what to ask. Source material may be prose, PDFs, web captures, logs, or software codebases.
- You incrementally **build and maintain** the Markdown wiki under `wiki/`.
  - Create summary pages, update entity/concept pages, fill indexes and logs, and flag contradictions.
  - Treat source summaries as provenance, not the finish line. Ingest should compile durable takeaways into the existing entity, concept, map, comparison, and synthesis pages so the wiki compounds over time.
  - For code inputs, preserve source summaries and optional code analysis pages under `wiki/`.
  - You handle the maintenance work: summarizing, cross-referencing, organizing, and preserving consistency.
- The wiki should be searchable and understandable as a coherent work that another person can read.

## 2. Path Rules

| Path | Owner | Mutability | Purpose |
|---|---|---|---|
| `raw/` | User | **Immutable** except via `/preprocess` (Section 3.4) | Original material: articles, papers, notes, images. May contain user-approved symlinks to external source folders/files; agents may follow them read-only for ingest/query, but must keep all recorded source paths in `raw/...` form. Outside the `/preprocess` workflow, never modify, delete, or move. |
| `raw/chat/` | User via Chat UI | Append-only capture | User-approved external captures from Chat, such as browser/search/tool findings. These are source candidates for later `/ingest`, not full conversation logs. |
| `raw/.trash/` | LLM via `/preprocess`, UI soft-delete | Append-only quarantine | Files moved out of `raw/` by `/preprocess` or by the Explorer's delete button. Filename is `<ISO8601>_<basename>`; recoverable. |
| `wiki/` | LLM | LLM may freely write/update | Main wiki body. All generated artifacts go here. |
| `wiki/sources/` | LLM | LLM | Provenance ledger: one summary page per original `raw/` source, mirroring the logical `raw/` directory structure, plus a generated `wiki/sources/index.md` catalog for topic/entity/source-kind/date lookup. |
| `wiki/maps/` | LLM | LLM | Optional associative trails and topic maps that connect sources, entities, concepts, answers, and open questions. |
| `wiki/code/` | LLM | LLM | Code analysis pages synthesized from source summaries and other wiki evidence. |
| `wiki/answers/` | LLM | LLM | Pages fed back from query answers. |
| `wiki/lint/` | LLM | LLM | Lint reports (`<date>.md`). |
| `wiki/archive/` | LLM | LLM | Old pages moved here instead of being deleted. |
| `wiki/index.md` | LLM | LLM | Category catalog. |
| `wiki/log.md` | LLM | append-only | Chronological operation log. |
| `sessions/` | System | append-only | Chat session Markdown. Never edit manually. |
| `tools/` | setup.sh | System | Project-local helper tools such as qmd. |
| `.agents/skills/` | Project | Change via PR | Project-local skills. **They take priority over global skills.** |
| `webapp/`, `config/` | System | User/admin | Next.js full-stack web UI and settings. Do not touch during wiki operations (`/ingest`, `/query`, `/lint`). |
| `cli-rs/`, `bin/` | System | User/admin | Rust `clio` CLI source and the binary `setup.sh` builds from it. Do not touch during wiki operations. |

## 3. Operations - Preprocess / Ingest / Query / Lint / Code Wiki

Each operation maps to one or more project skills. If these rules conflict with a skill body, **the skill body takes precedence** within its scope.

### 3.1 Ingest (`/ingest`, [`.agents/skills/wiki-ingest/SKILL.md`](.agents/skills/wiki-ingest/SKILL.md))
- Input: new material under `raw/`, either a single file, URL, folder, or user-approved symlink entry under `raw/`.
- Always follow the **leaf-directory chunks + merge pass** principle (Section 7).
- Trigger: manual (`/ingest`, `/ingest-loop`) or **automatic** via the Settings → Auto Ingest panel (`raw/` file events or interval schedule). Manual Chat/API runs drive the same per-unit `wiki-ingest` contract through the single-agent `runIngestLoop` backend loop (one warm CLI session per iteration, batching sub-chunks per `chunking.unitPerCall`); there is no multi-worker fan-out. Targeted `/ingest-loop <raw-path>` must keep that raw scope across all iterations. The auto trigger is driven by the manager in `webapp/lib/auto-ingest/`, which calls `runIngestLoop()` directly; by default (`skipIfBusy: true`) it is skipped while `.lock` exists.
- Outputs:
  - `wiki/sources/<raw-relative-path>.md` provenance summary page with YAML frontmatter, mirroring the logical `raw/` path
  - New or updated related entity/concept/comparison/synthesis pages that integrate durable takeaways into the persistent wiki
  - Updated `wiki/sources/index.md` source catalog when source pages are added or changed
  - Optional `wiki/maps/<topic>.md` associative trail pages when a source belongs to an ongoing research thread
  - Updated `wiki/index.md` and `wiki/log.md`

### 3.2 Query (`/query`, [`.agents/skills/wiki-query/SKILL.md`](.agents/skills/wiki-query/SKILL.md))
- Read `wiki/index.md` first to narrow candidate pages. Use original material in `raw/` only as a fallback when the wiki is insufficient.
- If optional `wiki-search-qmd` is active, delegate search to it.
- Unless the user explicitly requests another format, answer in Markdown. Use table, Marp slides, chart, or other formats only when requested by flag or natural language.
- With user consent, feed the answer back into `wiki/answers/<slug>.md` and update `index.md` and `log.md`.

### 3.3 Lint (`/lint`, [`.agents/skills/wiki-lint/SKILL.md`](.agents/skills/wiki-lint/SKILL.md))
- Wiki health check: contradictions, stale claims, orphan pages, broken wikilinks, missing metadata, and frequently mentioned concepts without their own page.
- Write results to `wiki/lint/<YYYY-MM-DD>.md` and separate automatically fixable items from items needing manual review.

### 3.4 Preprocess (`/preprocess`, [`.agents/skills/wiki-preprocess/SKILL.md`](.agents/skills/wiki-preprocess/SKILL.md))
- Input: a path under `raw/` plus a free-form natural-language description of which noise patterns to remove (ads, navigation, footers, empty files, duplicate snapshots, etc.).
- Trigger: manual only — `/preprocess [path] [description]` (dry-run) and `/preprocess --apply` (commit). No automatic trigger.
- Outputs:
  - `raw/.trash/<ISO-ts>_<basename>` — files (or content backups) moved out of `raw/`
  - For content-level rules, the cleaned bytes are written back to the original `raw/` path after the original is backed up to `raw/.trash/`
  - `progress/preprocess/<ts>-{rules,plan}.{json,md}` and `<ts>-applied.json`
  - One line appended to `wiki/log.md`
- Always runs in two phases: the dry-run must produce a `<ts>-plan.json` and a chat summary first; only `/preprocess --apply` mutates `raw/`.
- Leaf-first chunking still applies for large `raw/` trees (Section 7) — the skill enumerates leaves under `target` and merges per-leaf plans into a single `<ts>-plan.json` before showing the user.

### 3.5 Code Wiki (inside `/ingest`, [`.agents/skills/wiki-ingest/SKILL.md`](.agents/skills/wiki-ingest/SKILL.md))
- Input: source code, repositories, logs, stack traces, test output, CI output, or code-related captures under `raw/`.
- Treat `raw/` code as immutable source evidence. Do not format, build, patch, delete, or vendor-prune it during Code Wiki operations.
- Always follow the **leaf-directory chunks + merge pass** principle (Section 7), using the normal `progress/ingest/` state. There is no separate user-facing Code Wiki command.
- Outputs:
  - one compact `wiki/sources/<raw-relative-path>.md` source card per code file
  - optional `wiki/sources/<project>/index.md` project catalog when useful for navigation
  - optional `wiki/code/<project>.md` detailed project analysis synthesized from source summaries and wiki evidence
  - updated `wiki/index.md` and appended `wiki/log.md` entries
- Use specialized Code Wiki skills only for optional synthesis after source evidence exists:
  - [`code-documentation`](.agents/skills/code-documentation/SKILL.md) for module/API/runbook docs
  - [`code-architecture`](.agents/skills/code-architecture/SKILL.md) for architecture synthesis
  - [`code-testing`](.agents/skills/code-testing/SKILL.md) for test inventory and gaps
  - [`code-debug`](.agents/skills/code-debug/SKILL.md) for logs, stack traces, and failure analysis

### 3.6 Browser Capture (`browser-capture`, [`.agents/skills/browser-capture/SKILL.md`](.agents/skills/browser-capture/SKILL.md))
- Input: user-approved web pages, CLIO web UI QA observations, browser screenshots, or extracted text.
- Output: source candidates under `raw/chat/<YYYY-MM-DD>/` for later `/ingest`; autonomous job progress and QA run records live under `progress/automation/artifacts/<slug>/`.
- Do not capture credentials, cookies, API keys, or private account data unless explicitly required and safely redacted.

## 4. Page Conventions

### 4.1 Page Types
- **Entity**: individual people, places, organizations, products, works, and similar targets.
- **Concept**: topics, theories, patterns.
- **Source**: one page per original source, stored under `wiki/sources/` by mirroring its logical `raw/` path.
- **Map**: associative trail or topic map under `wiki/maps/` that links sources, entities, concepts, answers, and open questions.
- **Answer**: fed-back query answer (`wiki/answers/`).
- **Comparison/Analysis**: synthesis page comparing or analyzing two or more targets.
- **Code**: project, module, API, CLI, route, schema, test, or runbook pages under `wiki/code/`.
- **Architecture**: system/component structure and decisions, especially Code Wiki architecture pages.
- **Index/Log**: special navigation and operation-history pages such as `wiki/index.md`, `wiki/sources/index.md`, `wiki/maps/index.md`, and `wiki/log.md`.

### 4.2 Required YAML Frontmatter

```yaml
---
title: <page title>
type: entity | concept | source | answer | comparison | analysis | code | architecture | map | index | log
tags: [tag1, tag2]
sources: [wiki/sources/<raw-relative-path>.md, ...]
updated: YYYY-MM-DD
source_date: YYYY-MM-DD | YYYY-MM        # optional, source pages only
---
```

Source pages should be stored under `wiki/sources/` by mirroring the logical
`raw/` path. Examples: `raw/articles/foo.md` ->
`wiki/sources/articles/foo.md`, `raw/books/bar/ch1.pdf` ->
`wiki/sources/books/bar/ch1.md`, and a directory-level source summary may use
`wiki/sources/<raw-relative-dir>/index.md`. Dates are metadata, not directory
taxonomy: preserve them in `source_date`, `ingested_at`, `updated`, and the
generated source catalog.

For source pages, add source-specific frontmatter when knowable:

```yaml
source_kind: article | paper | book | note | web_capture | chat_capture | code | log | dataset | image | other
raw_path: raw/<logical-source-path>
language: ko | en | other
topics: [topic-a, topic-b]
entities: [Entity Name]
concepts: [Concept Name]
projects: [project-name]        # code sources only, when relevant
claims: [short claim summary]   # important factual assertions, not every detail
status: summarized | partial | needs_review
```

Use these facets for retrieval and cataloging. Do not move source pages into
date or topic folders just because a source is old or belongs to a topic; one
source can belong to many topics, entities, concepts, and maps while keeping
its raw-mirrored provenance path stable.

### 4.3 Source Catalog and Maps

- `wiki/sources/index.md` is a generated catalog over source page metadata.
  Keep it compact and organized by useful facets such as topic, entity,
  source_kind, source_date, raw_path prefix, status, and recently updated
  sources. It complements `wiki/index.md`; it does not replace it.
- `wiki/maps/<topic>.md` pages are optional associative trails for ongoing
  research threads. Use them when a set of sources, concepts, entities, answers,
  contradictions, and open questions should be navigable together.
- Source pages are evidence cards. Entity, concept, comparison, answer, code,
  and map pages are the synthesized knowledge layer.

### 4.4 Writing Rules
- Use **wikilinks** `[[Page Name]]` or relative Markdown links for all internal links.
- Use external URLs only when the user provided them or they exist in `raw/`. **Do not guess URLs.**
- When citing, put the source on the same line or in a footnote. Example: `... according to the source ([[wiki/sources/articles/foo]]).`
- If a contradiction is found, add a block quote to the affected page:
  ```markdown
  > ⚠️ Conflicts with [[wiki/sources/articles/bar]]: this source claims X. Follow-up review needed.
  ```
- Instead of deleting a page, move it to `wiki/archive/<original-path>` and leave a one-line reason.

## 5. Index and Log Rules

### 5.1 `wiki/index.md`
- Category catalog. Each item is one line: `- [[Page Name]] — One-line summary`.
- Categories: `Entities`, `Concepts`, `Code`, `Sources`, `Maps`, `Answers`, `Comparisons`, `Lint Reports`.
- At the final step of each ingest/query/lint merge pass, sort and deduplicate the index in bulk.

### 5.2 `wiki/log.md`
- Format, with a one-line heading and optional body:
  ```markdown
  ## [YYYY-MM-DD HH:MM] ingest | <source title or folder name>
  - Changed files: `wiki/sources/articles/foo.md`, `wiki/concepts/bar.md`
  - Notes: N chunks, merge pass complete
  - Checklist: [x] source pages · [x] log appended · [x] state persisted · [-] graph (separate)
  ```
- Operation types: `ingest`, `query`, `lint`, `graph`.
- **Completion Checklist**: each operation skill (`wiki-ingest`, `wiki-graphify`,
  `wiki-query`, `wiki-lint`, `wiki-preprocess`) carries an authoritative
  file-based **Completion Checklist** in its `SKILL.md`. Before reporting a run
  complete, the agent verifies every item and records the result as the
  `- Checklist:` line above, using `[x]` done, `[ ]` + short reason when blocked,
  or `[-]` when not applicable. Do not claim a run finished while a required
  `[ ]` remains. Appendix A is a human-readable summary of these checklists.
- **Append-only**. Do not edit old entries; append a new entry to correct or supplement them.

## 6. Skill Routing

| User input pattern | Skill to call |
|---|---|
| `/preprocess [path] [description]`, `/preprocess --apply`, "clean up ads / empty files in raw" | [`wiki-preprocess`](.agents/skills/wiki-preprocess/SKILL.md) |
| `/ingest <path|url>`, "summarize this material", `+ -> ingest` | [`wiki-ingest`](.agents/skills/wiki-ingest/SKILL.md) |
| `/ingest <raw code path>`, `/ingest-loop <raw code path>`, "code wiki", "document this codebase", "analyze this repo/code" | [`wiki-ingest`](.agents/skills/wiki-ingest/SKILL.md), which auto-detects code leaves and writes source summaries/progress |
| `/query <question>`, general questions | [`wiki-query`](.agents/skills/wiki-query/SKILL.md) |
| `/lint`, "check the wiki" | [`wiki-lint`](.agents/skills/wiki-lint/SKILL.md) |
| "capture this website", "open this page and save evidence", "test the web UI in browser" | [`browser-capture`](.agents/skills/browser-capture/SKILL.md) |
| "add/update/audit a skill", "improve CLIO skills" | [`skill-maintenance`](.agents/skills/skill-maintenance/SKILL.md) |
| qmd installed (default setup) | [`wiki-search-qmd`](.agents/skills/wiki-search-qmd/SKILL.md) |
| Optional marp installed | [`wiki-marp`](.agents/skills/wiki-marp/SKILL.md) |
| image/scan/screenshot or multimodal PDF under `raw/` (inside `/ingest`) | [`wiki-images`](.agents/skills/wiki-images/SKILL.md) |

**Priority**: `.agents/skills/` (project-local) > global skills. qmd is installed by default under `tools/qmd/` when possible and falls back to a global `qmd` from `PATH`.

## 7. Shared Operation Principle - Leaf-First + Merge (Required)

This applies to ingest, Code Wiki ingest, and preprocess planning. Never start by throwing the whole root into one operation.

1. **Find leaf directories and direct-file pseudo-leaves**: in the target tree (`raw/`, `wiki/`), find directories with no child directories. Also treat direct files in a non-leaf directory as a pseudo-leaf so parent-level files are included; this is mandatory for Code Wiki ingest because source files, manifests, routes, and configs often live in parent directories alongside child directories. For `raw/`, follow symlinked files/directories that are themselves located under `raw/`, keep their logical `raw/...` paths in state and citations, and track visited real paths/inodes to avoid symlink loops.
2. **Process by chunk**: group only the files in each leaf and process them once.
3. **Preserve partial outputs**:
   - ingest: immediately save chunk-level summaries/entity pages.
4. **Merge pass as a separate step**:
   - ingest: update parent-level pages -> root synthesis page -> refresh `wiki/sources/index.md` and useful `wiki/maps/` pages -> reorder `index.md`.
5. **Persist state**:
   - ingest: record chunk checklists in `sessions/<date>/<time>_ingest.md`.
6. **Resumability**: if interrupted, continue from unfinished chunks next time. Skip already completed chunks.
7. **Chunk limits**: file count and byte limits per chunk follow `config/default.json`. Tune them to the host CLI context limit.

## 8. Graph Integration

- Graph creation, update, and query operations must go through the [`wiki-graphify`](.agents/skills/wiki-graphify/SKILL.md) skill.
- `wiki-graphify` builds an Obsidian-like page graph first: each Markdown page's
  title/path is one stable node. Prose pages are connected by two edge classes
  only — explicit links (`[[wikilink]]`, Markdown links, frontmatter `sources`,
  `raw_path`) and high-confidence semantic relatedness (`related_to`) above the
  configured threshold. Frontmatter facets stay as node metadata and are **not**
  auto-converted to edges. graphify extraction is a bounded enrichment layer.
- The default profile is a compact page-title topology graph: one node per page,
  explicit + thresholded-semantic edges only, not one node per heading,
  paragraph, rationale snippet, helper function, or incidental noun, and not a
  dense facet mesh.
- Code Wiki pages under `wiki/code/` are graph inputs like any other wiki
  Markdown page. `wiki-graphify` must not read or graphify `raw/` source trees,
  and must not generate per-project graphify-out under `wiki/graph/projects/`.
- The web app Graph tab does not execute graphify directly. It sends `wiki-graphify build/update` requests to the coding agent CLI selected in Settings, and the coding agent follows this repository's rules and skills to run graphify, chunk processing, and the merge pass.
- Wiki pages must not call the `graphify` binary directly. The coding agent running `wiki-graphify` chooses the execution path: global `graphify`, or `python3 -m graphify` when needed.
- `wiki-query` may optionally use graph context from `wiki/graph/GRAPH_REPORT.md`, node adjacency, or `wiki-graphify query` as an auxiliary candidate/context source; it must still ground final answers in wiki/source pages.
- At the end of an ingest merge pass, calling `wiki-graphify update` is recommended, depending on user settings. Ingest-time scoped `update` is adaptive: `graph.autoUpdateStrategy=auto` should refresh completed leaf partials and merge the full parts set only when leaf/file/byte/sub-chunk thresholds indicate a large workload, while small ingests rely on the final `update`.
- If `/lint --fix` reorganizes existing dated source pages into raw-mirrored
  source paths, update affected wiki references and then run `wiki-graphify
  update` as a separate graph operation when `wiki/graph/graph.json` exists.

## 9. Hard Rules

- Do **not** modify, delete, or move files under `raw/`, **except** through `/preprocess` (`wiki-preprocess` skill), which may:
  - move whole files into `raw/.trash/<ISO-ts>_<basename>`, and
  - rewrite a file in place after backing the original up to `raw/.trash/`.
  The only other allowed `raw/` mutation is creating a new, user-approved Chat external-capture file under `raw/chat/<YYYY-MM-DD>/...`; never rewrite or delete existing `raw/chat/` captures. All other paths and operations on `raw/` remain forbidden.
- User-approved symlinks located under `raw/` are valid source entries. Following such links read-only during ingest/query is not considered a workspace escape, even when the real target is outside the repository. Do not mutate the real target, do not cite the real target path as the source path, and reject broken links or symlink loops with a clear warning.
- Do **not** arbitrarily delete files under `wiki/`. Retire pages by moving them to `wiki/archive/` and recording the reason.
- Do **not** invent external URLs. If there is no source, mark it as "source unknown" and record it in the operation log.
- Do **not** manually edit `sessions/`, `config/local.json`, or `.env*`.
- Do not leave credentials, API keys, or personal data in plaintext in wiki pages. If found, mask them and report them under `wiki/lint/`.
- Do not try to ingest all of `raw/` in one pass. Always follow the chunk policy in Section 7.
- During Code Wiki operations, do not modify source repositories under `raw/`; treat them as evidence. Any actual code changes belong to a separate coding task outside `/ingest`.

## 10. Host Coding Agent CLI

This repository is operated through one of the coding agent CLIs installed on the host PC.

| CLI | Invocation shape | Non-interactive/yolo flag |
|---|---|---|
| `codex` | `codex exec "<prompt>"` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude -p "<prompt>"` | `--dangerously-skip-permissions` |
| `agy` (Antigravity) | `agy --prompt "<prompt>"` | `--dangerously-skip-permissions` (`--add-dir` helper) |
| `cline` | `cline -y "<prompt>"` | `-y` (auto-approval) |
| `gemini` | `gemini "<prompt>"` | `--non-interactive` or `--skip-approval` |

- Any agent entering this repository treats these operating rules as the primary local rules.
- yolo mode must apply **only inside this repository**. The adapter forces `cwd`, so behavior that leaks outside the wiki path must be rejected, except for read-only traversal of user-approved source symlinks that are located under `raw/` and are being processed through `raw/...` paths.

## 11. Writing Language

- Unless the user specifies otherwise, wiki pages, logs, and answers should prefer **Korean**. Identifiers such as filenames, tags, frontmatter keys, commands, URLs, and code stay in English.
- If the original source is English, provide a Korean summary together with short key quotes in the original English when useful.

## 12. Override Order

1. Direct instructions from the user in the current session.
2. This `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` file.
3. Each skill's `SKILL.md` body, within that skill's scope.
4. External/global rules such as `~/.codex` or `~/.claude/CLAUDE.md`.
5. System defaults.

If this file is updated, synchronize the counterpart files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) as well.

---

## Appendix A - Quick Checklist

These are human-readable summaries. The **authoritative, agent-operated**
checklists live in each operation skill's `## Completion Checklist` section
(`wiki-ingest`, `wiki-graphify`, `wiki-query`, `wiki-lint`, `wiki-preprocess`);
the agent verifies those and records a `- Checklist:` line in the `wiki/log.md`
entry for the run (see §5.2).

Mental checklist for one ingest run:

- [ ] Did you list leaf directories and direct-file pseudo-leaves from the input tree?
- [ ] Is the chunk within the file-count and byte limits?
- [ ] Did you write `wiki/sources/<raw-relative-path>.md` for each chunk?
- [ ] Did you append one line to `wiki/log.md` for each chunk?
- [ ] Did you organize parent pages, `wiki/sources/index.md`, useful `wiki/maps/` pages, and `wiki/index.md` in the merge pass?
- [ ] Did you record progress in the session Markdown?

Mental checklist for one Code Wiki run:

- [ ] Did you process only code-looking leaves under `raw/` or the requested target?
- [ ] Did you include direct source files in non-leaf directories as their own pseudo-leaf chunks?
- [ ] Did you skip generated/vendor/build directories unless requested?
- [ ] Did you write one compact `wiki/sources/<raw-relative-path>.md` source card per code file and record those pages in progress state?
- [ ] Did you avoid file-by-file `wiki/code/` pages and long pasted source documentation?
- [ ] Did you update `wiki/index.md` under the `Code` category?
- [ ] Did you update `wiki/sources/index.md` and any relevant `wiki/maps/` trails?
- [ ] Did you append a `wiki/log.md` entry without editing old entries?
