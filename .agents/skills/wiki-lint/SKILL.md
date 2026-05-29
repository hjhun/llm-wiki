---
name: wiki-lint
description: Health-check the wiki. Find contradictions, orphan pages, broken wikilinks, missing metadata, and frequently mentioned concepts without pages; write wiki/lint/<date>.md and separate auto-fixable items from manual-review items. Triggered by /lint or scheduled runs.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-lint

## LLM Wiki Pattern Reference

This skill implements the health-check loop described by
[`llm-wiki.md`](../../../llm-wiki.md): as the LLM-maintained wiki compounds over
time, periodically detect contradictions, stale claims, orphan pages, missing
cross-references, and metadata drift so the persistent wiki remains coherent
instead of becoming another unmaintained note pile.

## Purpose

Periodically clean up decay that naturally accumulates as the wiki grows: contradictions, broken links, orphan pages, and missing metadata. This skill runs in four stages: **inspect -> classify -> apply some automatic fixes -> report**.

## Triggers

- `/lint` slash command.
- Natural language: "check the wiki", "run lint".
- Scheduled run, for example "every Sunday at 03:00" from Settings.
- Automatic suggestion after `wiki-ingest` merge pass when "N potential contradictions from this ingest" are detected.

## Input

- No arguments. The whole wiki is the default target.
- Optional flags:
  - `--fix` — immediately apply auto-fixable items.
  - `--scope=<glob>` — inspect only selected paths, for example `--scope=wiki/concepts/**`.
- `--since=<date>` — inspect only pages updated after that date.
- `--fix` also organizes existing source pages into raw-mirrored `wiki/sources/<raw-relative-path>.md` locations when `raw_path` or `sources: [raw/...]` metadata makes the target knowable.

## Output

- One report: `wiki/lint/<YYYY-MM-DD>.md`. If rerun on the same day, create a new file with `_2`, `_3`, and so on. Do not overwrite previous reports.
- Append a lint entry to `wiki/log.md`.
- When `--fix` is used, list automatically fixed pages.

## Preflight

1. Confirm that `wiki/index.md` and `wiki/log.md` exist.
2. Create `wiki/lint/` if missing.
3. If `wiki/graph/graph.json` exists, enable additional graph-based checks.

## Checks

Classify each item as "auto-fixable" or "manual review needed".

### A. Contradictions (Manual)
- Two pages make conflicting claims about the same fact.
- Detection: find conflicting predicates for the same subject across entity/concept page bodies.
- Output: check whether both pages already have `⚠️ Conflicts with [[...]]` blocks. If not, report them under "contradiction candidates".

### B. Stale Claims (Manual)
- A recently ingested source invalidates a claim in an older page.
- Detection: recent N-day ingest entries from `wiki/log.md` -> cross-check pages cited by that source against overlapping older pages.
- Output: list pages recommended for re-review.

### C. Orphan Pages (Auto Candidate / Partly Manual)
- A page has zero inbound wikilinks and non-empty frontmatter `sources:`.
- Auto-fix: add it to `wiki/index.md` if missing.
- Manual: if clearly irrelevant, ask the user to move it to `wiki/archive/`.

### D. Broken Wikilinks (Auto)
- A `[[...]]` link points to a page that does not exist.
- Auto-fix: if a nearby page exists by case/space typo, suggest a candidate. With user consent, replace in bulk.
- Manual: if the page is clearly missing, report it as a "new page candidate".

### E. Missing Frequently Mentioned Concepts (Manual)
- A noun phrase appears N or more times in bodies but has no page.
- Detection: body word frequency plus candidates not already wikilinked.
- Output: "new page candidates" section.

### F. Missing Metadata (Auto)
- A page lacks any of `title`, `type`, or `updated` in frontmatter.
- Auto-fix: fill from filename and last modification date, using git mtime or filesystem mtime.
- If `type` cannot be inferred, set it to `unknown` and report it as manual.

### G. Index Consistency (Auto)
- A page is missing from `wiki/index.md`.
- Auto-fix: infer category from `type`, add one line, and sort alphabetically.
  Category mapping:
  - `entity` -> `Entities`
  - `concept` -> `Concepts`
  - `code` or `architecture` -> `Code`
  - `source` -> `Sources`
  - `answer` -> `Answers`
  - `comparison` or `analysis` -> `Comparisons`
  - `lint` -> `Lint Reports`
  - graph reports -> `Graph`

### H. Graph Consistency (Manual, When Graph Is Active)
- A node exists in `wiki/graph/graph.json` without a matching wiki page, or vice versa.
- Output: "graph <-> wiki mismatch" section and recommend `wiki-graphify update`.

### I. Source Raw-Mirror Layout (Auto With `--fix`)
- Source pages under `wiki/sources/` should mirror the logical `raw/` path recorded in source page frontmatter. Example: `raw/articles/foo.pdf` -> `wiki/sources/articles/foo.md`.
- Detection: run `node scripts/organize-sources.mjs --json` and include the planned moves in the report.
- Date fields such as `source_date`, `ingested_at`, and `updated` are metadata only. They must not determine source-page directories.
- Auto-fix: only when `--fix` is present, run `node scripts/organize-sources.mjs --apply --json`, then include moved files and changed references in the lint report.
- Graph follow-up: if any source moved and `wiki/graph/graph.json` exists, run `wiki-graphify update` as a separate coding-agent invocation after the lint call completes.

### J. Security (Auto Mask + Manual Follow-Up)
- API key patterns (`sk-...`, `ghp_...`), email/phone numbers, or `.env` traces appear in bodies.
- Auto-fix: replace the string with `[REDACTED]` and add a `⚠️ Redacted by wiki-lint` comment to the page.
- Report: list locations found.

## Workflow

### Step 1 - Indexing
1. Walk the `wiki/` tree and extract frontmatter, body, and wikilinks from each page.
2. Build an in-memory wikilink graph: `page -> [page, ...]`.
3. Parse recent 30-day entries from `wiki/log.md`.

### Step 2 - Inspect
- Run checks A-J in order.
- Treat Source Raw-Mirror Layout as auto-fixable only when `--fix` is present; otherwise report the dry-run move plan.
- Collect findings as `{category, severity, page, evidence, suggested_fix, auto: true|false}` records.

### Step 3 - Automatic Fixes (`--fix`)
- Apply only items with `auto: true`.
- For each changed page, update that page's frontmatter `updated` value to today's date.
- For source raw-mirror moves, call `node scripts/organize-sources.mjs --apply --json` and use its `moves` and `changedReferences` as the authoritative changed-file list.
- Security items (J) are always masked even without `--fix`, prioritizing safety.

### Step 4 - Write the Report
- Write `wiki/lint/<YYYY-MM-DD>.md` with this structure.
  ```markdown
  ---
  title: Lint Report YYYY-MM-DD
  type: lint
  updated: YYYY-MM-DD
  ---

  # Summary
  - Pages inspected: N
  - Findings: contradictions a, stale claims b, orphans c, broken links d, ...
  - Auto-fixed: e
  - Manual review needed: f

  # Auto-Fixed
  - [page](path) — one-line description of what was fixed

  # Manual Review Needed
  ## Contradiction Candidates
  - [pageA](pathA) <-> [pageB](pathB) — one-line description
  ## Stale Claims
  ...
  ## New Page Candidates
  - "term" — mentioned N times, candidate slug: `wiki/concepts/<slug>.md`
  ## Graph <-> Wiki Mismatch
  ...
  ## Source Raw-Mirror Layout
  - `wiki/sources/2026/2026-05/foo.md` -> `wiki/sources/articles/foo.md` — reason
  - Graph follow-up: `wiki-graphify update` recommended|required|not needed

  # Security
  - [page](path) L42 — API key pattern, REDACTED
  ```
- Append an entry to `wiki/log.md`.
- Add one line to the `Lint Reports` section of `wiki/index.md`.

### Step 5 - Chat Report
- Show cards in chat:
  - inspected page count, auto-fix count, manual-review count.
  - report link.
  - if there is at least one manual item, a "Review now" button that opens the report in Explorer.

## Prohibited

- Do not arbitrarily **delete** wiki pages. For orphan pages, only recommend that the user move them to archive.
- Do not touch `raw/`.
- Do not overwrite previous reports. Always create a new file to preserve history.
- Do not undo security masking. If unmasking is needed, the user must edit manually.

## Minimal Scenario

User:
> `/lint --fix`

Skill behavior:
1. Index 92 wiki pages.
2. Detect:
   - 3 broken wikilinks; 1 typo can be auto-replaced (`[[memexx]] -> [[memex]]`).
   - 2 pages missing from index; auto-add.
   - 5 pages missing metadata; auto-fill `updated`.
   - 1 contradiction candidate; manual.
   - Frequently mentioned concept "leaf-first" appears 4 times; report as manual candidate.
3. Write `wiki/lint/2026-05-16.md`.
4. Append one line to `wiki/log.md`.
5. Chat card: "8 automatic fixes, 2 manual items. View report ->".

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — potential contradiction notifications can trigger after ingest.
- [wiki-query](../wiki-query/SKILL.md) — combines with answer feedback when creating new page candidates.
- [wiki-graphify](../wiki-graphify/SKILL.md) — follow-up action for graph consistency check H.
