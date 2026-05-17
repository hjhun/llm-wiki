---
name: wiki-ingest
description: Read new material in raw/ as leaf-directory chunks and incrementally build wiki/. Responds to the /ingest slash command, "summarize this material", and chat + -> ingest triggers.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-ingest

## Purpose

Read material newly dropped by the user into `raw/` and perform the following.

1. Write one `wiki/sources/<YYYY>/<YYYY-MM>/<slug>.md` summary page per original source.
2. Create or update related entity/concept pages.
3. Keep `wiki/index.md` and `wiki/log.md` consistent.
4. Optionally call `wiki-graphify update` to synchronize the knowledge graph.

This skill **always follows the leaf-first + merge pass** principle, and is built
to survive interruption (OOM, SIGTERM, manual cancel) because progress is
externalized to `wiki/.progress/ingest/`.

## Triggers

- `/ingest <path|URL>` — chat slash command. Processes **exactly one
  sub-chunk** and exits, per the `unitPerCall: "one_subchunk"` contract. The
  user (or the webapp) re-invokes `/ingest` to advance.
- `/ingest-loop <path|URL>` — same skill body, but driven by the webapp's
  backend loop in `/api/chat/send` (`kind="ingest-loop"`). The backend keeps
  spawning a fresh CLI invocation per sub-chunk until
  `wiki/.progress/ingest/.state.json` reports no remaining `pending`,
  `in_progress`, or `partial` sub-chunks and `merge_pass.status === "done"`,
  or until the user clicks "Stop loop" (which drops
  `wiki/.progress/ingest/.stop`). Each iteration must still process exactly
  one sub-chunk and exit — the skill never loops itself.
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
- Session Markdown with chat log: `sessions/<date>/<time>_ingest.md` (conversation only).
- Externalized progress: `wiki/.progress/ingest/.state.json` + `wiki/.progress/ingest/leaves/<hash>.json` + human-readable `wiki/.progress/ingest/DASHBOARD.md`.
- Ingest entries appended to `wiki/log.md`.
- Optional updates under `wiki/graph/`.

## Memory Safety: Why Progress Lives Outside The Session

Large `raw/` trees previously caused coding-agent CLIs to be killed by OOM. Two
patterns made that worse:

- The session markdown grew with each turn and was re-injected into every
  stateless CLI invocation, so prompt size scaled with N turns.
- One LLM call attempted to load an entire leaf (many files) at once, which
  blew up working-set memory.

The mitigation is structural, not a bigger machine. **One LLM invocation = one
sub-chunk.** All resume information lives in `wiki/.progress/ingest/`, so the
next invocation reads the state file (small) instead of replaying the whole
conversation. The host webapp also slims the prompt to the last N turns
(`chat.contextTurns`) and appends a one-line reference to the dashboard.

## Preflight

1. Confirm that `wiki/index.md` and `wiki/log.md` exist. If missing, create Phase 1 templates first.
2. Validate that the input path is inside `raw/`. **Reject processing outside `raw/`.**
3. Read knobs from `config/default.json` (merged with `config/local.json`):
   - `chunking.maxFiles`, `chunking.maxBytes` — soft cap per chunk.
   - `chunking.maxFilesPerInvocation` — **hard cap per LLM call**. Defaults to 4.
   - `chunking.maxBytesPerFile` — files above this read head + tail only.
   - `chunking.unitPerCall` — defaults to `"one_subchunk"`. Honor this strictly.
4. If the host coding-agent CLI is stateless (`claude -p`, `codex exec`, …), the
   host already slim-injects: a short dashboard reference + last N turns. Do
   **not** ask for the whole session markdown back.

## Workflow

### Step 0 — Start Session and Acquire Lock

1. Create the chat log session file `sessions/<YYYY-MM-DD>/<HHMMSS>_ingest_<subject>.md` (frontmatter only). This file holds the conversation, not progress.
2. Ensure `wiki/.progress/ingest/` exists. Create `leaves/`, `tmp/` subfolders if missing.
3. Attempt to acquire `wiki/.progress/ingest/.lock`:
   - File contents: `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>"}`.
   - Write via `tmp/<rand>.lock` then rename — atomic on POSIX.
   - If `.lock` already exists and `pid` is alive, **abort** with a chat message: "Another `/ingest` is in progress (pid=…, session=…). Wait for it to finish or remove the lock manually." Do not proceed.
4. Read `wiki/.progress/ingest/.state.json` if it exists. If `version` mismatches the current SKILL version, run the migration in §State Migration before proceeding.

### Step 1 — Enumerate Leaves (idempotent)

1. From the requested input root (default `raw/`), list every leaf directory (no child directories). A single file or URL counts as a virtual leaf whose path is its parent directory.
2. For each leaf compute a stable identity:
   - `leafPath` = POSIX-style relative path (always ends with `/`).
   - `hash` = sha1 of `JSON.stringify(sortedFileList.map(f => [f.path, f.size, f.mtimeMs]))`.
3. Update `wiki/.progress/ingest/.state.json`:
   - New leaves are added with `status: "pending"`, an empty `sub_chunks` list, and `attempts: 0`.
   - Existing leaves whose `hash` changed have their status reset to `"pending"` and their `sub_chunks` cleared. (Re-ingest is intentional when content changed.)
   - Leaves that no longer exist on disk get `status: "stale"`; do not delete them — the user may have moved files temporarily.
4. Plan sub-chunks for each `pending` leaf. A sub-chunk groups up to `chunking.maxFilesPerInvocation` files and stays under `chunking.maxBytes` total. Persist the sub-chunk plan into `.state.json` before any file is opened.

### Step 2 — Process **One** Sub-Chunk Per Invocation (the hard rule)

For exactly **one** sub-chunk whose `status === "pending"`:

1. Mark the sub-chunk `status: "in_progress"`, set `started_at`, increment `leaves[<leafPath>].attempts`. Persist immediately.
2. Open files **one at a time**, in the order recorded in the sub-chunk:
   - If the file is larger than `chunking.maxBytesPerFile`, read only `head (N/2)` + a marker + `tail (N/2)` bytes. Record `truncated: true` in the per-leaf JSON.
   - Write `wiki/sources/<YYYY>/<YYYY-MM>/<slug>.md` for that file with the required frontmatter (`title`, `type: source`, `tags`, `sources: [raw/...]`, `updated`) and optional source-page field `source_date: YYYY-MM-DD | YYYY-MM`.
   - Choose `<YYYY>/<YYYY-MM>` by this priority: explicit `source_date` or source text date -> raw path/metadata date -> raw file mtime -> ingest date. If only the year is known, use that year with the fallback month from the next available source.
   - Body: one-line gist → key points (max 12 bullets) → quotes → wiki connections (`[[Entity]]`, `[[Concept]]`) → source path/URL.
   - Update the per-leaf JSON entry: `processed: true`, `summary_page: "wiki/sources/<YYYY>/<YYYY-MM>/<slug>.md"`.
   - **Discard the file body from working memory** before opening the next file. Do not keep two file bodies in context simultaneously.
3. Update entity/concept pages **from the takeaways only** (the per-leaf JSON), not by re-opening the raw files. If a raw file truly must be re-read, open it, read just the needed span, and close it before moving on.
4. **Contradictions**: if a new claim disagrees with an existing wiki page, add a block quote on that page:
   ```markdown
   > ⚠️ Conflicts with [[wiki/sources/<YYYY>/<YYYY-MM>/<slug>]]: this source claims X. Follow-up review needed.
   ```
5. Append a single chunk entry to `wiki/log.md`:
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | <leaf path> | sub-chunk <id>
   - Changed files: `wiki/sources/2026/2026-05/foo.md`, `wiki/entities/bar.md`
   - Notes: <files done>/<files total> in leaf
   ```
6. Mark the sub-chunk `status: "done"`, set `ended_at`, record `source_pages_written`. If this was the leaf's last sub-chunk, set `leaves[<leafPath>].status = "done"`. Persist `.state.json`.
7. **Regenerate `wiki/.progress/ingest/DASHBOARD.md`** from `.state.json` (idempotent — overwrite, do not append).
8. **Release `.lock` and return.** Do **not** start the next sub-chunk in the same call. The next `/ingest` invocation will read `.state.json` and pick up the next `pending` sub-chunk.

If an exception is raised during this step:
- Set the sub-chunk `status: "error"`, store the error message in `leaves[<leafPath>].last_error`.
- Set the leaf `status: "partial"` (not `"error"` — other sub-chunks may still succeed).
- Persist and release the lock.

### Step 3 — Merge Pass (separate invocation, one parent per call)

Only run when **every** leaf in the input scope has `status === "done"` and `merge_pass.status !== "done"`.

1. Acquire the same lock with mode `merge`.
2. Pick **one** parent directory from `merge_pass.pending_parents`. For that parent:
   - Combine child-leaf summaries into or onto `wiki/concepts/<topic>.md` (or wherever appropriate).
   - If useful, write/append the root synthesis note at `wiki/synthesis/<batch>.md`.
3. Append a merge entry to `wiki/log.md`:
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | merge pass | <parent>
   - Integrated pages: `wiki/concepts/foo.md`
   ```
4. Remove that parent from `merge_pass.pending_parents`. If empty, set `merge_pass.status = "done"` and reorder `wiki/index.md` in bulk now:
   - Category order: Entities → Concepts → Sources → Answers → Comparisons → Lint Reports → Graph.
   - Sort alphabetically within each category.
   - Item format: `- [[Page Name]] — One-line summary`.
5. Regenerate `DASHBOARD.md`. Release lock. Return.

If `graph.autoUpdateOnIngest` is `true` and the final merge completed, run
`wiki-graphify update` as a **separate coding-agent CLI invocation** after the
ingest invocation returns. Do not bundle the graph step into the same merge-pass
LLM call; it must be a follow-up invocation that uses the `wiki-graphify` skill.

## Error Handling / Resume

- **Crash mid-call**: on next `/ingest`, any sub-chunk left in `status: "in_progress"` is demoted to `"pending"` if its `started_at` is older than 60 seconds and no live pid holds the lock. Resume from it.
- **Quota-style fatal errors**: stop the loop with a clear chat message. Do not silently retry — the next attempt would just reproduce the OOM.
- **Force re-run a leaf**: user can ask "re-ingest raw/foo/". Set that leaf's `status` back to `"pending"` and clear its `sub_chunks`; the next call processes it.
- **`wiki/.progress/ingest/.state.json` corrupted**: rename to `.state.json.bak.<ISO8601>`, re-enumerate from scratch. Warn the user in chat.

## Prohibited (hard rules)

- Do **not** modify, delete, or move files under `raw/`.
- Do **not** delete wiki pages. Retire them by moving to `wiki/archive/<original-path>` with a one-line reason.
- Do **not** invent external URLs. If a source is ambiguous, mark it as "source unknown".
- Do **not** group files beyond `chunking.maxFilesPerInvocation` in one call.
- Do **not** process more than one sub-chunk per LLM invocation when `chunking.unitPerCall === "one_subchunk"`.
- Do **not** keep two raw file bodies in working memory at the same time within a single call.
- Do **not** re-inject the session markdown's entire history into your own reasoning context — read `wiki/.progress/ingest/.state.json` and the relevant per-leaf JSON instead.
- Do **not** run the merge pass and a sub-chunk in the same invocation.

## State Files

### `wiki/.progress/ingest/.state.json`

```json
{
  "version": 1,
  "updated_at": "2026-05-17T12:34:56.000Z",
  "config_snapshot": {
    "maxFilesPerInvocation": 4,
    "maxBytesPerFile": 131072,
    "unitPerCall": "one_subchunk"
  },
  "leaves": {
    "raw/articles/karpathy/": {
      "hash": "<sha1>",
      "status": "pending",
      "sub_chunks": [
        {
          "id": "c1",
          "files": ["raw/articles/karpathy/llm-wiki.md"],
          "status": "pending",
          "started_at": null,
          "ended_at": null,
          "source_pages_written": []
        }
      ],
      "last_error": null,
      "last_session": "sessions/2026-05-17/123456_ingest_karpathy.md",
      "attempts": 0,
      "part_file": "wiki/.progress/ingest/leaves/<sha1>.json"
    }
  },
  "merge_pass": {
    "status": "idle",
    "last_run_at": null,
    "pending_parents": []
  }
}
```

### `wiki/.progress/ingest/leaves/<hash>.json`

```json
{
  "leaf": "raw/articles/karpathy/",
  "files": [
    {
      "path": "raw/articles/karpathy/llm-wiki.md",
      "bytes": 12450,
      "sha1": "<sha1>",
      "processed": false,
      "summary_page": null,
      "truncated": false
    }
  ],
  "takeaways": [],
  "entities_touched": [],
  "concepts_touched": [],
  "contradictions": [],
  "next_action": "process files[0]"
}
```

Caps to apply on this file to prevent unbounded growth:
- `takeaways`: keep most recent 40 bullets. Older content is summarized into the takeaway header.
- `entities_touched` / `concepts_touched`: dedupe, alphabetical.
- `contradictions`: keep all (rare, important).

### `wiki/.progress/ingest/DASHBOARD.md`

Regenerated from `.state.json` after every sub-chunk. Format:

```markdown
# Ingest progress

- Updated: <ISO8601>
- Leaves: <done>/<total> done · <in_progress> in_progress · <pending> pending · <error> error
- Last activity: <leaf> — sub-chunk <id> (<status>)

| leaf | status | sub-chunks done/total | last_error | session |
| --- | --- | --- | --- | --- |
| `raw/articles/karpathy/` | done | 1/1 | — | `sessions/2026-05-17/123456_ingest_karpathy.md` |
| `raw/notes/2026-05/` | partial | 2/3 | rate limit | `sessions/2026-05-17/123456_ingest_karpathy.md` |

_Resume by running `/ingest` again — the next sub-chunk is picked from `.state.json` automatically. Or run `/ingest-loop` to let the webapp's backend driver keep re-spawning the CLI until every sub-chunk and the merge pass are done; click "Stop loop" in the chat UI to halt after the current sub-chunk._
```

## State Migration

If `state.version` is lower than the current SKILL's expected version:
1. Copy the file to `.state.json.bak.<ISO8601>`.
2. Migrate forward field-by-field. Do not drop unknown fields silently — note them in `wiki/log.md`.
3. Bump `version` and persist.

## Minimal Scenario: Single-File Ingest

User:
> `/ingest raw/articles/karpathy/llm-wiki.md`

Skill behavior on call #1:
1. Create session file, take the lock.
2. Enumerate: one leaf `raw/articles/karpathy/`, one sub-chunk `c1` with one file.
3. Step 2: read the file, write `wiki/sources/2026/2026-05/karpathy-llm-wiki.md`, update concept pages `wiki/concepts/llm-wiki-pattern.md`, `wiki/concepts/memex.md`, and entity pages `wiki/entities/andrej-karpathy.md`, `wiki/entities/vannevar-bush.md` from takeaways.
4. Mark sub-chunk `done`, leaf `done`. Update `.state.json`, regen DASHBOARD. Release lock. Return.

Call #2 (`/ingest` again with no arg):
1. State shows leaf `done`, `merge_pass.pending_parents = ["raw/articles/"]`. Run §Step 3 for that parent. Reorder index. Done.

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — searches the wiki and reuses answers fed back by ingest/query.
- [wiki-lint](../wiki-lint/SKILL.md) — periodic health check; catches accumulated contradictions after ingest.
- [wiki-graphify](../wiki-graphify/SKILL.md) — called after the merge pass, by separate invocation. Mirrors the same `.state.json` pattern used here.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md), `wiki-images`.
