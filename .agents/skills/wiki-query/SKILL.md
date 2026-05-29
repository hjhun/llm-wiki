---
name: wiki-query
description: Search the wiki (wiki/) first, optionally use qmd and graphify as auxiliary candidate/context tools, answer with citations, and with user consent feed the answer back into wiki/answers/. Responds to /query slash commands and natural-language questions.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-query

## LLM Wiki Pattern Reference

This skill follows the repository-root [`llm-wiki.md`](../../../llm-wiki.md)
query pattern: answer from the persistent wiki first, use `wiki/index.md` as the
primary catalog, consult raw sources only when the wiki is insufficient, and
offer to feed valuable answers back into `wiki/answers/` so exploration
compounds into the knowledge base.

## Purpose

Answer the user's question in this order.

1. Narrow candidate pages from `wiki/index.md`, including the `Code` category
   when the question mentions code, functions, files, APIs, dependencies,
   tests, errors, modules, or implementation details.
2. When the question asks about sources, evidence, provenance, a topic's reading trail, or "where did this come from?", read `wiki/sources/index.md` and relevant `wiki/maps/**` pages as additional candidate catalogs.
3. Optionally use helper tools to improve candidate selection: `wiki-search-qmd` for search/reranking, and `wiki-graphify` for graph relationships, communities, and 1-hop neighbor clues.
4. Read candidate pages and write an answer **with citations**.
5. If the wiki is insufficient, use `raw/` original sources as supplementary context. **Only cite external URLs that the user provided or that already exist in the wiki/source material**; do not guess.
6. With user consent, feed the answer back into `wiki/answers/<slug>.md`.

## Triggers

- `/query <question>` — chat slash command.
- General questions without a slash, which are the default behavior in the Chat page.
- UI: `+` menu -> query.
- Explorer button while viewing a page: "Ask based on this page".

## Input

- One natural-language question, with optional attachments such as images.
- Inline option flags in the chat body:
  - `--scope=wiki|wiki+raw|wiki+graph` (default: use `wiki+graph` automatically when graph exists; otherwise `wiki`; graph context is auxiliary).
  - `--format=md|table|marp|chart` (default: `md`; use non-`md` formats only when the user explicitly requests them; `marp` only when `wiki-marp` is active).
  - `--save` explicitly enables answer feedback. If omitted, ask with a toggle at the end.

## Output

- Chat answer in Markdown. Cited pages are shown as wikilinks. Code answers
  include source locations and Explorer links when available.
- With user consent: create `wiki/answers/<slug>.md` and update `wiki/index.md` and `wiki/log.md`.

## Preflight

1. Confirm that `wiki/index.md` exists and is not empty. If empty, explain that the user should run `/ingest` first, then stop.
2. Check whether `wiki/graph/graph.json` exists; if so, graph context can be used as an auxiliary candidate/context source.
3. Check whether `wiki-search-qmd` is active: `tools/qmd` or host `qmd` binary plus explicit enabled setting. If active, use it as an auxiliary candidate source.

## Workflow

### Step 1 - Narrow Candidate Pages
1. Read all of `wiki/index.md`.
2. Select candidate pages based on question keywords/entities/concepts.
   - For code questions, include `wiki/code/**` pages from the `Code` category,
     especially `overview.md`, `locations.md`, `diagrams.md`, module/API pages,
     `architecture.md`, `testing.md`, and `debug-notes.md`.
   - Treat words like "함수", "클래스", "라인", "파일", "API", "route",
     "dependency", "의존성", "구조", "call flow", "stack trace", and
     "어디" as code-candidate signals.
3. If the question needs evidence discovery, source audit, provenance, reading history, or broad topic exploration, read `wiki/sources/index.md` when it exists and use its facets (`topics`, `entities`, `source_kind`, `source_date`, `raw_path`, `status`) to pick source-summary candidates.
4. If relevant `wiki/maps/**` pages exist, read the best matching maps as associative trails. Treat maps as navigation and synthesis, then follow their links to source/entity/concept pages before making factual claims.
5. If `wiki-search-qmd` is active, delegate the same question and receive additional candidates via BM25 + vector + reranking.
6. If graph context is active, inspect `wiki/graph/graph.json` and `wiki/graph/GRAPH_REPORT.md` or ask `wiki-graphify query "<question>"` for related nodes, 1-hop neighbors, communities, and cited pages. Treat these as candidate/context clues, not final evidence.
7. If there are too many candidates (>20), filter by the one-line summaries in the index, source catalog facets, qmd scores when present, and graph relationship clues when present; keep the top 10.

### Step 2 - Read Pages
1. Read candidate pages. Use frontmatter `sources:` to drill down one level into original summary pages.
2. Follow wikilinks `[[...]]` to adjacent pages one hop further. Use two or more hops only when the question clearly requires it.
3. If graph context is active, add relationship clues from `wiki/graph/GRAPH_REPORT.md` or `wiki-graphify query`, such as hub nodes, 1-hop neighbors, and communities.
4. For code questions, prefer `wiki/code/<project>/locations.md` and module/API
   pages before opening raw files. If a requested symbol is not indexed, use
   `rg` against the relevant logical `raw/...` tree and read only the matching
   spans.
5. If information is insufficient, read original files in `raw/`. **`raw/` is read-only.**

### Step 3 - Write the Answer
1. Select answer format:
   - If the user explicitly requests a format with `--format=table|marp|chart` or natural language ("표로", "슬라이드로", "차트로", "as a table", "as slides", "as a chart"), use that format.
   - Otherwise, answer in Markdown (`--format=md`) with headings, paragraphs, bullets, and citations as appropriate.
2. Cite every factual claim. Formats:
   - Wikilink: `... ([[wiki/sources/articles/foo]])`.
   - Original source: `... (raw/articles/foo/bar.md L42-58)`.
   - Code location: `` `raw/repos/foo/src/server.ts:L42-L88` `` plus an
     Explorer link: `[open](/explorer?ws=raw&path=repos/foo/src/server.ts&line=42)`.
   - Graph: `... (graph: community #3, node "Karpathy")`.
3. For code answers, include a compact **Related Code** table when useful:
   ```markdown
   | Symbol/File | Role | Location | Open |
   |---|---|---|---|
   | `runIngestLoop` | ingest-loop driver | `raw/repos/foo/webapp/lib/ingest-loop.ts:L940-L1094` | [open](/explorer?ws=raw&path=repos/foo/webapp/lib/ingest-loop.ts&line=940) |
   ```
   The path after `ws=raw&path=` omits the `raw/` prefix because Explorer
   already selects the `raw` workspace. Add `&line=<start>` so Explorer
   scrolls/highlights the starting line, and keep the full span in the Location
   column.
4. If the user asks for dependency or structure visualization and a relevant
   `wiki/code/<project>/diagrams.md` exists, cite and link it. If no diagram
   exists but enough Code Wiki evidence exists, include a small Mermaid block in
   the answer and recommend re-running `/ingest raw/<project>` to persist it.
5. If a source is not in the wiki, explicitly say "source unknown" or withhold the answer.
6. Always append these two lines at the end:
   - **Cited pages**: `[[wiki/sources/articles/foo]], [[wiki/concepts/bar]]` ...
   - **Save**: `[ ] wiki/answers/<suggested-slug>.md` toggle, which feeds the answer back when the user clicks it.

### Step 4 - Feedback into the Wiki (User Consent or `--save`)
1. Create `wiki/answers/<slug>.md` with frontmatter:
   ```yaml
   ---
   title: <question or key conclusion>
   type: answer
   tags: [<topic>, ...]
   sources: [<wiki/original paths used in the answer>]
   question: <original question>
   asked_at: YYYY-MM-DD HH:MM
   updated: YYYY-MM-DD
   ---
   ```
   The body is the same answer sent in chat, except remove the response toggle line.
2. Add one line to the `Answers` category in `wiki/index.md`.
3. Append a query entry to `wiki/log.md`.
   ```markdown
   ## [YYYY-MM-DD HH:MM] query | <question summary>
   - Feedback: `wiki/answers/<slug>.md`
   - Citations: `wiki/sources/articles/foo.md`, `wiki/concepts/bar.md`
   ```
4. Show a "Saved. Open in Explorer?" link card to the user.

## Prohibited

- Do not invent facts that are not in the wiki or source material. Mark speculation explicitly as `Speculation: ...`.
- Do not modify `raw/`.
- Do not copy credentials, API keys, or personal data verbatim into answers.
- Do not answer from qmd or graphify output alone. Helper-tool output only helps select and contextualize pages; factual claims must be grounded in wiki pages, source summaries, or read-only raw sources, with graph citations used only as supplemental relationship evidence.
- Do not read the entire wiki in one query. The standard flow is index -> candidates -> one-hop expansion.
- Do not treat code locations as proof unless they came from Code Wiki pages,
  source summaries, or a targeted read/search of `raw/`.

## Minimal Scenario: Single Question

User:
> `Why is the merge pass necessary in the LLM Wiki pattern?`

Skill behavior:
1. Select candidates from `wiki/index.md`, such as `llm-wiki-pattern`, `leaf-first-merge` (hypothetical), and `wiki-ingest`.
2. If qmd or graph context is active, use it to refine or expand the candidate list.
3. Read candidate pages and find the chunk-limit/context-protection rationale.
4. Write a 3-4 paragraph Markdown answer with two citations and concise bullets.
5. Add a save toggle at the end: `wiki/answers/why-merge-pass.md` [ ].
6. If the user clicks the toggle, feed the answer back and update `index.md` and `log.md`.

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — if new material arrived, ingest it before querying.
- [wiki-lint](../wiki-lint/SKILL.md) — check contradictions after answers accumulate.
- [wiki-graphify](../wiki-graphify/SKILL.md) — optional graph relationship helper, similar to qmd as an auxiliary retrieval/context tool.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md).
