#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

mkdir -p \
  "${TMP_ROOT}/scripts" \
  "${TMP_ROOT}/raw/repos/demo/app/api/items" \
  "${TMP_ROOT}/raw/repos/demo/lib" \
  "${TMP_ROOT}/raw/repos/demo/python" \
  "${TMP_ROOT}/raw/repos/demo/rust" \
  "${TMP_ROOT}/raw/repos/demo/bad" \
  "${TMP_ROOT}/raw/repos/demo/tests" \
  "${TMP_ROOT}/wiki/concepts" \
  "${TMP_ROOT}/wiki/sources/articles"
cp "${ROOT_DIR}/scripts/code-facts.mjs" "${TMP_ROOT}/scripts/code-facts.mjs"
cp "${ROOT_DIR}/scripts/merge-graph-parts.mjs" "${TMP_ROOT}/scripts/merge-graph-parts.mjs"

cat > "${TMP_ROOT}/raw/repos/demo/package.json" <<'JSON'
{
  "name": "demo",
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
JSON

cat > "${TMP_ROOT}/raw/repos/demo/Cargo.toml" <<'TOML'
[package]
name = "demo-rust"
version = "0.1.0"

[dependencies]
serde = "1"
TOML

cat > "${TMP_ROOT}/raw/repos/demo/pyproject.toml" <<'TOML'
[project]
name = "demo-py"
dependencies = [
  "fastapi>=0.110",
  "pydantic",
]

[project.optional-dependencies]
dev = ["pytest"]
TOML

cat > "${TMP_ROOT}/raw/repos/demo/go.mod" <<'GO'
module example.com/demo

go 1.23

require github.com/google/uuid v1.6.0

require (
  golang.org/x/sync v0.8.0
)
GO

cat > "${TMP_ROOT}/raw/repos/demo/Dockerfile" <<'DOCKER'
FROM node:22-alpine AS base
FROM ghcr.io/example/demo-runtime:latest
DOCKER

cat > "${TMP_ROOT}/raw/repos/demo/compose.yaml" <<'YAML'
services:
  db:
    image: postgres:16
YAML

cat > "${TMP_ROOT}/raw/repos/demo/tsconfig.json" <<'JSON'
{
  "extends": "@tsconfig/node22/tsconfig.json",
  "references": [
    { "path": "./tsconfig.app.json" }
  ]
}
JSON

cat > "${TMP_ROOT}/raw/repos/demo/bad/package.json" <<'JSON'
{ "name": "broken",
JSON

cat > "${TMP_ROOT}/raw/repos/demo/bad/notes.txt" <<'TXT'
This unsupported file should not become a Code Facts input.
TXT

node -e 'process.stdout.write("export const big = `" + "x".repeat(530000) + "`;\\n")' \
  > "${TMP_ROOT}/raw/repos/demo/bad/large.ts"

cat > "${TMP_ROOT}/raw/repos/demo/app/api/items/route.ts" <<'TS'
import { loadItems } from "../../../lib/items";

export async function GET() {
  const bucket = process.env.ITEM_BUCKET;
  return Response.json(await loadItems(bucket));
}
TS

cat > "${TMP_ROOT}/raw/repos/demo/lib/items.ts" <<'TS'
export async function loadItems(bucket?: string) {
  return [{ bucket }];
}
TS

cat > "${TMP_ROOT}/raw/repos/demo/tests/items.test.ts" <<'TS'
import { loadItems } from "../lib/items";

test("loads items", async () => {
  await loadItems("demo");
});
TS

cat > "${TMP_ROOT}/raw/repos/demo/python/helpers.py" <<'PY'
def transform(value):
    return value or "empty"
PY

cat > "${TMP_ROOT}/raw/repos/demo/python/service.py" <<'PY'
import os
from .helpers import transform

def run_service():
    token = os.environ.get("PY_TOKEN")
    return transform(token)
PY

cat > "${TMP_ROOT}/raw/repos/demo/tests/test_service.py" <<'PY'
from ..python.service import run_service

def test_run_service():
    assert run_service() is not None
PY

cat > "${TMP_ROOT}/raw/repos/demo/rust/lib.rs" <<'RS'
pub struct Item {
    name: String,
}

pub fn load_items() -> String {
    std::env::var("RUST_BUCKET").unwrap_or_else(|_| "default".to_string())
}
RS

(cd "${TMP_ROOT}" && node scripts/code-facts.mjs \
  raw/repos/demo \
  --leaf raw/repos/demo/ \
  --out wiki/graph/facts/demo.json \
  --graph-out wiki/graph/parts/demo.json)

cat > "${TMP_ROOT}/wiki/graph/parts/noisy.json" <<'JSON'
{
  "version": 1,
  "built_at": "2026-05-30T00:00:00.000Z",
  "leaf_path": "raw/repos/demo/noisy/",
  "leaf_hash": "noisy",
  "source": "test-fixture",
  "nodes": [
    {
      "id": "project:demo",
      "label": "demo",
      "type": "project",
      "tags": ["code"],
      "sources": ["raw/repos/demo"],
      "aliases": ["demo-project"]
    }
  ],
  "edges": [
    {
      "src": "project:demo",
      "dst": "module:demo:external:zod",
      "type": "depends_on",
      "confidence": 0.1,
      "weight": 0.1
    },
    {
      "src": "project:demo",
      "dst": "missing:node",
      "type": "contains",
      "confidence": 0.9,
      "weight": 0.9
    }
  ]
}
JSON

(cd "${TMP_ROOT}" && node scripts/merge-graph-parts.mjs \
  --parts wiki/graph/parts \
  --out wiki/graph/graph.json \
  --report wiki/graph/GRAPH_REPORT.md \
  --min-confidence 0.65 \
  --profile code-facts \
  --state wiki/graph/.state.json >/dev/null)

node - \
  "${TMP_ROOT}/wiki/graph/facts/demo.json" \
  "${TMP_ROOT}/wiki/graph/parts/demo.json" \
  "${TMP_ROOT}/wiki/graph/graph.json" \
  "${TMP_ROOT}/wiki/graph/GRAPH_REPORT.md" \
  "${TMP_ROOT}/wiki/graph/.state.json" <<'NODE'
const fs = require("node:fs");
const factsPath = process.argv[2];
const partPath = process.argv[3];
const finalGraphPath = process.argv[4];
const reportPath = process.argv[5];
const statePath = process.argv[6];
const doc = JSON.parse(fs.readFileSync(factsPath, "utf8"));
const part = JSON.parse(fs.readFileSync(partPath, "utf8"));
const graph = JSON.parse(fs.readFileSync(finalGraphPath, "utf8"));
const report = fs.readFileSync(reportPath, "utf8");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

const entityIds = new Set(doc.entities.map((entity) => entity.id));
const relationTypes = new Set(doc.relations.map((relation) => relation.type));
const relations = doc.relations;

assert(doc.version === 1, "version should be 1");
assert(doc.leaf_path === "raw/repos/demo/", "leaf path should be preserved");
assert(doc.project === "demo", "project should be inferred from raw/repos/<name>");
assert(entityIds.has("project:demo"), "project entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/package.json"), "package config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/Cargo.toml"), "Cargo config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/pyproject.toml"), "pyproject config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/go.mod"), "go.mod config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/Dockerfile"), "Dockerfile config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/compose.yaml"), "compose config entity missing");
assert(entityIds.has("config:demo:raw/repos/demo/tsconfig.json"), "tsconfig config entity missing");
assert(entityIds.has("module:demo:external:zod"), "package dependency entity missing");
assert(entityIds.has("module:demo:external:serde"), "Cargo dependency entity missing");
assert(entityIds.has("module:demo:external:fastapi"), "pyproject dependency entity missing");
assert(entityIds.has("module:demo:external:github.com/google/uuid"), "go dependency entity missing");
assert(entityIds.has("module:demo:external:golang.org/x/sync"), "go block dependency entity missing");
assert(entityIds.has("module:demo:external:node:22-alpine"), "Docker base dependency entity missing");
assert(entityIds.has("module:demo:external:postgres:16"), "compose image dependency entity missing");
assert(entityIds.has("module:demo:external:@tsconfig/node22"), "tsconfig extends dependency entity missing");
assert([...entityIds].some((id) => id.includes("symbol:raw/repos/demo/lib/items.ts:function:loadItems")), "loadItems symbol missing");
assert([...entityIds].some((id) => id.includes("symbol:raw/repos/demo/python/helpers.py:function:transform")), "Python transform symbol missing");
assert([...entityIds].some((id) => id.includes("symbol:raw/repos/demo/rust/lib.rs:function:load_items")), "Rust load_items symbol missing");
assert([...entityIds].some((id) => id.startsWith("route:demo:GET:")), "GET route missing");
assert(entityIds.has("env:demo:ITEM_BUCKET"), "environment entity missing");
assert(entityIds.has("env:demo:PY_TOKEN"), "Python environment entity missing");
assert(entityIds.has("env:demo:RUST_BUCKET"), "Rust environment entity missing");
assert(relationTypes.has("contains"), "contains relation missing");
assert(relationTypes.has("defines"), "defines relation missing");
assert(relationTypes.has("imports"), "imports relation missing");
assert(relationTypes.has("exports"), "exports relation missing");
assert(relationTypes.has("calls"), "calls relation missing");
assert(relationTypes.has("handles_route"), "handles_route relation missing");
assert(relationTypes.has("tested_by"), "tested_by relation missing");
assert(relationTypes.has("uses_env"), "uses_env relation missing");
assert(relationTypes.has("depends_on"), "depends_on relation missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/package.json" &&
  relation.dst === "module:demo:external:zod"
), "package dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/Cargo.toml" &&
  relation.dst === "module:demo:external:serde"
), "Cargo dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/pyproject.toml" &&
  relation.dst === "module:demo:external:fastapi"
), "pyproject dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/go.mod" &&
  relation.dst === "module:demo:external:github.com/google/uuid"
), "go.mod dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/Dockerfile" &&
  relation.dst === "module:demo:external:node:22-alpine"
), "Dockerfile dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/compose.yaml" &&
  relation.dst === "module:demo:external:postgres:16"
), "compose image dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "depends_on" &&
  relation.src === "config:demo:raw/repos/demo/tsconfig.json" &&
  relation.dst === "module:demo:external:@tsconfig/node22"
), "tsconfig extends dependency edge missing");
assert(relations.some((relation) =>
  relation.type === "handles_route" &&
  relation.src.startsWith("route:demo:GET:") &&
  relation.dst.includes("symbol:raw/repos/demo/app/api/items/route.ts:function:GET")
), "route should point at GET handler symbol");
assert(relations.some((relation) =>
  relation.type === "calls" &&
  relation.src.includes("symbol:raw/repos/demo/app/api/items/route.ts:function:GET") &&
  relation.dst.includes("symbol:raw/repos/demo/lib/items.ts:function:loadItems")
), "TypeScript symbol-level call missing");
assert(relations.some((relation) =>
  relation.type === "calls" &&
  relation.src.includes("symbol:raw/repos/demo/python/service.py:function:run_service") &&
  relation.dst.includes("symbol:raw/repos/demo/python/helpers.py:function:transform")
), "Python symbol-level call missing");
assert(relations.some((relation) =>
  relation.type === "tested_by" &&
  relation.src.includes("symbol:raw/repos/demo/python/service.py:function:run_service")
), "Python symbol-level tested_by missing");
assert(doc.diagnostics.files_seen === 16, "expected sixteen fixture files");
assert(doc.diagnostics.files_parsed === 15, "expected fifteen parsed files");
assert(doc.diagnostics.files_failed === 0, "no fixture file should fail to read");
assert(doc.diagnostics.truncated.includes("raw/repos/demo/bad/large.ts"), "large file should be truncated");
assert(doc.diagnostics.parse_errors.some((item) =>
  item.raw_path === "raw/repos/demo/bad/package.json" &&
  item.parser === "json-manifest"
), "malformed package.json parse error missing");
assert(part.version === 1, "partial graph version should be 1");
assert(part.leaf_path === "raw/repos/demo/", "partial graph leaf path should match facts");
assert(Array.isArray(part.nodes) && part.nodes.length > 0, "partial graph nodes missing");
assert(Array.isArray(part.edges) && part.edges.length > 0, "partial graph edges missing");
assert(part.nodes.some((node) => node.id === "project:demo"), "partial graph project missing");
assert(part.edges.some((edge) => edge.type === "handles_route"), "partial graph route edge missing");
assert(part.edges.some((edge) => edge.type === "calls"), "partial graph call edge missing");
assert(part.edges.every((edge) => edge.src && edge.dst), "partial graph edge endpoint missing");

const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
const graphEdges = graph.edges;
assert(graph.version === 1, "merged graph version should be 1");
assert(graph.source === "clio-graph-parts", "merged graph source should be set");
assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, "merged graph nodes missing");
assert(Array.isArray(graph.edges) && graph.edges.length > 0, "merged graph edges missing");
assert(Array.isArray(graph.communities) && graph.communities.length > 0, "communities missing");
assert(graph.nodes.every((node) => Number.isFinite(node.centrality)), "node centrality missing");
assert(graph.nodes.every((node) => node.community), "node community missing");
assert(graphEdges.every((edge) => graphNodeIds.has(edge.src) && graphNodeIds.has(edge.dst)), "dangling merged graph edge");
assert(graphEdges.some((edge) =>
  edge.type === "contains" &&
  edge.src === "project:demo" &&
  edge.dst === "module:demo:repos/demo"
), "structure query edge missing");
assert(graphEdges.some((edge) =>
  edge.type === "calls" &&
  edge.src.includes("symbol:raw/repos/demo/app/api/items/route.ts:function:GET") &&
  edge.dst.includes("symbol:raw/repos/demo/lib/items.ts:function:loadItems")
), "impact query call edge missing");
assert(graphEdges.some((edge) =>
  edge.type === "handles_route" &&
  edge.src.startsWith("route:demo:GET:") &&
  edge.dst.includes("symbol:raw/repos/demo/app/api/items/route.ts:function:GET")
), "API route query edge missing");
assert(graphEdges.some((edge) =>
  edge.type === "tested_by" &&
  edge.src.includes("symbol:raw/repos/demo/python/service.py:function:run_service")
), "testing query edge missing");
assert(graphEdges.some((edge) =>
  edge.type === "uses_env" &&
  edge.src.includes("symbol:raw/repos/demo/app/api/items/route.ts:function:GET") &&
  edge.dst === "env:demo:ITEM_BUCKET" &&
  edge.source_location?.start_line === 4
), "debugging query env edge missing");
assert(report.includes("## Summary"), "graph report summary missing");
assert(report.includes("Dangling edges dropped: 1"), "graph report should mention dropped dangling edge");
assert(report.includes("Low-confidence edges dropped: 1"), "graph report should mention low-confidence pruning");
assert(report.includes("Min confidence: 0.65"), "graph report should mention active confidence threshold");
assert(report.includes("## New Nodes"), "graph report new nodes section missing");
assert(state.version === 1, "graph state version missing");
assert(state.leaves["raw/repos/demo/"].part_file === "wiki/graph/parts/demo.json", "graph state leaf entry missing");
assert(state.leaves["raw/repos/demo/"].node_count === part.nodes.length, "graph state node count mismatch");
NODE

cat > "${TMP_ROOT}/wiki/concepts/topic.md" <<'MD'
---
title: Topic
type: concept
---

# Topic
MD

cat > "${TMP_ROOT}/wiki/sources/articles/source.md" <<'MD'
---
title: Source
type: source
---

# Source

See [[Topic]].
MD

cat > "${TMP_ROOT}/wiki/graph/parts/page-title.json" <<'JSON'
{
  "version": 1,
  "built_at": "2026-05-30T00:00:00.000Z",
  "leaf_path": "wiki/sources/articles/",
  "leaf_hash": "page-title",
  "source": "test-fixture",
  "nodes": [
    {
      "id": "source-node-alias",
      "label": "Source",
      "type": "source",
      "page_path": "wiki/sources/articles/source.md",
      "sources": ["wiki/sources/articles/source.md"]
    },
    {
      "id": "concepts/topic",
      "label": "Topic",
      "type": "concept",
      "sources": ["wiki/concepts/topic.md"]
    },
    {
      "id": "heading:source:overview",
      "label": "Overview",
      "type": "heading",
      "sources": ["wiki/sources/articles/source.md"]
    },
    {
      "id": "concept:incidental",
      "label": "Incidental extracted concept",
      "type": "concept"
    }
  ],
  "edges": [
    {
      "src": "source-node-alias",
      "dst": "concepts/topic",
      "type": "links_to",
      "weight": 1
    },
    {
      "src": "source-node-alias",
      "dst": "heading:source:overview",
      "type": "mentions",
      "weight": 1
    },
    {
      "src": "concepts/topic",
      "dst": "concept:incidental",
      "type": "related_to",
      "confidence": 0.99,
      "weight": 0.99
    },
    {
      "src": "source-node-alias",
      "dst": "concepts/topic",
      "type": "related_to",
      "confidence": 0.6,
      "weight": 0.6
    }
  ]
}
JSON

(cd "${TMP_ROOT}" && node scripts/merge-graph-parts.mjs \
  --parts wiki/graph/parts \
  --out wiki/graph/page-title-graph.json \
  --report wiki/graph/PAGE_TITLE_REPORT.md \
  --min-confidence 0.65 \
  --semantic-min-confidence 0.72 \
  --state wiki/graph/page-title-state.json >/dev/null)

node - \
  "${TMP_ROOT}/wiki/graph/page-title-graph.json" \
  "${TMP_ROOT}/wiki/graph/PAGE_TITLE_REPORT.md" \
  "${TMP_ROOT}/wiki/graph/page-title-state.json" <<'NODE'
const fs = require("node:fs");
const graph = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const report = fs.readFileSync(process.argv[3], "utf8");
const state = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

const ids = new Set(graph.nodes.map((node) => node.id));
const edgeKeys = new Set(graph.edges.map((edge) => `${edge.src}->${edge.dst}:${edge.type}`));

assert(ids.has("sources/articles/source"), "source page node should be kept");
assert(ids.has("concepts/topic"), "concept page node should be kept");
assert(!ids.has("source-node-alias"), "alias node should be canonicalized to page id");
assert(!ids.has("heading:source:overview"), "heading node should be pruned");
assert(!ids.has("concept:incidental"), "incidental concept node should be pruned");
assert(edgeKeys.has("sources/articles/source->concepts/topic:links_to"), "explicit page link should be kept");
assert(![...edgeKeys].some((key) => key.includes("mentions")), "facet/mention edge should be pruned");
assert(![...edgeKeys].some((key) => key.includes("related_to")), "below-threshold/non-page semantic edges should be pruned");
assert(report.includes("Profile: page-title"), "report should mention page-title profile");
const dropped = Number((report.match(/Non-page nodes dropped: (\d+)/) ?? [])[1]);
assert(dropped > 0, "report should count dropped non-page nodes");
assert(report.includes("Non-page edges dropped:"), "report should count dropped non-page edges");
assert(state.leaves["wiki/sources/articles/"].node_count === 2, "state should record kept page nodes");
assert(state.leaves["wiki/sources/articles/"].raw_node_count === 4, "state should record raw part node count");
NODE

printf '[code-facts] ok\n'
