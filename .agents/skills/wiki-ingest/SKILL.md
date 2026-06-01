---
name: wiki-ingest
description: Read new material in raw/ as leaf-directory chunks and incrementally build wiki/. Automatically detects prose, code repositories, logs, and test output; code-heavy leaves preserve source summaries and rely on graphify to materialize code knowledge under wiki/graph/. Responds to /ingest, /ingest-loop, "summarize this material", and chat + -> ingest triggers.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-ingest

## LLM Wiki Pattern Reference

This skill instantiates the repository-root [`llm-wiki.md`](../../../llm-wiki.md)
pattern: the user curates immutable `raw/` sources, and the LLM incrementally
builds a persistent, interlinked Markdown wiki instead of re-deriving knowledge
from raw documents at query time. The concrete CLIO rules in `AGENTS.md`,
`CLAUDE.md`, and this skill specialize that pattern for resumable chunking,
Code Wiki graph updates and Korean wiki writing.

## Purpose

Read material newly dropped by the user into `raw/` and perform the following.

1. Write one `wiki/sources/<raw-relative-path>.md` summary page per original source, mirroring the logical `raw/` directory structure instead of filing sources by ingest/source date.
2. Create or update related entity/concept pages, reusing existing pages instead of creating near-duplicates (see Step 2.3).
3. If a leaf is code-heavy, keep the normal LLM Wiki ingest contract: write provenance/source summaries and progress state, then let the separate `wiki-graphify update` workflow build the code knowledge graph from the immutable code under `raw/`.
4. Refresh `wiki/sources/index.md` as a compact source catalog organized by metadata facets such as topic, entity, source kind, source date, raw path prefix, status, and recent updates.
5. Create or update `wiki/maps/<topic>.md` associative trail pages when a source belongs to an ongoing research thread that benefits from a navigable source/concept/entity map.
6. Keep `wiki/index.md` and `wiki/log.md` consistent.
7. Graph synchronization is **not** performed by this skill. The webapp triggers `wiki-graphify` as separate invocations after ingest progress is detected. Ingest workers must not run graphify or write anything under `wiki/graph/`.

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
- Code repositories or source trees under `raw/`, including approved symlinks.
- Single URL, downloaded to `raw/<slug>.<ext>` before processing.
- Folder path, such as `raw/dir/`, including its subtree. If the folder or a
  descendant entry is a user-approved symlink located under `raw/`, follow it
  read-only while preserving logical `raw/...` paths in state, source
  frontmatter, citations, and logs.
- If input is omitted, default to all of `raw/`.

## Output

- List of new/updated `wiki/**` Markdown files.
- For code-heavy inputs, graph-ready source summaries and ingest progress; the Code Wiki graph itself is produced by the separate `wiki-graphify update` invocation under `wiki/graph/`.
- Session Markdown with chat log: `sessions/<date>/<time>_ingest.md` (conversation only).
- Externalized progress: `wiki/.progress/ingest/.state.json` + `wiki/.progress/ingest/leaves/<hash>.json` + human-readable `wiki/.progress/ingest/DASHBOARD.md`.
- `wiki/sources/index.md` refreshed during the merge pass when source pages changed.
- Optional `wiki/maps/<topic>.md` associative trails for active research threads.
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
2. Validate that the requested input path is lexically inside `raw/` after
   normalizing `.` and `..`. **Reject direct processing outside `raw/`.**
   User-approved symlink entries located under `raw/` are valid source entries:
   follow them read-only even if their real target is outside the repository,
   but keep every recorded path in logical `raw/...` form and never write to
   the symlink target. Reject broken symlinks and symlink loops with a clear
   warning.
3. Read knobs from `config/default.json` (merged with `config/local.json`):
   - `chunking.maxFiles`, `chunking.maxBytes` — soft cap per chunk.
   - `chunking.maxFilesPerInvocation` — **hard cap per LLM call**. Defaults to 4.
   - `chunking.maxBytesPerFile` — files above this read head + tail only.
   - `chunking.unitPerCall` — defaults to `"one_subchunk"`. Honor this strictly.
4. If the host coding-agent CLI is stateless (`claude -p`, `codex exec`, …), the
   host already slim-injects: a short dashboard reference + last N turns. Do
   **not** ask for the whole session markdown back.
5. If the target may contain code, scan only filenames/manifests first to
   classify leaves. Do not open many source files just to decide whether the
   input is code.
6. If code leaves are present, do not perform file-by-file LLM code
   documentation. Preserve lightweight source summaries and state. The backend
   triggers `wiki-graphify update` after ingest progress, and that workflow
   uses graphify's code extraction path to produce nodes, edges, communities,
   and reports under `wiki/graph/`.

## Code Auto-Detection

`/ingest` and `/ingest-loop` are the only user-facing commands. There is no
separate Code Wiki command. During leaf enumeration, classify each leaf as
`prose`, `code`, `mixed`, or `ignore`.

Treat a leaf as `code` or `mixed` when it contains any of:

- Source files: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rs`,
  `.go`, `.java`, `.kt`, `.swift`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.cs`,
  `.php`, `.rb`, `.sh`, `.sql`.
- Project/config files: `package.json`, `Cargo.toml`, `pyproject.toml`,
  `go.mod`, `pom.xml`, `build.gradle`, `Dockerfile`, `compose.yaml`,
  `tsconfig.json`.
- Tests: filenames containing `test`, `spec`, `__tests__`, `tests/`.
- Runtime evidence: stack traces, CI logs, failing test output, or issue
  reproduction notes.

Treat these as `ignore` unless explicitly requested: `.git/`, `node_modules/`,
`dist/`, `build/`, `target/`, `.next/`, `.venv/`, `vendor/`, coverage output,
lockfile-only leaves, generated bundles, and binary assets.

Record the classification in `wiki/.progress/ingest/.state.json` per leaf:

```json
{
  "leaves": {
    "raw/repos/foo/src/": {
      "kind": "code",
      "project": "foo",
      "graph_scope": "raw/repos/foo/src/"
    }
  }
}
```

Use the nearest project manifest or the first directory under `raw/` as the
`project` name.

## Workflow

### Step 0 — Use Session and Acquire Lock

1. Use the active chat session supplied by the host.
   - If the prompt includes `Active session log: sessions/<path>.md`, treat that
     session as already created. **Do not create another `sessions/*.md` file.**
   - If no active session is supplied because the skill is being run directly
     outside the webapp/CLI adapter, create one chat log session file
     `sessions/<YYYY-MM-DD>/<HHMMSS>_ingest_<subject>.md` (frontmatter only).
   - This file holds the conversation, not progress.
2. Ensure `wiki/.progress/ingest/` exists. Create `leaves/`, `tmp/` subfolders if missing. The `leaves/` subfolder holds per-leaf lock files (one per leaf currently being processed); it is also reused by graphify state but the lock subset is owned by ingest workers.
3. Honor any `ASSIGNED LEAF SCOPE` block in the prompt:
   - If the block lists specific leaves, restrict all sub-chunk work in this invocation to those leaves.
   - If the block is empty (no leaves assigned for this round), exit successfully without acquiring any lock, writing state, or enumerating leaves.
   - If the block is absent or marks the scope as Unrestricted, operate normally over the requested raw scope.
4. Acquire locks with the two-tier protocol:
   - **Global state mutex** `wiki/.progress/ingest/.lock` is a *short* critical-section mutex around enumeration and `.state.json` read-modify-write windows only. File contents: `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>", "phase": "state-write" | "enumerate" | "merge-pass"}`. Write via `tmp/<rand>.lock` then rename — atomic on POSIX. Release immediately when the critical section ends; never hold it across LLM file reads or sub-chunk processing.
   - **Per-leaf lock** `wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock` guards sub-chunk processing for a single leaf. File contents: `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>", "leaf_path": "<raw/.../>"}`. Acquire it before reading any file in the leaf, release it on exit (success, error, or no-op).
   - If a per-leaf lock is held by another live process, skip that leaf and try the next assigned leaf. Do **not** abort the whole invocation just because one leaf is busy — parallel workers expect contention here.
   - The merge pass (Step 3) holds the global lock with `phase: "merge-pass"` for its duration since it touches multiple leaves' parent pages.
   - Treat any lock whose `pid` is no longer alive as stale and replace it atomically.
5. Read `wiki/.progress/ingest/.state.json` if it exists. If `version` mismatches the current SKILL version, run the migration in §State Migration before proceeding.

### Step 1 — Enumerate Leaves (idempotent)

1. From the requested input root (default `raw/`), list every leaf directory (no child directories) **and every direct-file pseudo-leaf**: if a directory has source files directly inside it as well as child directories, create a separate leaf unit for those direct files using that directory's logical `raw/.../` path. This is required for code repositories whose project root or parent modules contain files such as `package.json`, `src/index.ts`, route files, or config files alongside child directories. A single file or URL counts as a virtual leaf whose path is its parent directory. Follow symlinked files/directories that are located under `raw/`, but track visited real paths/inodes to avoid cycles and do not traverse the same real directory twice under one target.
2. For each leaf compute a stable identity:
   - `leafPath` = POSIX-style relative path (always ends with `/`), using the
     logical `raw/...` path even when the leaf is reached through a symlink.
   - `hash` = sha1 of `JSON.stringify(sortedFileList.map(f => [f.path, f.size, f.mtimeMs]))`, where `f.path` is the logical `raw/...` path and `size`/`mtimeMs` are read from the target file.
3. Update `wiki/.progress/ingest/.state.json`:
   - New leaves are added with `status: "pending"`, an empty `sub_chunks` list, and `attempts: 0`.
   - Existing leaves whose `hash` changed have their status reset to `"pending"` and their `sub_chunks` cleared. (Re-ingest is intentional when content changed.)
   - Leaves that no longer exist on disk get `status: "stale"`; do not delete them — the user may have moved files temporarily.
4. Plan sub-chunks for each `pending` leaf. A sub-chunk groups up to `chunking.maxFilesPerInvocation` files and stays under `chunking.maxBytes` total. Persist the sub-chunk plan into `.state.json` before any file is opened.
5. For code leaves, preserve module grouping when possible: keep related source,
   test, route, schema, and config files in the same sub-chunk if it does not
   exceed limits. Do not group generated/vendor files.

### Step 2 — Process **One** Sub-Chunk Per Invocation (the hard rule)

For exactly **one** sub-chunk whose `status === "pending"`:

1. Mark the sub-chunk `status: "in_progress"`, set `started_at`, increment `leaves[<leafPath>].attempts`. Persist immediately.
2. Open files **one at a time**, in the order recorded in the sub-chunk:
   - Read files through their logical `raw/...` paths. If a path crosses a
     symlink, treat the target as read-only source material and continue to
     cite/store only the logical `raw/...` path.
   - If the file is larger than `chunking.maxBytesPerFile`, read only `head (N/2)` + a marker + `tail (N/2)` bytes. Record `truncated: true` in the per-leaf JSON.
   - Write `wiki/sources/<raw-relative-path>.md` for that file with the required frontmatter (`title`, `type: source`, `tags`, `sources: [raw/...]`, `updated`) and optional source-page fields such as `source_date: YYYY-MM-DD | YYYY-MM` and `ingested_at: YYYY-MM-DDTHH:MM:SS`.
   - Derive the source path by stripping the leading `raw/` and replacing the original extension with `.md`: `raw/articles/foo.pdf` -> `wiki/sources/articles/foo.md`. If a source page summarizes a directory or logical source group, use `wiki/sources/<raw-relative-dir>/index.md`.
   - Add source facets when knowable: `source_kind`, `raw_path`, `language`, `topics`, `entities`, `concepts`, `projects`, `claims`, and `status`. These fields drive retrieval and cataloging; do not encode date or topic taxonomy in the source file path.
   - Preserve dates as metadata only. Choose `source_date` by this priority: explicit source text date -> raw path/metadata date -> raw file mtime -> ingest date. If only the year is known, store the year or `YYYY-MM` when the month is knowable; do not create date folders from it.
   - Body: one-line gist → key points (max 12 bullets) → quotes → wiki connections (`[[Entity]]`, `[[Concept]]`, and useful `[[wiki/maps/<topic>]]` trails) → source path/URL.
   - For code files, keep the source summary lightweight: identify the file or
     group as code evidence, note obvious project/module context from filenames
     or manifests, and defer detailed symbols, dependencies, and line-level
     structure to graphify.
   - Update the per-leaf JSON entry: `processed: true`, `summary_page: "wiki/sources/<raw-relative-path>.md"`.
   - **Discard the file body from working memory** before opening the next file. Do not keep two file bodies in context simultaneously.
3. If the sub-chunk is code-heavy, keep Code Wiki work graph-first:
   - Do **not** create mirrored `wiki/code/<project>/<relative-file>.md` pages
     or per-directory `index.md` pages as a completion requirement.
   - Do **not** run `scripts/code-index.mjs` as the normal path. It is a legacy
     fallback/debug helper only.
   - Record enough progress state for the backend to know which logical
     `raw/...` leaf and files were processed. `source_pages_written` remains
     the provenance contract; `code_outputs` is legacy compatibility and may be
     omitted for new code ingests.
   - The Code Wiki artifact for source code is the graphify output produced by
     a later `wiki-graphify update`: `wiki/graph/parts/<hash>.json`,
     `wiki/graph/graph.json`, and `wiki/graph/GRAPH_REPORT.md`.
   - If a user explicitly asks for a human-readable architecture, testing, API,
     or debug synthesis after the graph exists, answer from the graph and
     source summaries and optionally save that synthesis as ordinary wiki pages.
4. Update entity/concept pages **from the takeaways only** (the per-leaf JSON), not by re-opening the raw files. If a raw file truly must be re-read, open it, read just the needed span, and close it before moving on.
   - **Reuse before creating.** Before adding a new `wiki/entities/` or `wiki/concepts/` page, check `wiki/index.md` for an existing page naming the same target — including case, spacing, punctuation, and English/Korean variants (`Transformer` ≈ `트랜스포머` ≈ `transformer-model`). If one exists, update it and link with the index's exact `[[Page Name]]`. Create a new page only when no existing page covers the target. Parallel workers each see only part of the input, so this is the main safeguard against near-duplicate pages — and therefore against duplicate, disconnected graph nodes.
5. **Contradictions**: if a new claim disagrees with an existing wiki page, add a block quote on that page:
   ```markdown
   > ⚠️ Conflicts with [[wiki/sources/articles/foo]]: this source claims X. Follow-up review needed.
   ```
6. Append a single chunk entry to `wiki/log.md`:
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | <leaf path> | sub-chunk <id>
   - Changed files: `wiki/sources/articles/foo.md`, `wiki/entities/bar.md`
   - Notes: <files done>/<files total> in leaf
   ```
7. Mark the sub-chunk `status: "done"`, set `ended_at`, and record `source_pages_written`. For code/mixed leaves, do not block completion on `wiki/code` page creation. If this was the leaf's last sub-chunk, set `leaves[<leafPath>].status = "done"` **and queue the merge pass**: add the leaf's immediate parent directory (a POSIX path ending in `/`; use `raw/` for a leaf sitting directly under `raw/`) to `merge_pass.pending_parents` unless it is already listed. This is the only place `pending_parents` is filled — Step 3 and the `/ingest-loop` backend driver both rely on it to know merge work is outstanding, so skipping it leaves the loop unable to detect completion. Persist `.state.json`.
8. **Regenerate `wiki/.progress/ingest/DASHBOARD.md`** from `.state.json` (idempotent — overwrite, do not append).
9. **Release the per-leaf lock (and the global state mutex if still held) and return.** Do **not** start the next sub-chunk in the same call. The next `/ingest` invocation will read `.state.json` and pick up the next `pending` sub-chunk.

If an exception is raised during this step:
- Set the sub-chunk `status: "error"`, store the error message in `leaves[<leafPath>].last_error`.
- Set the leaf `status: "partial"` (not `"error"` — other sub-chunks may still succeed).
- Persist and release the lock.

### Step 3 — Merge Pass (separate invocation, one parent per call)

Only run when **every** leaf in the input scope has `status === "done"` and `merge_pass.status !== "done"`.

1. Acquire the same lock with mode `merge`.
2. If `merge_pass.pending_parents` is empty there is nothing to merge: set `merge_pass.status = "done"`, regenerate `DASHBOARD.md`, release the lock, and return. Otherwise pick **one** parent directory from `merge_pass.pending_parents`. For that parent:
   - Combine child-leaf summaries into or onto `wiki/concepts/<topic>.md` (or wherever appropriate).
   - If useful, write/append the root synthesis note at `wiki/synthesis/<batch>.md`.
   - Refresh `wiki/sources/index.md` by running the deterministic generator: `node scripts/build-sources-index.mjs`. The script walks `wiki/sources/`, parses each source page's frontmatter, and rewrites the header section (faceted by recently-updated, topic, entity, source_kind, source_date, project, status, plus a full alphabetical list). Any LLM-authored prose past the `<!-- clio:sources-index:custom -->` marker is preserved verbatim. Do **not** hand-edit the generated header; if a facet is missing, fix the script. If the script is unavailable, fall back to writing a compact, facet-oriented index by hand using the same fields.
   - Create or update `wiki/maps/<topic>.md` only when there is a durable research thread or associative trail worth navigating. Map pages should link to source summaries, entity/concept pages, answers, contradictions, and open questions; they should not duplicate every source summary.
   - If the parent contains code leaves, do not consolidate `wiki/code/` file
     pages. The merge pass should keep the normal LLM Wiki pages coherent; the
     separate `wiki-graphify update` invocation builds the code graph from
     `raw/`.
3. Append a merge entry to `wiki/log.md`:
   ```markdown
   ## [YYYY-MM-DD HH:MM] ingest | merge pass | <parent>
   - Integrated pages: `wiki/concepts/foo.md`
   ```
4. Remove that parent from `merge_pass.pending_parents`. If empty, set `merge_pass.status = "done"` and reorder `wiki/index.md` in bulk now:
   - Category order: Entities → Concepts → Code → Sources → Maps → Answers → Comparisons → Lint Reports → Graph.
   - Sort alphabetically within each category.
   - Item format: `- [[Page Name]] — One-line summary`.
5. Regenerate `DASHBOARD.md`. Release lock.
6. **Post-merge mini-lint gate.** After the merge pass that drained `merge_pass.pending_parents`, run `node scripts/mini-lint.mjs` (deterministic, sub-second). It catches three classes of issues parallel ingest workers tend to introduce — near-duplicate concept/entity titles, broken `[[wiki/...]]` wikilinks, and orphan synthesis pages — and writes a report to `wiki/lint/post-merge-<YYYY-MM-DD>.md`. The webapp's `/ingest-loop` driver runs the same script automatically; for one-shot `/ingest` calls the skill is the trigger. Surface the one-line summary in your reply; the full LLM `wiki-lint` workflow still owns deeper checks. Return.

If `graph.autoUpdateOnIngest` is `true`, graph synchronization is handled as
separate coding-agent CLI invocations after ingest progress is detected. The
webapp may run scoped `wiki-graphify update` between loop iterations only when
`graph.autoUpdateStrategy` allows it (`auto` uses workload thresholds). A
scoped update rebuilds the completed leaf's partial graph from the logical
`raw/...` code source or generated wiki page and then merges all valid
`wiki/graph/parts/*.json` into the connected final `graph.json`. After the
final merge completes, always run `wiki-graphify update` as the quality
merge/normalization pass. Do not bundle graph work into the same merge-pass LLM
call; each graph step must be a follow-up invocation that uses the
`wiki-graphify` skill.

When CLIO runs ingest through multi-agent orchestration, skip all scoped
between-round graph updates. Run `wiki-graphify update` only once, after every
leaf is done and every merge-pass parent has been drained. This prevents graph
normalization from seeing a partial worker state and producing disconnected or
stale graph artifacts.

## Error Handling / Resume

- **Crash mid-call**: on next `/ingest`, any sub-chunk left in `status: "in_progress"` is demoted to `"pending"` if its `started_at` is older than 60 seconds and no live pid holds the lock. Resume from it.
- **Quota-style fatal errors**: stop the loop with a clear chat message. Do not silently retry — the next attempt would just reproduce the OOM.
- **Force re-run a leaf**: user can ask "re-ingest raw/foo/". Set that leaf's `status` back to `"pending"` and clear its `sub_chunks`; the next call processes it.
- **`wiki/.progress/ingest/.state.json` corrupted**: rename to `.state.json.bak.<ISO8601>`, re-enumerate from scratch. Warn the user in chat.

## Code Wiki Graph Conventions

Code Wiki follows the root `llm-wiki.md` pattern: raw code remains immutable
source material, and the LLM-maintained wiki accumulates summaries,
cross-references, and answers. Source-code structure itself is represented by
the graphify knowledge graph, not by forcing the LLM to write one Markdown page
per source file.

Primary Code Wiki graph artifacts:

- `wiki/graph/parts/<sha1(leafPath)>.json` — partial graph for a raw code leaf.
- `wiki/graph/facts/<sha1(leafPath)>.json` — normalized Code Facts extracted
  from raw code before graph conversion.
- `wiki/graph/graph.json` — merged graph across wiki and raw code evidence.
- `wiki/graph/GRAPH_REPORT.md` — human-readable graph report.
- `wiki/sources/<raw-relative-path>.md` — provenance summary for raw code,
  logs, tests, or runtime evidence.

Optional human-readable code pages may still be created when they are useful
synthesis, such as an answer saved under `wiki/answers/` or a project overview
under `wiki/code/<project>/overview.md`. They are not required for ingest
completion, and they should be derived from source summaries plus graphify
evidence rather than ad hoc file-by-file code reading.

For code locations, prefer graph nodes and edges containing `source_file` and
`source_location`. Use logical `raw/...` paths in any saved wiki page:

```markdown
- `runIngestLoop` — `raw/repos/foo/webapp/lib/ingest-loop.ts:L940`
  ([open](/explorer?ws=raw&path=repos/foo/webapp/lib/ingest-loop.ts&line=940))
```

If graphify misses a language feature, mark the location as unknown or run a
targeted read-only `rg` search. Do not invent line numbers.

## Prohibited (hard rules)

- Do **not** modify, delete, or move files under `raw/` or any real filesystem
  target reached through a `raw/` symlink.
- Do **not** delete wiki pages. Retire them by moving to `wiki/archive/<original-path>` with a one-line reason.
- Do **not** invent external URLs. If a source is ambiguous, mark it as "source unknown".
- Do **not** format, patch, build, or test source repositories under `raw/`
  during ingest. They are evidence. Actual code edits are separate coding tasks.
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
3. Step 2: read the file, write `wiki/sources/articles/karpathy/llm-wiki.md`, update concept pages `wiki/concepts/llm-wiki-pattern.md`, `wiki/concepts/memex.md`, and entity pages `wiki/entities/andrej-karpathy.md`, `wiki/entities/vannevar-bush.md` from takeaways.
4. Mark sub-chunk `done`, leaf `done`. Update `.state.json`, regen DASHBOARD. Release lock. Return.

Call #2 (`/ingest` again with no arg):
1. State shows leaf `done`, `merge_pass.pending_parents = ["raw/articles/"]`. Run §Step 3 for that parent. Reorder index. Done.

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — searches the wiki and reuses answers fed back by ingest/query.
- [wiki-lint](../wiki-lint/SKILL.md) — periodic health check; catches accumulated contradictions after ingest.
- [wiki-graphify](../wiki-graphify/SKILL.md) — called after the merge pass, by separate invocation. Mirrors the same `.state.json` pattern used here.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md), [wiki-images](../wiki-images/SKILL.md) — delegate image/scan/screenshot leaves here for text-first multimodal handling.
