---
title: Code Facts Schema Design
date: 2026-05-30
status: proposed
scope: clio-code-wiki
---

# Code Facts Schema Design

## Purpose

CLIO should answer broad code-related questions well: architecture, dependency
flow, impact analysis, API and route documentation, test coverage, debugging,
configuration, and "where is this implemented?" questions.

The design keeps the existing Code Wiki principle: source code under `raw/`
is immutable evidence, and source-code structure is represented primarily by
the graph under `wiki/graph/`. AST extraction is used as a precise evidence
tool, not as the final knowledge model.

## Design Summary

Use an AST-assisted, graph-first pipeline:

```text
raw/ code
  -> AST/static extractor
  -> normalized Code Facts JSON
  -> wiki/graph/parts/*.json
  -> wiki/graph/graph.json
  -> wiki-query / graph query / optional wiki/code synthesis
```

ASTs are too granular and unstable to expose directly. CLIO should extract
durable code facts from ASTs and static analysis, then merge those facts into
a bounded graph model built around projects, modules, files, public symbols,
routes, tests, and configuration.

## Non-Goals

- Do not store full ASTs as wiki knowledge.
- Do not create one `wiki/code/` page per source file as an ingest completion
  requirement.
- Do not mutate, format, build, test, vendor-prune, or patch repositories under
  `raw/` during Code Wiki operations.
- Do not require perfect language coverage in the first implementation.

## Code Fact Model

Code facts are language-neutral records extracted from code. Every fact must
carry provenance so answers can cite raw logical paths and line ranges.

### Entity Types

```ts
type CodeEntityType =
  | "project"
  | "module"
  | "file"
  | "symbol"
  | "route"
  | "test"
  | "config"
  | "environment";
```

### Relation Types

```ts
type CodeRelationType =
  | "contains"
  | "defines"
  | "imports"
  | "exports"
  | "calls"
  | "handles_route"
  | "reads_config"
  | "uses_env"
  | "tested_by"
  | "depends_on"
  | "implements";
```

### Entity Record

```ts
type CodeFactEntity = {
  id: string;
  type: CodeEntityType;
  kind?: string;
  name: string;
  project: string;
  raw_path: string;
  source_location?: {
    start_line: number;
    end_line?: number;
    start_column?: number;
    end_column?: number;
  };
  parser: string;
  confidence: number;
  content_hash: string;
  metadata?: Record<string, unknown>;
};
```

### Relation Record

```ts
type CodeFactRelation = {
  id: string;
  type: CodeRelationType;
  src: string;
  dst: string;
  raw_path?: string;
  source_location?: {
    start_line: number;
    end_line?: number;
  };
  parser: string;
  confidence: number;
  metadata?: Record<string, unknown>;
};
```

### Artifact Shape

Per leaf, the extractor writes a facts artifact that graphify can transform
into a partial graph.

```json
{
  "version": 1,
  "generated_at": "2026-05-30T00:00:00.000Z",
  "leaf_path": "raw/repos/foo/src/",
  "project": "foo",
  "extractor": {
    "name": "clio-code-facts",
    "version": 1
  },
  "entities": [],
  "relations": [],
  "diagnostics": {
    "files_seen": 0,
    "files_parsed": 0,
    "files_with_fallback": 0,
    "files_failed": 0,
    "truncated": []
  }
}
```

Facts should be persisted under `wiki/graph/facts/<sha1(leafPath)>.json`.
The matching partial graph remains under
`wiki/graph/parts/<sha1(leafPath)>.json`. Keeping facts separate from partial
graphs gives CLIO a small, inspectable intermediate artifact without making
the facts the user-facing knowledge model.

The first implementation may generate both artifacts in one deterministic
extractor call:

```bash
node scripts/code-facts.mjs raw/repos/foo/src \
  --leaf raw/repos/foo/src/ \
  --out wiki/graph/facts/<sha1(leafPath)>.json \
  --graph-out wiki/graph/parts/<sha1(leafPath)>.json
```

### Stable ID Rules

Entity IDs should be deterministic:

- Project: `project:<project>`
- Module: `module:<project>:<module-path>`
- File: `file:<raw-path>`
- Symbol: `symbol:<raw-path>:<symbol-kind>:<symbol-name>:L<start-line>`
- Route: `route:<project>:<method>:<route-pattern>`
- Test: `test:<raw-path>:<test-name-or-line>`
- Config/environment: `config:<project>:<name>` or `env:<project>:<name>`

Line numbers are acceptable in symbol IDs for the first implementation because
they keep extraction simple and provenance clear. The merge pass can later
stabilize renamed or moved symbols through aliases when enough evidence exists.

## Extraction Strategy

Start with a practical hybrid:

- Use AST or parser-backed extraction when available.
- Fall back to conservative regex extraction when a parser is missing or a file
  cannot be parsed.
- Mark fallback facts with lower confidence and `parser: "regex-fallback"`.
- Preserve logical `raw/...` paths even when the raw entry is a symlink.
- Skip generated/vendor/build directories unless explicitly requested.

Initial language support should target the repository's likely needs:

- TypeScript / JavaScript: functions, classes, components, imports, exports,
  Next.js route handlers, environment/config reads.
- Python: modules, classes, functions, imports including relative
  `from .module import name`, common test definitions, and environment reads.
- Rust: modules, structs, enums, traits, functions, public exports, `use`
  dependencies, tests, and environment reads.

The first implementation does not need full call graph precision. It should
prioritize reliable definitions, imports/exports, routes, tests, and source
locations. Call edges should be added conservatively, such as when a named
import resolves to a known symbol and the imported name is called in the file.

## Graph Integration

`wiki-graphify` should consume code facts in the `code` profile and transform
them into graph nodes and edges.

Canonical graph nodes:

- project
- module/package
- file
- public symbol or exported symbol
- route/API handler
- test suite/test file
- config/environment anchor

Graph edges map directly from facts:

- `contains`: project -> module -> file -> symbol
- `imports` / `exports`: file or symbol dependency structure
- `calls`: symbol-to-symbol call relationship when a named import resolves to
  a known symbol and the caller line can be mapped to the nearest local symbol
- `handles_route`: route -> handler symbol
- `tested_by`: symbol/file/module -> test
- `reads_config` / `uses_env`: code -> config/environment
- `implements`: code symbol -> documented concept when evidence exists

The graph merge pass still owns canonicalization, alias handling, pruning,
community recomputation, and final `wiki/graph/graph.json` generation.

## Query Behavior

CLIO should route code questions by intent:

- Structure questions: traverse `contains`, `imports`, and communities.
- Impact questions: start from a file/symbol and follow inbound/outbound
  `calls`, `imports`, `exports`, and `depends_on` edges.
- API/route questions: follow `handles_route` to handlers, schemas, services,
  and tests.
- Testing questions: inspect `tested_by` edges and public symbols without test
  coverage.
- Debug questions: map stack trace paths and lines to nearest file/symbol,
  then inspect local call/import neighborhoods.
- Documentation questions: combine source summaries, graph neighborhoods, and
  targeted read-only raw spans.

Final answers must remain grounded in wiki/source pages, graph nodes with
provenance, or targeted read-only raw snippets. Graph output is navigation and
candidate context, not sufficient proof by itself.

## Implementation Plan

### Phase 1 - Contract And Minimal Extractor

- Add a documented Code Facts schema.
- Add a `scripts/code-facts.mjs` extractor or extend `scripts/code-index.mjs`
  while keeping compatibility.
- Produce Code Facts JSON for a raw leaf.
- Persist facts to `wiki/graph/facts/<sha1(leafPath)>.json` when called from a
  graph operation.
- Emit a base partial graph to `wiki/graph/parts/<sha1(leafPath)>.json` from
  the same facts when `--graph-out` is supplied.
- Support TypeScript/JavaScript, Python, and Rust with parser-backed or
  conservative fallback extraction.
- Include diagnostics and confidence fields.

### Phase 2 - Graphify Integration

- Update `wiki-graphify` instructions so `code` profile uses Code Facts when
  available.
- Update `webapp/lib/graph.ts` graph operation prompt to prefer Code Facts for
  raw code leaves.
- Transform Code Facts into `wiki/graph/parts/<sha1(leafPath)>.json`.
- Ensure the final merge still rewrites `wiki/graph/graph.json` from all valid
  parts.

### Phase 3 - Query Improvements

- Teach code-oriented query prompts to mention the relation families above.
- Add answer patterns for structure, impact, API/route, testing, and debugging
  questions.
- Continue to use targeted `rg` reads only when graph/source evidence is
  insufficient.

### Phase 4 - Tests And Fixtures

- Add fixture code under a test-controlled path, not under user-owned `raw/`.
- Verify that the extractor emits stable entities, relations, diagnostics, and
  source locations.
- Verify fallback behavior for malformed or unsupported files.
- Verify graph prompt text includes the Code Facts contract.

## Risks And Mitigations

- Graph bloat: limit graph nodes to durable code entities and cap symbols per
  file via existing graph extraction settings.
- Parser availability: fallback to conservative regex facts with lower
  confidence.
- False call edges: only emit calls when evidence is reliable; prefer imports,
  exports, routes, tests, and definitions first.
- Stale facts: include content hashes and rebuild changed leaves through the
  existing graph state mechanism.
- Provenance loss: require every fact to include `raw_path`, parser, confidence,
  and source location when known.

## Acceptance Criteria

- A code leaf can produce Code Facts JSON without mutating `raw/`.
- Facts include stable IDs, provenance, confidence, and diagnostics.
- graphify code profile can transform facts into partial graph nodes/edges.
- `wiki/graph/graph.json` can answer at least one fixture question from each
  category: structure, impact, API/route, testing, and debugging.
- Existing ingest behavior remains graph-first and does not require mirrored
  `wiki/code/` file pages.
