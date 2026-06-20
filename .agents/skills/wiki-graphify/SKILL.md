---
name: wiki-graphify
description: Use the global graphify command from PATH to build and update the knowledge graph for wiki/ only with a leaf-first workflow, and provide optional graph context to wiki-query.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-graphify

## LLM Wiki Pattern Reference

This skill supports the persistent, interlinked wiki described in
[`llm-wiki.md`](../../../llm-wiki.md) by materializing graph artifacts from
`wiki/` only. Graph output is auxiliary navigation/context:
it helps agents find relationships, but final answers and wiki updates still
ground claims in wiki pages, source summaries, and read-only raw sources.

## Purpose

Use the compiled wiki as input to produce an Obsidian-like page graph first,
then enrich it with bounded graphify extraction when useful. Graph generation
must read Markdown under `wiki/` only; `raw/` remains ingest/query evidence and
is not a graphify input.

- `wiki/graph/graph.json` — final connected node/edge graph over `wiki/` pages.
- `wiki/graph/GRAPH_REPORT.md` — summary of god nodes, community structure, and key paths.
- `wiki/graph/parts/<path-hash>.json` — partial **page-title** graph per wiki leaf directory before merge.
- `wiki/graph/.state.json` — wiki leaf path -> last build time/hash.

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
| `build` | Optional: `--scope=wiki` (fixed default from `graph.extraction.scope`) | Agent-level full refresh of `graph.json`, `GRAPH_REPORT.md`, wiki page `parts/*`, and `.state.json`; do not call a literal `graphify build` command |
| `update` | Optional: `--since=<date>`, automatic change detection, or scoped `wiki/` `<leafPath>` list supplied by the webapp | Agent-level incremental rebuild of changed/scoped wiki leaves -> rerun connect pass across **all** valid `parts/*.json` so the changed target is connected into `graph.json` |
| `update-partial` | One or more `<leafPath>` (POSIX, trailing `/`) | Cache-only operation: build per-leaf partials in `wiki/graph/parts/<sha1(leafPath)>.json` for the listed leaves only. **Skip the merge pass.** Do NOT touch `graph.json`, `GRAPH_REPORT.md`, or rerun community clustering. Use only when the caller explicitly wants a cache refresh without a connected final graph. |
| `query` | One natural-language question, optional `--k=<neighbor-count>` | Graph candidate/context notes, cited nodes, and optional Markdown answer when invoked directly |

## Auto Update Strategy

The webapp controls whether ingest calls scoped `update` between loop
iterations with `graph.autoUpdateStrategy`.

- `auto` (default): infer workload size from
  `progress/ingest/.state.json`. Run scoped `update` only when at least
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
4. Apply chunk limits and graph options from merged config (`config/default.json` plus `config/local.json`), especially `graph.extraction`, `graph.minCommunitySize`, and `chunking.*`.

## Page-Title Graph Model (Default)

CLIO's default knowledge graph is page-first, not concept-extraction-first.
This makes the graph behave more like Obsidian: stable Markdown pages are the
primary nodes, and relationships inside those pages create the edges.

Default node rules:

1. Create one node for each Markdown page in scope. Use frontmatter `title`
   when present; otherwise derive the label from the filename. Use a stable id
   from the wiki path without `.md` (`wiki/concepts/llm-wiki-pattern.md` ->
   `concepts/llm-wiki-pattern`), with `aliases` containing the displayed title.
2. For source pages, keep the raw-mirrored page path as the node id
   (`wiki/sources/articles/foo.md` -> `sources/articles/foo`) and store
   `raw_path`, `source_date`, `ingested_at`, `topics`, `entities`, `concepts`,
   `projects`, and `claims` as metadata.
3. Connect prose pages with **two edge classes only** (`graph.extraction.proseEdges
   = "explicit+semantic"`):
   - **Explicit links** (always kept): `[[Page Name]]` and relative Markdown
     links -> `links_to`; frontmatter `sources` -> `cites`; source page
     `raw_path` -> `derived_from`.
   - **Semantic relatedness** (kept only when content is genuinely related):
     graphify's inferred/semantic-similarity edges between two page nodes,
     retained **only** when `confidence_score >=
     graph.extraction.semanticMinConfidence`. Tag them `related_to` with the
     score in `weight`/`confidence`.
4. **Do not** turn frontmatter facets (`topics`, `entities`, `concepts`,
   `projects`, `claims`) into edges. `graph.extraction.facetEdges = false`:
   keep facets as node metadata only. The old facet -> `mentions`/`about` auto
   edges are removed because they over-connected the graph. A facet becomes an
   edge only when it matches an existing page node *and* that relationship is
   also expressed as an explicit link or clears the semantic threshold.
5. Do not create standalone nodes for headings, paragraphs, rationale snippets,
   incidental nouns, or every claim. Keep those as metadata on the page/source
   node unless a durable wiki page exists for them.

The intended prose result is: one node per page (its title), explicit links
always, and a sparse set of high-confidence `related_to` edges where two pages
actually cover related content — not a dense facet mesh.

## Extraction Profile (CLIO-Bounded Graphify)

Use the global graphify extraction style, but run it through a CLIO profile
instead of copying the global `/graphify` skill verbatim. The global graphify
skill is intentionally generous: it extracts AST symbols, semantic concepts,
rationale nodes, semantic-similarity edges, hyperedges, and rich exports. CLIO's
graph is an auxiliary retrieval layer for an already-curated wiki, so page-title
nodes are built first and graphify's extractors are followed by filtering,
normalization, and node budgets.

Default policy comes from `graph.extraction`:

```json
{
  "primaryNodeModel": "page-title",
  "profile": "wiki",
  "scope": "wiki",
  "maxNodesPerLeaf": 40,
  "maxConceptsPerSource": 8,
  "minConfidence": 0.65,
  "includeRationaleNodes": false,
  "includeHyperedges": false,
  "dropIsolatedDerivedNodes": true,
  "proseEdges": "explicit+semantic",
  "facetEdges": false,
  "includeSemanticSimilarity": true,
  "semanticMinConfidence": 0.72
}
```

Profiles:

- `wiki` (default): graph source pages, entity pages, concept pages, maps, and
  their explicit wikilinks/frontmatter. Page titles/paths are the canonical
  nodes, one node per page. Edges are explicit links plus high-confidence
  `related_to` semantic edges only (see §Page-Title Graph Model). Frontmatter
  facets stay as node metadata; they are **not** auto-converted to edges. Do not
  create nodes for headings, paragraphs, individual claims, rationale snippets,
  or every mentioned noun.
- `deep`: allow richer global graphify behavior for deliberate investigations.
  Even in this profile, preserve the wiki-only input rule and the partial layout
  under `wiki/graph/parts/`, and enforce provenance, confidence, and merge
  invariants.

Filtering rules after extraction:

1. Keep all page-backed nodes with stable paths. For extracted nodes, keep only
   nodes that have stable provenance (`sources`, `source_file`, or `raw_path`)
   and a meaningful label.
2. Keep explicit relationships first: wikilinks, frontmatter facets, imports,
   calls, citations, and source-page references.
3. Drop `INFERRED` edges with `confidence_score < graph.extraction.minConfidence`
   unless the profile is `deep`.
4. Keep semantic-relatedness edges (`related_to` /
   `semantically_similar_to`) **only** when `confidence_score >=
   graph.extraction.semanticMinConfidence`; drop the rest. This is the prose
   "connect only when content is related" gate. Always keep explicit
   link/cite/derived edges regardless of this threshold.
5. Drop any auto facet edge (`mentions`/`about` derived purely from a
   `topics`/`entities`/`concepts`/`projects` facet) when
   `graph.extraction.facetEdges=false`; keep the facet as node metadata.
6. Drop rationale/claim-snippet nodes unless `includeRationaleNodes=true`; keep
   the important claim text on the source node's metadata instead.
7. Drop hyperedges unless `includeHyperedges=true`.
8. Enforce `maxConceptsPerSource` and `maxNodesPerLeaf` on wiki leaves by
   keeping cited, linked, high-centrality, and page-backed nodes first. Record
   any truncation count in the partial graph and `GRAPH_REPORT.md`.
9. If `dropIsolatedDerivedNodes=true`, remove isolated prose nodes that are not
   backed by a wiki/source page. Isolated page-backed source/entity/concept
   nodes may stay because they are useful retrieval anchors.

The intended result is a compact topology graph, not an exhaustive AST or
sentence-level graph. A normal small wiki should produce tens or hundreds of
nodes, not one node per heading, claim, function, or incidental concept.

## Chunk Policy (Required, Leaf-First)

This follows the same principle as `wiki-ingest`.

The unit kind is a **wiki leaf** (page-title partial). Do not enumerate `raw/`
for graph generation.

1. **Find wiki leaf directories**: list directories with no child directories in
   `wiki/`. Also treat files that live directly inside a non-leaf directory as a
   small pseudo-leaf for that directory, so root files such as `wiki/index.md`
   and `wiki/log.md` are not skipped.
2. **Build prose page-title partials**: for each prose leaf, use the selected
   graphify execution path with only the files in that leaf. Reuse graphify
   package modules where possible (`detect`, `extract`, `build`, `cluster`,
   `report`, `export`), then apply the CLIO prose profile (one node per page,
   explicit links + thresholded `related_to` edges, no facet edges).
   - Output path: `wiki/graph/parts/<sha1(leaf path)>.json`.
   - Options: use supported graphify CLI commands where they fit, or call
     installed `graphify` Python package modules directly. Choose the narrowest
     input shape supported by the selected executable/package.
3. **Record state**: update `wiki/graph/.state.json` with wiki `leaf path ->
   {built_at, content_hash, part_file}`.
4. **Connect pass**: combine all wiki partials into the final `graph.json`. See
   merge algorithm below.
5. **Resume**: if interrupted, compare hashes recorded in `.state.json` with disk
   state and continue from unbuilt/changed wiki leaves.

## Merge / Connect Algorithm

Inputs are wiki page-title partials (`wiki/graph/parts/*.json`). The connect
pass must preserve page-backed node identity and merge explicit/semantic
relationships between wiki pages.

1. **Collect nodes**: read every `wiki/graph/parts/*.json` and collect
   nodes/edges into one collection. Ignore any extracted node that violates the
   active `graph.extraction` profile unless it is already present in an
   existing `graph.json` with valid provenance.
2. **Anchor page nodes first**: page-backed nodes keep canonical ids derived
   from their wiki path. If multiple nodes point at the same `page_path`, merge
   them into that page node and union aliases/metadata.
3. **Resolve extracted aliases**: before any remaining id-keyed merge, cluster
   extracted nodes that refer to the **same real-world entity** even when their
   ids differ.
   - Treat as the same entity: case/spacing/punctuation variants, accent
     differences, English/Korean variants of one name, slug variants
     (`transformer` ≈ `transformer-model` ≈ `트랜스포머`), and any node whose
     label or alias matches another node's `[[wikilink]]` target.
   - If a matching page node exists, use that page node id as canonical. If no
     page exists, pick one canonical id via `normalize(name)`: lowercase, spaces
     -> `-`, remove accents. Preserve every other surface form in the canonical
     node's `aliases` (keep original English/Korean text).
   - Build an alias table `surface form -> canonical id`, then **rewrite every
     edge endpoint** (`src`/`dst`) from a member id to its canonical id.
4. **Merge node properties**: merge nodes that share the canonical `id`. Prefer
   page-backed `wiki/` metadata when values conflict, then the more recently
   updated value. Union `tags`, `sources`, and `aliases`.
5. **Normalize edges**: deduplicate by `(src, dst, type)`. Accumulate weight by
   occurrence count. If an endpoint is still missing from the node set, resolve
   it through the step-3 alias table before considering it dangling; drop an
   edge only when no canonical node can be found.
6. **Apply graph budget**: after dedupe, prune low-confidence inferred edges,
   isolated derived nodes, and over-budget per-source/per-leaf nodes according
   to `graph.extraction`. Never prune the last provenance anchor for a source
   page.
7. **Recompute communities**: run the selected graphify community algorithm once more on the merged graph. Absorb communities that are too small (`size < minCommunitySize`) into adjacent communities.
8. **Output**: standard `wiki/graph/graph.json` schema below plus
   `GRAPH_REPORT.md`. Enforce the invariant that every `edges[].src`/`dst`
   exists in `nodes[].id`, and report how many dangling edges were resolved or
   dropped in `GRAPH_REPORT.md`. Also report nodes/edges pruned by the CLIO
   extraction profile.

### Standard graph.json Schema

```json
{
  "version": 1,
  "built_at": "YYYY-MM-DDTHH:MM:SS",
  "nodes": [
    {
      "id": "sources/articles/karpathy/llm-wiki",
      "label": "Karpathy LLM Wiki",
      "type": "source",
      "page_path": "wiki/sources/articles/karpathy/llm-wiki.md",
      "raw_path": "raw/articles/karpathy/llm-wiki.md",
      "tags": ["llm-wiki"],
      "sources": ["wiki/sources/articles/karpathy/llm-wiki.md"],
      "community": 3,
      "centrality": 0.42,
      "aliases": ["LLM Wiki"]
    }
  ],
  "edges": [
    {
      "src": "sources/articles/karpathy/llm-wiki",
      "dst": "concepts/llm-wiki-pattern",
      "type": "links_to",
      "weight": 1,
      "sources": ["wiki/sources/articles/karpathy/llm-wiki.md"]
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
- **Extraction Budget**: active profile, scope, nodes/edges kept, nodes/edges
  pruned, and any per-leaf truncation.
- **Isolated Nodes**: nodes with zero inbound edges; recommend cross-checking with wiki-lint.

## Workflow

### `build`
1. Preflight -> tell the user "full build is expected to use N wiki leaves".
2. List wiki leaves -> write a checklist to session Markdown (`sessions/<date>/<time>_graph_build.md`).
3. Build a page-title partial per wiki leaf and update `.state.json`.
4. Connect pass -> write final `graph.json` and `GRAPH_REPORT.md`.
5. Update the `Graph` section of `wiki/index.md` and append a graph entry to `wiki/log.md`.
6. Show a chat card: "N nodes, E edges, C communities. View report ->".

### `update`
1. Compute current content hashes for all wiki leaves and compare them with previous hashes in `.state.json`.
2. If the webapp supplied scoped wiki leaves, rebuild exactly those plus any missing/corrupt artifacts needed for consistency. Ignore non-wiki scoped leaves. Otherwise rebuild all changed/missing wiki leaves. Remove `parts/*.json` for deleted units and delete them from `.state.json`.
3. Rerun the connect pass across **all** valid `wiki/graph/parts/*.json`, not only the scoped units.
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
3. Read the `wiki/sources/<raw-relative-path>.md` and `wiki/concepts/...` pages cited by the collected nodes. This follows the same page-reading rules as `wiki-query`.
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
- Do not read, hash, enumerate, or graphify `raw/` as part of graph generation.
- Do not overwrite `wiki/graph/graph.json` with partial results. Replace the final graph only once during the connect pass.
- Do not write graphify-out to the package default `graphify-out/` at the repo root. The webapp's Graph tab only reads `wiki/graph/graph.json`, so any other final path is invisible to the user.
- Do not run `scripts/code-facts.mjs`, write `wiki/graph/facts/*.json`, write `wiki/graph/projects/<project>/`, or synthesize `wiki/code/<project>.md` as part of graph generation. Existing `wiki/code/` pages are ordinary wiki Markdown inputs.
- For `update-partial`: do not touch `wiki/graph/graph.json`, `wiki/graph/GRAPH_REPORT.md`, or rerun clustering. This command is cache-only. Normal ingest synchronization should use scoped `update`, which refreshes target wiki partials and then connects the full set.
- Do not leave API keys or credentials in plaintext in `GRAPH_REPORT.md` or wiki pages.
- Do not pass `raw/` to graphify. Always use wiki leaf chunks.

## Minimal Scenario: First Build

User:
> "Build the knowledge graph"

Skill behavior:
1. Check graphify execution path -> global `graphify` or `python3 -m graphify` works.
2. Find wiki leaves: `wiki/sources/articles/karpathy/`, `wiki/entities/`, `wiki/concepts/`, `wiki/answers/` -> 4 page-title partials.
3. Create session Markdown and unit checklist.
4. Build 4 `parts/<hash>.json` page-title partials.
5. Connect -> `graph.json` with 38 nodes, 64 edges, 5 communities, plus `GRAPH_REPORT.md`.
6. Activate the `Graph` item in `wiki/index.md` and append a `graph | build` entry to `wiki/log.md`.
7. Chat card: "38 nodes / 64 edges / 5 communities. View in Graph tab ->".

## Completion Checklist

Verify every item before reporting the graph operation complete. Render the
result as a `- Checklist:` line inside the `wiki/log.md` graph entry you append,
marking each item `[x]` done, `[ ]` + short reason when blocked, or `[-]` when
not applicable. Do not claim the operation finished while a required `[ ]`
remains.

For `build` / `update` (connected graph):

- [ ] Confirmed graphify execution path (global `graphify`, else `python3 -m graphify`).
- [ ] Built/refreshed page-title partials for changed or scoped wiki leaves — explicit links + thresholded `related_to` edges only, no facet edges, one node per page.
- [ ] Confirmed `raw/` was not read, hashed, enumerated, or graphified.
- [ ] Ran the connect pass across ALL valid `parts/*.json`; verified every `edges[].src`/`dst` exists in `nodes[].id`.
- [ ] Wrote `wiki/graph/graph.json` once (not overwritten with partial results) and `GRAPH_REPORT.md` with Extraction Budget sections.
- [ ] Updated `wiki/graph/.state.json`, the `Graph` section of `wiki/index.md`, and appended the `wiki/log.md` entry.

For `update-partial` (cache-only):

- [ ] Built only the listed leaves' partials; did NOT touch `graph.json`, `GRAPH_REPORT.md`, or rerun clustering.
- [ ] Updated `.state.json` for those leaves and appended the `update-partial` log entry.

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — calls `wiki-graphify update` at the end of the merge pass.
- [wiki-query](../wiki-query/SKILL.md) — may use graph context as an auxiliary candidate/context source.
- [wiki-lint](../wiki-lint/SKILL.md) — checks graph <-> wiki mismatches.
