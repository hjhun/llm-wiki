---
name: wiki-graphify
description: Use the global graphify command from PATH to build and update the knowledge graph for wiki/ and raw/ with a leaf-first workflow, and provide optional graph context to wiki-query.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-graphify

## Purpose

Use the wiki and original sources as input to produce the following artifacts.

- `wiki/graph/graph.json` — normalized node/edge graph.
- `wiki/graph/GRAPH_REPORT.md` — summary of god nodes, community structure, and key paths.
- `wiki/graph/parts/<path-hash>.json` — partial graph per leaf directory before merge.
- `wiki/graph/.state.json` — leaf path -> last build time/hash.

Knowledge graph work must **always go through this skill**. The web app does not execute graphify directly. It sends `wiki-graphify build/update/query` requests to the coding agent CLI selected in Settings. The coding agent reads this skill and handles execution path selection, leaf-first chunk processing, the merge pass, and logging.

Wiki pages and other skills do not call the `graphify` binary directly.

For normal `/query` workflows, this skill is an **auxiliary tool** like `wiki-search-qmd`: it helps find related nodes, 1-hop neighbors, communities, and cited pages, but `wiki-query` still reads the actual wiki/source pages before writing the final answer.

## Execution Path Rules (HARD)

1. **Use the global `graphify` command from `PATH`.**
2. If the `graphify` command is missing, check whether `python3 -m graphify` works.
3. If neither works, stop immediately and tell the user:
   > Could not find a global `graphify` in PATH. Run `./setup.sh` from the project root, or install manually with `pip install graphifyy && graphify install`.

Execution path decision order:

1. Global `graphify` found in `PATH`.
2. `python3 -m graphify`, when the package is installed but the script path is not on `PATH`.
3. None -> stop.

Important compatibility note for `graphifyy` 0.4.x: the installed CLI exposes
commands such as `graphify update <path>`, `cluster-only`, `query`, `path`, and
`explain`, but it does **not** expose a `graphify build` subcommand. Therefore
`wiki-graphify build` is this repository's agent-level operation name, not a
literal graphify CLI command. Use the installed `graphify` command only for the
commands it actually supports, and use `python3 -m graphify` / package modules
such as `graphify.detect`, `graphify.extract`, `graphify.build`,
`graphify.cluster`, `graphify.report`, and `graphify.export` when assembling
`wiki/graph/graph.json` and `wiki/graph/GRAPH_REPORT.md`.

## Triggers

- Natural language: "build the graph", "update the knowledge graph", "show me the graph".
- UI: `Rebuild` / `Incremental Update` buttons at the top of the Graph tab. The button asks the default coding agent CLI to run this skill instead of executing graphify from the web server.
- Other skill: `wiki-ingest` calls `wiki-graphify update` at the end of its merge pass.
- Direct commands:
  - `wiki-graphify build`
  - `wiki-graphify update`
  - `wiki-graphify update-partial <leafPath> [<leafPath> ...]`
  - `wiki-graphify query "<question>"`

## Input / Output

| Command | Input | Output |
|---|---|---|
| `build` | Optional: `--scope=wiki|raw|wiki+raw` (default `wiki+raw`) | Agent-level full refresh of `graph.json`, `GRAPH_REPORT.md`, `parts/*`, `.state.json`; do not call a literal `graphify build` command |
| `update` | Optional: `--since=<date>`, automatic change detection, or scoped `<leafPath>` list supplied by the webapp | Agent-level incremental rebuild of changed/scoped leaves -> rerun merge pass across **all** valid `parts/*.json` so the changed target is connected into `graph.json` |
| `update-partial` | One or more `<leafPath>` (POSIX, trailing `/`) | Cache-only operation: build per-leaf partials in `wiki/graph/parts/<sha1(leafPath)>.json` for the listed leaves only. **Skip the merge pass.** Do NOT touch `graph.json`, `GRAPH_REPORT.md`, or rerun community clustering. Use only when the caller explicitly wants a cache refresh without a connected final graph. |
| `query` | One natural-language question, optional `--k=<neighbor-count>` | Graph candidate/context notes, cited nodes, and optional Markdown answer when invoked directly |

## Auto Update Strategy

The webapp controls whether ingest calls scoped `update` between loop
iterations with `graph.autoUpdateStrategy`.

- `auto` (default): infer workload size from
  `wiki/.progress/ingest/.state.json`. Run scoped `update` only when at least
  one `graph.partialThresholds` value is met (`minLeaves`, `minFiles`,
  `minBytes`, or `minSubChunks`). Smaller ingests skip scoped updates and rely
  on the final `update`.
- `finalOnly`: never run ingest-time scoped updates; run `update` after the ingest
  merge pass.
- `partialAndFinal`: run scoped `update` for completed leaves and still run
  final `update`.

Regardless of strategy, every `update` must rebuild changed/missing/scoped
partials before merging all valid parts. This keeps small multi-agent ingests
quality-first while large ingests remain resumable.

CLIO multi-agent ingest is stricter than single-agent ingest: do not run scoped
graph updates between worker rounds. The backend should call `wiki-graphify
update` only after all ingest leaves are done and all merge-pass parents are
drained, so graphify reads a stable wiki state.

## Preflight

1. Confirm graphify execution path using the rules above.
2. Create `wiki/graph/` if missing.
3. Do not request a graphify-specific API key. In this repository graph work is
   driven by the selected coding-agent CLI (`codex`, `claude`, `gemini`, or
   `cline`) plus the installed `graphify` package. If a prompt asks for an API
   key before any graph work can start, that is normally the selected coding
   agent CLI lacking login/session credentials in the webapp process
   environment, not graphify itself. Report that distinction clearly. **Never
   expose credentials in wiki pages.**
4. Apply chunk limits and graph options from `config/default.json`, such as `min_community_size` and `extract_model`.

## Chunk Policy (Required, Leaf-First)

This follows the same principle as `wiki-ingest`.

1. **Find leaf directories**: list directories with no child directories in `wiki/` and optionally `raw/`.
2. **Build partial graphs**: for each leaf, use the selected graphify execution path with only the files in that leaf.
   - Output path: `wiki/graph/parts/<sha1(leaf path)>.json`.
   - Options: use supported graphify CLI commands where they fit, or call installed `graphify` Python package modules directly. Choose the narrowest input shape supported by the selected executable/package.
3. **Record state**: update `wiki/graph/.state.json` with leaf path -> `{built_at, content_hash, part_file}`.
4. **Merge pass**: combine all partial graphs into final `graph.json`. See merge algorithm below.
5. **Resume**: if interrupted, compare hashes recorded in `.state.json` with disk state and continue from unbuilt/changed leaves.

## Merge Algorithm

Partial graphs are produced by independent, stateless invocations (one per
leaf), so the **same real-world entity routinely appears under different
ids/labels across partials** — case, spacing, accents, English vs Korean, and
slug variants such as `transformer` vs `transformer-model`. Exact-id matching
alone leaves these as duplicate, poorly connected nodes. The merge pass is
responsible for reconciling them.

1. **Collect nodes**: read every `parts/*.json` and collect nodes/edges into one collection.
2. **Resolve entities (cross-partial, do this first)**: before any id-keyed
   merge, cluster nodes that refer to the **same real-world entity** even when
   their ids differ.
   - Treat as the same entity: case/spacing/punctuation variants, accent
     differences, English/Korean variants of one name, slug variants
     (`transformer` ≈ `transformer-model` ≈ `트랜스포머`), and any node whose
     label or alias matches another node's `[[wikilink]]` target.
   - For each cluster pick one **canonical id** via `normalize(name)`:
     lowercase, spaces -> `-`, remove accents. Preserve every other surface
     form in the canonical node's `aliases` (keep original English/Korean text).
   - Build an alias table `surface form -> canonical id`, then **rewrite every
     edge endpoint** (`src`/`dst`) from a member id to its canonical id.
3. **Merge node properties**: merge nodes that share the canonical `id`. Conflict
   priority: `wiki/` source > `raw/` source. If source grade is equal, the more
   recently updated value wins. Union `tags`, `sources`, and `aliases`.
4. **Normalize edges**: deduplicate by `(src, dst, type)`. Accumulate weight by
   occurrence count. If an endpoint is still missing from the node set, resolve
   it through the step-2 alias table before considering it dangling; drop an
   edge only when no canonical node can be found.
5. **Recompute communities**: run the selected graphify community algorithm once more on the merged graph. Absorb communities that are too small (`size < min_community_size`) into adjacent communities.
6. **Output**: standard `wiki/graph/graph.json` schema below plus
   `GRAPH_REPORT.md`. Enforce the invariant that every `edges[].src`/`dst`
   exists in `nodes[].id`, and report how many dangling edges were resolved or
   dropped in `GRAPH_REPORT.md`.

### Standard graph.json Schema

```json
{
  "version": 1,
  "built_at": "YYYY-MM-DDTHH:MM:SS",
  "nodes": [
    {
      "id": "andrej-karpathy",
      "label": "Andrej Karpathy",
      "type": "entity",
      "tags": ["person", "researcher"],
      "sources": ["wiki/sources/2026/2026-05/karpathy-llm-wiki.md"],
      "community": 3,
      "centrality": 0.42,
      "aliases": ["Karpathy"]
    }
  ],
  "edges": [
    {
      "src": "andrej-karpathy",
      "dst": "llm-wiki-pattern",
      "type": "authored",
      "weight": 1,
      "sources": ["wiki/sources/2026/2026-05/karpathy-llm-wiki.md"]
    }
  ],
  "communities": [
    {"id": 3, "label": "LLM Wiki Pattern", "size": 14}
  ]
}
```

### GRAPH_REPORT.md Structure

- **Summary**: total nodes/edges/communities and build time.
- **God Nodes**: top N by centrality plus one-line descriptions.
- **Communities**: id, label, size, and 5 representative nodes.
- **New Nodes** for incremental updates: nodes added since the previous build.
- **Isolated Nodes**: nodes with zero inbound edges; recommend cross-checking with wiki-lint.

## Workflow

### `build`
1. Preflight -> tell the user "full build is expected to use N chunks".
2. List leaves -> write a checklist to session Markdown (`sessions/<date>/<time>_graph_build.md`).
3. Build a partial graph per leaf and update `.state.json`.
4. Merge pass -> write `graph.json` and `GRAPH_REPORT.md`.
5. Update the `Graph` section of `wiki/index.md` and append a graph entry to `wiki/log.md`.
6. Show a chat card: "N nodes, E edges, C communities. View report ->".

### `update`
1. Compute current content hashes for all leaves and compare them with previous hashes in `.state.json`.
2. If the webapp supplied scoped leaves, rebuild partials for exactly those leaves plus any missing/corrupt partials needed for consistency. Otherwise rebuild all changed/missing leaves. Remove `parts/*.json` for deleted leaves and delete them from `.state.json`.
3. Rerun the merge pass across **all** valid `wiki/graph/parts/*.json`, not only the scoped leaves.
4. Update `GRAPH_REPORT.md` with a section for nodes added/removed/changed in this increment.
5. Update log and index.

### `update-partial`
1. For each `<leafPath>` argument:
   - Read only that leaf's files (apply the same per-file truncation rules as `wiki-ingest`).
   - Build a partial graph for the leaf using the chosen graphify execution path (CLI or Python modules from §Execution Path Rules).
   - Write/overwrite `wiki/graph/parts/<sha1(leafPath)>.json`.
   - Update the leaf's entry in `wiki/graph/.state.json` with `built_at`, `content_hash`, and `part_file`.
2. **Do NOT** rerun community clustering, regenerate `GRAPH_REPORT.md`, or write `wiki/graph/graph.json`. Those are reserved for the merge pass in `build` / `update`.
3. Append a single graph entry to `wiki/log.md`:
   ```markdown
   ## [YYYY-MM-DD HH:MM] graph | update-partial | <leafPath>
   - Wrote: `wiki/graph/parts/<hash>.json`
   ```
4. Reply with a one-line summary: which leaves got partials and their part-file paths.

### `query`
1. Extract keyword/entity candidates from the question.
2. Match candidate nodes in `graph.json`; collect 1-hop neighbors and adjacent nodes inside the community.
3. Read the `wiki/sources/<YYYY>/<YYYY-MM>/...` and `wiki/concepts/...` pages cited by the collected nodes. This follows the same page-reading rules as `wiki-query`.
4. Write the answer. Cite as `(graph: community #C, node "Label")` together with wikilinks.
5. With `--save` or user consent, feed the answer back into `wiki/answers/` using the same schema as `wiki-query`.

When called from `wiki-query`, return graph candidates and context first. Do not replace the `wiki-query` evidence flow; the caller must still read candidate pages and cite them in the final response.

## Error Handling / Resume

- If the selected graphify CLI call fails, write stderr logs to `sessions/.cli/<timestamp>.log` and mark that leaf as `error` in `.state.json`. Continue other leaves.
- Do not run the merge pass automatically if any partial graph remains in `error` state. The user must explicitly request "force partial merge".
- Retry temporary failures such as API rate limits up to three times with exponential backoff.
- If `parts/*.json` is corrupted, force-rebuild that leaf. Hash mismatch should detect this automatically.

## Prohibited

- Do not clone the GitHub repository into `tools/graphify/` or prefer a project-local graphify executable.
- Do not modify `raw/`.
- Do not overwrite `wiki/graph/graph.json` with partial results. Replace the final graph only once during the merge pass.
- For `update-partial`: do not touch `wiki/graph/graph.json`, `wiki/graph/GRAPH_REPORT.md`, or rerun clustering. This command is cache-only. Normal ingest synchronization should use scoped `update`, which refreshes target partials and then merges the full parts set.
- Do not leave API keys or credentials in plaintext in `GRAPH_REPORT.md` or wiki pages.
- Do not pass all of `wiki/` + `raw/` to graphify in one call. Always use leaf chunks.

## Minimal Scenario: First Build

User:
> "Build the knowledge graph"

Skill behavior:
1. Check graphify execution path -> global `graphify` or `python3 -m graphify` works.
2. Find leaves: `wiki/sources/2026/2026-05/`, `wiki/entities/`, `wiki/concepts/`, `wiki/answers/`, `raw/articles/karpathy/` -> 5 chunks.
3. Create session Markdown and chunk checklist.
4. Call the selected graphify CLI for each chunk -> create 5 `parts/<hash>.json` files.
5. Merge -> `graph.json` with 38 nodes, 64 edges, 5 communities, plus `GRAPH_REPORT.md`.
6. Activate the `Graph` item in `wiki/index.md` and append a `graph | build` entry to `wiki/log.md`.
7. Chat card: "38 nodes / 64 edges / 5 communities. View in Graph tab ->".

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — calls `wiki-graphify update` at the end of the merge pass.
- [wiki-query](../wiki-query/SKILL.md) — may use graph context as an auxiliary candidate/context source.
- [wiki-lint](../wiki-lint/SKILL.md) — checks graph <-> wiki mismatches.
