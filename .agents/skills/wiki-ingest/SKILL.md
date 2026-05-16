---
name: wiki-ingest
description: Read new material in raw/ as leaf-directory chunks and incrementally build wiki/. Responds to the /ingest slash command, "summarize this material", and chat + -> ingest triggers.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-ingest

## Purpose

Read material newly dropped by the user into `raw/` and perform the following.

1. Write one `wiki/sources/<slug>.md` summary page per original source.
2. Create or update related entity/concept pages.
3. Keep `wiki/index.md` and `wiki/log.md` consistent.
4. Optionally call `wiki-graphify update` to synchronize the knowledge graph.

This skill **always follows the leaf-first + merge pass** principle. It never processes all of `raw/` as one giant batch.

## Triggers

- `/ingest <path|URL>` — chat slash command.
- `/ingest` with no argument — incremental ingest for all of `raw/`.
- Natural-language triggers: "summarize this material", "I added something new to raw", "ingest ...".
- UI: chat input `+` menu -> ingest.
- Explorer: after a file is added/updated under `raw/`, the banner trigger button for "The LLM recommends updating the wiki".

## Input

- Single file path, such as `raw/foo.pdf` or `raw/notes/bar.md`.
- Single URL, downloaded to `raw/<slug>.<ext>` before processing.
- Folder path, such as `raw/dir/`, including its subtree.
- If input is omitted, default to all of `raw/`.

## Output

- List of new/updated `wiki/**` Markdown files.
- Session Markdown with chunk progress log: `sessions/<date>/<time>_ingest.md`.
- Ingest entries appended to `wiki/log.md`.
- Optional updates under `wiki/graph/`.

## Preflight

1. Confirm that `wiki/index.md` and `wiki/log.md` exist. If missing, create Phase 1 templates first.
2. Validate that the input path is inside `raw/`. **Reject processing outside `raw/`.**
3. Read chunk limits from `config/default.json`: file count and byte count. Defaults when missing: 8 files, 256KB total.
4. If the host coding agent CLI is stateless, such as `claude -p`, re-inject the full system prompt on every call: CLAUDE.md/AGENTS.md + this SKILL.md + part of the active session Markdown.

## Workflow

### Step 0 - Start Session
- Create `sessions/<YYYY-MM-DD>/<HHMMSS>_ingest_<subject>.md`.
- Record in the header:
  - input path(s).
  - chunk limit settings.
  - host CLI name and version.
- Track every chunk in this file as a checklist. **If interrupted, resume from unfinished chunks in the next run.**

### Step 1 - Find Leaf Directories
- List directories in the input tree that have no child directories.
- A single file/URL is treated as one virtual chunk, with its parent directory considered the leaf.
- Record the result in the session Markdown as a checklist.
  ```markdown
  ## Chunk List
  - [ ] raw/articles/karpathy/
  - [ ] raw/articles/bush/
  - [ ] raw/notes/2026-05/
  ```

### Step 2 - Process Each Chunk Once

For each leaf, perform the following in order.

1. Read every file in the leaf. If the chunk exceeds limits, split that leaf into smaller file groups while still treating the work as internal to that leaf.
2. Extract key takeaways as bullet points.
3. **Create source summary pages**: one `wiki/sources/<slug>.md` per file. Required frontmatter:
   ```yaml
   ---
   title: <source title>
   type: source
   tags: [<topic>, ...]
   sources: [raw/<original path>]
   updated: YYYY-MM-DD
   ---
   ```
   Body structure: one-line gist -> key points as bullets -> quotes -> wiki connections (`[[Entity]]`, `[[Concept]]`) -> source path/URL.
4. **Update entity/concept pages**:
   - If the page already exists, integrate the new content. Mark changed lines with `<!-- updated YYYY-MM-DD source=wiki/sources/<slug> -->`.
   - If missing, create it with `type: entity` or `type: concept` frontmatter.
   - Every newly added fact must link back to the source page.
5. **Check contradictions**: if a new source conflicts with a claim in an existing page, insert a block quote on that page.
   ```markdown
   > ⚠️ Conflicts with [[wiki/sources/<slug>]]: this source claims X. Follow-up review needed.
   ```
6. **Chunk log**: append one heading plus changed files to `wiki/log.md`.
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | <leaf path>
   - Changed files: `wiki/sources/foo.md`, `wiki/entities/bar.md`
   - Notes: chunk 1/3
   ```
7. Mark the chunk checkbox `[x]` in the session Markdown.

### Step 3 - Merge Pass Once for the Full Operation

Run this exactly once after all chunks finish.

1. **Parent directory synthesis**: combine child-leaf summaries by parent directory and create/update parent topic pages, such as `wiki/concepts/<topic>.md`.
2. **Root synthesis page**: when useful, write a synthesis note for this ingest batch under `wiki/synthesis/<batch>.md`.
3. **Reorder the index**: rewrite `wiki/index.md` in bulk with these rules.
   - Category order: Entities -> Concepts -> Sources -> Answers -> Comparisons -> Lint Reports -> Graph.
   - Sort alphabetically within each category.
   - Item format: `- [[Page Name]] — One-line summary`.
4. **Merge log entry**: append a merge-pass completion entry to `wiki/log.md`.
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | merge pass
   - Integrated pages: `wiki/concepts/foo.md`
   - Index reorder complete
   ```
5. **Optional graph update**: if the user setting is "automatic after ingest", call `wiki-graphify update`. Otherwise, show only a "Update graph?" toggle at the end of the chat response.
6. Mark merge completion in the session Markdown, summarize the full changed-file list, and report it in chat.

## Error Handling / Resume

- If a chunk fails, mark that chunk in the session Markdown with `[!]` plus the error message. Continue other chunks.
- On the next run, if the same session Markdown is found, enter **resume mode**. Ask the user, "A previous ingest session is incomplete. Continue it?", then resume unfinished chunks based on the response.
- Do not run the merge pass automatically if any chunk remains failed. The user must explicitly request "force partial merge".

## Prohibited

- Do not modify, delete, or move files under `raw/`.
- Do not delete wiki pages. Retire them by moving to `wiki/archive/<original-path>` and leaving a one-line reason.
- Do not invent external URLs. If a source is ambiguous, mark it as "source unknown".
- Do not group files beyond the chunk limit in one call.

## Minimal Scenario: Single-File Ingest

User:
> `/ingest raw/articles/karpathy/llm-wiki.md`

Skill behavior:
1. Create session Markdown: `sessions/2026-05-16/213045_ingest_llm-wiki.md`.
2. Determine the leaf: `raw/articles/karpathy/`. One chunk.
3. Write source page: `wiki/sources/karpathy-llm-wiki.md` with frontmatter and summary.
4. Create concept pages: `wiki/concepts/llm-wiki-pattern.md`, `wiki/concepts/memex.md`.
5. Create entity pages: `wiki/entities/andrej-karpathy.md`, `wiki/entities/vannevar-bush.md`.
6. No contradictions.
7. Append one ingest entry to `wiki/log.md`.
8. Merge pass: if the parent directory `raw/articles/` has no other children, no extra synthesis is needed; only reorder `wiki/index.md`.
9. Chat response: six changed-file cards plus an "Update graph?" toggle.

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — searches the wiki and reuses answers fed back by ingest/query.
- [wiki-lint](../wiki-lint/SKILL.md) — periodic health check; catches accumulated contradictions after ingest.
- [wiki-graphify](../wiki-graphify/SKILL.md) — called at the end of the ingest merge pass.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md), `wiki-images`.
