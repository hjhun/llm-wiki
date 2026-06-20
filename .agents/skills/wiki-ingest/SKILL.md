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

1. Write one `wiki/sources/<raw-relative-path>.md` summary page per original prose source, mirroring the logical `raw/` directory structure instead of filing sources by ingest/source date. **Code sources are the exception:** instead of one page per file, write a single project provenance stub `wiki/sources/<project>/index.md`, and let `wiki-graphify` produce the per-project graphify-out and the detailed `wiki/code/<project>.md` analysis.
2. Create or update related entity/concept pages, reusing existing pages instead of creating near-duplicates (see Step 2.3).
3. If a leaf is code-heavy, keep the normal LLM Wiki ingest contract: write provenance/source summaries and progress state, then let the separate `wiki-graphify update` workflow build the code knowledge graph from the immutable code under `raw/`.
4. Refresh `wiki/sources/index.md` as a compact source catalog organized by metadata facets such as topic, entity, source kind, source date, raw path prefix, status, and recent updates.
5. Create or update `wiki/maps/<topic>.md` associative trail pages when a source belongs to an ongoing research thread that benefits from a navigable source/concept/entity map.
6. Keep `wiki/index.md` and `wiki/log.md` consistent.
7. Graph synchronization is **not** performed by this skill. The webapp triggers `wiki-graphify` as separate invocations after ingest progress is detected. Ingest workers must not run graphify or write anything under `wiki/graph/`.

This skill **always follows the leaf-first + merge pass** principle, and is built
to survive interruption (OOM, SIGTERM, manual cancel) because progress is
externalized to `progress/ingest/`.

## Triggers

- `/ingest <path|URL>` — chat slash command. Both `/ingest` and `/ingest-loop`
  run through one single-agent backend loop (`runIngestLoop`); there is no
  multi-worker fan-out. Per the default `unitPerCall: "session_batch"` contract,
  keep processing the next pending sub-chunk **in this same session** (each
  sub-chunk still bounded by `maxFilesPerInvocation`/`maxBytesPerFile`),
  persisting its source page and state after each, until the scope's pending
  work reaches zero or you hit a natural stopping point, then exit. Do not exit
  after a single sub-chunk unless `unitPerCall: "one_subchunk"` is configured.
- `/ingest-loop <path|URL>` — same skill body, driven by the webapp's backend
  loop in `/api/chat/send` (`kind="ingest-loop"`). The backend re-invokes the
  CLI (resuming the warm session when the host CLI supports it) until
  `progress/ingest/.state.json` reports no remaining `pending`, `in_progress`,
  or `partial` sub-chunks and `merge_pass.status === "done"`, or until the user
  clicks "Stop loop" (which drops `progress/ingest/.stop`). Before the first
  iteration, the backend performs a deterministic filename/stat-only leaf
  bootstrap so the session can act on actionable leaves immediately instead of
  spending one LLM call on enumeration. The backend loop is the outer
  resumption/safety net; within a session you self-loop over sub-chunks per the
  `session_batch` contract, but stop and exit cleanly when you hit a per-leaf
  lock you cannot pass or context grows large enough that a fresh session would
  be cleaner — the backend resumes you.
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
- Externalized progress: `progress/ingest/.state.json` + `progress/ingest/leaves/<hash>.json` + human-readable `progress/ingest/DASHBOARD.md`.
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
sub-chunk.** All resume information lives in `progress/ingest/`, so the
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
   - `chunking.unitPerCall` — defaults to `"session_batch"`: keep processing
     pending sub-chunks within this one warm session (each still bounded by the
     caps above) until the scope is done or you hit a natural stop, then exit.
     `"one_subchunk"` is the conservative fallback — exactly one sub-chunk per
     invocation. Honor whichever is configured strictly.
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

Record the classification in `progress/ingest/.state.json` per leaf:

```json
{
  "leaves": {
    "raw/repos/foo/src/": {
      "kind": "code",
      "project": "foo"
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
2. Ensure `progress/ingest/` exists. Create `leaves/`, `tmp/` subfolders if missing. The `leaves/` subfolder holds per-leaf lock files (one per leaf currently being processed); it is also reused by graphify state but the lock subset is owned by ingest workers.
3. Honor any `ASSIGNED LEAF SCOPE` block in the prompt:
   - If the block lists specific leaves, restrict all sub-chunk work in this invocation to those leaves.
   - If the block is empty (no leaves assigned for this round), exit successfully without acquiring any lock, writing state, or enumerating leaves.
   - If the block is absent or marks the scope as Unrestricted, operate normally over the requested raw scope.
4. Acquire locks with the two-tier protocol:
   - **Global state mutex** `progress/ingest/.lock` is a *short* critical-section mutex around enumeration and `.state.json` read-modify-write windows only. File contents: `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>", "phase": "state-write" | "enumerate" | "merge-pass"}`. Write via `tmp/<rand>.lock` then rename — atomic on POSIX. Release immediately when the critical section ends; never hold it across LLM file reads or sub-chunk processing.
   - **Per-leaf lock** `progress/ingest/leaves/<sha1(leafPath)>.lock` guards sub-chunk processing for a single leaf. File contents: `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>", "leaf_path": "<raw/.../>"}`. Acquire it before reading any file in the leaf, release it on exit (success, error, or no-op).
   - If a per-leaf lock is held by another live process, skip that leaf and try the next assigned leaf. Do **not** abort the whole invocation just because one leaf is busy — parallel workers expect contention here.
   - The merge pass (Step 3) holds the global lock with `phase: "merge-pass"` for its duration since it touches multiple leaves' parent pages.
   - Treat any lock whose `pid` is no longer alive as stale and replace it atomically.
5. Read `progress/ingest/.state.json` if it exists. If `version` mismatches the current SKILL version, run the migration in §State Migration before proceeding.

### Step 1 — Enumerate Leaves (idempotent)

When the webapp backend has already populated `progress/ingest/.state.json` and
the prompt assigns concrete leaves, skip this step and process the assigned
pending sub-chunk. Run this step only when there is no state, no actionable leaf
for the requested scope, or the prompt explicitly says this worker is the
enumeration worker.

1. From the requested input root (default `raw/`), list every leaf directory (no child directories) **and every direct-file pseudo-leaf**: if a directory has source files directly inside it as well as child directories, create a separate leaf unit for those direct files using that directory's logical `raw/.../` path. This is required for code repositories whose project root or parent modules contain files such as `package.json`, `src/index.ts`, route files, or config files alongside child directories. A single file or URL counts as a virtual leaf whose path is its parent directory. Follow symlinked files/directories that are located under `raw/`, but track visited real paths/inodes to avoid cycles and do not traverse the same real directory twice under one target.
2. For each leaf compute a stable identity:
   - `leafPath` = POSIX-style relative path (always ends with `/`), using the
     logical `raw/...` path even when the leaf is reached through a symlink.
   - `hash` = sha1 of `JSON.stringify(sortedFileList.map(f => [f.path, f.size, f.mtimeMs]))`, where `f.path` is the logical `raw/...` path and `size`/`mtimeMs` are read from the target file.
3. Update `progress/ingest/.state.json`:
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
   - **For code files, do NOT write a per-file `wiki/sources/<...>/file.md`
     page.** Per-file code summaries are removed — they were inefficient. Instead
     ensure exactly **one provenance stub per project** exists at
     `wiki/sources/<project>/index.md` (create it on first encounter, append the
     file to its `raw_path`/file list on later encounters). The stub is
    lightweight: project name, language/stack, the `raw/...` root, and links to
    any human-written or later synthesized `wiki/code/` pages. Keep symbols,
    dependencies, and line-level structure out of ingest unless a separate Code
    Wiki synthesis skill is explicitly requested.
   - Update the per-leaf JSON entry: `processed: true`, `summary_page: "wiki/sources/<raw-relative-path>.md"`.
   - **Discard the file body from working memory** before opening the next file. Do not keep two file bodies in context simultaneously.
3. If the sub-chunk is code-heavy, keep Code Wiki work wiki-first:
   - Do **not** create per-file `wiki/sources/<...>/file.md` pages or mirrored
     `wiki/code/<project>/<relative-file>.md` pages. The only code page ingest
     writes is the one project provenance stub `wiki/sources/<project>/index.md`.
   - Do **not** write `wiki/code/<project>.md` here as a required ingest output.
     Detailed code analysis pages are optional wiki synthesis artifacts, not
     graphify side effects.
   - Do **not** run `scripts/code-index.mjs` or `scripts/code-facts.mjs` as the
     normal path. They are legacy fallback/debug helpers only.
   - Record enough progress state for the backend to know which logical
     `raw/...` leaf, project, and files were processed. `source_pages_written`
     (the project stub) remains the provenance contract; `code_outputs` is
     legacy compatibility and may be omitted for new code ingests.
   - A later `wiki-graphify update` reads the compiled wiki pages only and
     produces `wiki/graph/graph.json` plus `wiki/graph/GRAPH_REPORT.md`. It must
     not graphify `raw/` source trees.
   - If a user explicitly asks for a human-readable architecture, testing, API,
     or debug synthesis, answer from source summaries and targeted read-only
     raw evidence when needed, and optionally save that synthesis as ordinary
     wiki pages.
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
8. **Regenerate `progress/ingest/DASHBOARD.md`** from `.state.json` (idempotent — overwrite, do not append).
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
- **`progress/ingest/.state.json` corrupted**: rename to `.state.json.bak.<ISO8601>`, re-enumerate from scratch. Warn the user in chat.

## Code Wiki Graph Conventions

Code Wiki follows the root `llm-wiki.md` pattern: raw code remains immutable
source material, and the LLM-maintained wiki accumulates summaries,
cross-references, and answers. Source-code knowledge is represented by source
stubs, optional `wiki/code/` analysis pages, and the wiki-only graph over those
Markdown pages.

Primary Code Wiki graph artifacts:

- `wiki/graph/graph.json` — final connected graph across `wiki/` pages only,
  including `wiki/code/` pages when they exist.
- `wiki/graph/GRAPH_REPORT.md` — human-readable graph report.
- `wiki/sources/<project>/index.md` — one lightweight provenance stub per code
  project (the only code page ingest writes). For logs, tests, or runtime
  evidence that is not source code, a normal `wiki/sources/<raw-relative-path>.md`
  summary is still appropriate.

Do not create per-file code source pages or file-by-file `wiki/code` pages.
Detailed code synthesis is an ordinary wiki synthesis step, not a graphify
side effect and not ad hoc file-by-file code reading during ingest.

For code locations, use logical `raw/...` paths in any saved wiki page:

```markdown
- `runIngestLoop` — `raw/repos/foo/webapp/lib/ingest-loop.ts:L940`
  ([open](/explorer?ws=raw&path=repos/foo/webapp/lib/ingest-loop.ts&line=940))
```

If a language feature is hard to resolve, mark the location as unknown or run a
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
- Do **not** re-inject the session markdown's entire history into your own reasoning context — read `progress/ingest/.state.json` and the relevant per-leaf JSON instead.
- Do **not** run the merge pass and a sub-chunk in the same invocation.

## State Files

### `progress/ingest/.state.json`

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
      "part_file": "progress/ingest/leaves/<sha1>.json"
    }
  },
  "merge_pass": {
    "status": "idle",
    "last_run_at": null,
    "pending_parents": []
  }
}
```

### `progress/ingest/leaves/<hash>.json`

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

### `progress/ingest/DASHBOARD.md`

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

## Completion Checklist

Verify every item before reporting this run complete. Render the result as a
`- Checklist:` line inside the `wiki/log.md` entry you append for this run,
marking each item `[x]` done, `[ ]` + short reason when blocked, or `[-]` when
not applicable. Do not claim the run finished while a required `[ ]` remains.
This is the authoritative, file-based checklist for ingest; the Appendix A list
in `CLAUDE.md`/`AGENTS.md` is a summary of it.

Per sub-chunk (Step 2):

- [ ] Processed exactly one `pending` sub-chunk; read its files one at a time (never two file bodies in memory).
- [ ] Wrote `wiki/sources/<raw-relative-path>.md` with required frontmatter for each prose file — OR, for code, ensured one `wiki/sources/<project>/index.md` stub and wrote no per-file code pages.
- [ ] Updated entity/concept pages from takeaways only, reusing existing pages (checked `wiki/index.md` for case/spacing/EN-KO variants; no near-duplicates).
- [ ] Recorded any contradiction as a block quote on the affected page.
- [ ] Appended one `wiki/log.md` entry for this sub-chunk.
- [ ] Marked sub-chunk `done`; if leaf finished, set leaf `done` and queued its parent into `merge_pass.pending_parents`; persisted `.state.json`.
- [ ] Regenerated `DASHBOARD.md`; released per-leaf lock (and global mutex); returned without starting another sub-chunk.

Per merge pass (Step 3):

- [ ] Ran only when every in-scope leaf is `done` and `merge_pass.status !== "done"`.
- [ ] Integrated child-leaf summaries into the parent concept/synthesis pages.
- [ ] Refreshed `wiki/sources/index.md` (via `scripts/build-sources-index.mjs`) and any useful `wiki/maps/` trails.
- [ ] When `pending_parents` drained: reordered and deduped `wiki/index.md` in bulk.
- [ ] Ran `scripts/mini-lint.mjs` and surfaced the one-line summary.
- [ ] Appended the merge `wiki/log.md` entry; left `wiki-graphify update` as a separate follow-up invocation (not bundled into this call).

## Related Skills

- [wiki-query](../wiki-query/SKILL.md) — searches the wiki and reuses answers fed back by ingest/query.
- [wiki-lint](../wiki-lint/SKILL.md) — periodic health check; catches accumulated contradictions after ingest.
- [wiki-graphify](../wiki-graphify/SKILL.md) — called after the merge pass, by separate invocation. Mirrors the same `.state.json` pattern used here.
- Optional: [wiki-search-qmd](../wiki-search-qmd/SKILL.md), [wiki-marp](../wiki-marp/SKILL.md), [wiki-images](../wiki-images/SKILL.md) — delegate image/scan/screenshot leaves here for text-first multimodal handling.
