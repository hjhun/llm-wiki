---
name: wiki-query
description: Search the wiki (wiki/) first, answer with citations, and with user consent feed the answer back into wiki/answers/. Responds to /query slash commands and natural-language questions.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-query

## Purpose

Answer the user's question in this order.

1. Narrow candidate pages from `wiki/index.md`.
2. Read candidate pages and write an answer **with citations**.
3. If the wiki is insufficient, use `raw/` original sources as supplementary context. **Only cite external URLs that the user provided or that already exist in the wiki/source material**; do not guess.
4. With user consent, feed the answer back into `wiki/answers/<slug>.md`.

## Triggers

- `/query <question>` — chat slash command.
- General questions without a slash, which are the default behavior in the Chat page.
- UI: `+` menu -> query.
- Explorer button while viewing a page: "Ask based on this page".

## Input

- One natural-language question, with optional attachments such as images.
- Inline option flags in the chat body:
  - `--scope=wiki|wiki+raw|wiki+graph` (default: use `wiki+graph` automatically when graph exists; otherwise `wiki`).
  - `--format=md|table|marp|chart` (default: `md`; `marp` only when `wiki-marp` is active).
  - `--save` explicitly enables answer feedback. If omitted, ask with a toggle at the end.

## Output

- Chat answer in Markdown. Cited pages are shown as wikilinks.
- With user consent: create `wiki/answers/<slug>.md` and update `wiki/index.md` and `wiki/log.md`.

## Preflight

1. Confirm that `wiki/index.md` exists and is not empty. If empty, explain that the user should run `/ingest` first, then stop.
2. Check whether `wiki/graph/graph.json` exists; if so, graph context can be used as an option.
3. Check whether `wiki-search-qmd` is active: `tools/qmd` or host `qmd` binary plus explicit enabled setting. If active, delegate the four-step search.

## Workflow

### Step 1 - Narrow Candidate Pages
1. Read all of `wiki/index.md`.
2. Select candidate pages based on question keywords/entities/concepts.
3. If `wiki-search-qmd` is active, delegate the same question and receive additional candidates via BM25 + vector + reranking.
4. If there are too many candidates (>20), filter by the one-line summaries in the index and keep the top 10.

### Step 2 - Read Pages
1. Read candidate pages. Use frontmatter `sources:` to drill down one level into original summary pages.
2. Follow wikilinks `[[...]]` to adjacent pages one hop further. Use two or more hops only when the question clearly requires it.
3. If graph context is active, add clues from `wiki/graph/GRAPH_REPORT.md`, such as god nodes and communities.
4. If information is insufficient, read original files in `raw/`. **`raw/` is read-only.**

### Step 3 - Write the Answer
1. Auto-select answer format:
   - Comparison/contrast questions -> table (`--format=table`).
   - Presentation/sharing -> Marp slides (`--format=marp`, only when `wiki-marp` is active).
   - Numeric/time-series questions -> chart code block + explanation.
   - Otherwise, default Markdown.
2. Cite every factual claim. Formats:
   - Wikilink: `... ([[wiki/sources/foo]])`.
   - Original source: `... (raw/articles/foo/bar.md L42-58)`.
   - Graph: `... (graph: community #3, node "Karpathy")`.
3. If a source is not in the wiki, explicitly say "source unknown" or withhold the answer.
4. Always append these two lines at the end:
   - **Cited pages**: `[[wiki/sources/foo]], [[wiki/concepts/bar]]` ...
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
   - Citations: `wiki/sources/foo.md`, `wiki/concepts/bar.md`
   ```
4. Show a "Saved. Open in Explorer?" link card to the user.

## Prohibited

- Do not invent facts that are not in the wiki or source material. Mark speculation explicitly as `Speculation: ...`.
- Do not modify `raw/`.
- Do not copy credentials, API keys, or personal data verbatim into answers.
- Do not read the entire wiki in one query. The standard flow is index -> candidates -> one-hop expansion.

## Minimal Scenario: Single Question

User:
> `Why is the merge pass necessary in the LLM Wiki pattern?`

Skill behavior:
1. Select candidates from `wiki/index.md`, such as `llm-wiki-pattern`, `leaf-first-merge` (hypothetical), and `wiki-ingest`.
2. Read candidate pages and find the chunk-limit/context-protection rationale.
3. Write a 3-4 paragraph answer with two citations and a short table.
4. Add a save toggle at the end: `wiki/answers/why-merge-pass.md` [ ].
5. If the user clicks the toggle, feed the answer back and update `index.md` and `log.md`.

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — if new material arrived, ingest it before querying.
- [wiki-lint](../wiki-lint/SKILL.md) — check contradictions after answers accumulate.
- [wiki-graphify](../wiki-graphify/SKILL.md) — provides graph context.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md).
