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
  "${TMP_ROOT}/raw/repos/demo/tests"
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

(cd "${TMP_ROOT}" && node scripts/merge-graph-parts.mjs \
  --parts wiki/graph/parts \
  --out wiki/graph/graph.json \
  --report wiki/graph/GRAPH_REPORT.md >/dev/null)

node - \
  "${TMP_ROOT}/wiki/graph/facts/demo.json" \
  "${TMP_ROOT}/wiki/graph/parts/demo.json" \
  "${TMP_ROOT}/wiki/graph/graph.json" \
  "${TMP_ROOT}/wiki/graph/GRAPH_REPORT.md" <<'NODE'
const fs = require("node:fs");
const factsPath = process.argv[2];
const partPath = process.argv[3];
const finalGraphPath = process.argv[4];
const reportPath = process.argv[5];
const doc = JSON.parse(fs.readFileSync(factsPath, "utf8"));
const part = JSON.parse(fs.readFileSync(partPath, "utf8"));
const graph = JSON.parse(fs.readFileSync(finalGraphPath, "utf8"));
const report = fs.readFileSync(reportPath, "utf8");

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
assert(entityIds.has("module:demo:external:zod"), "package dependency entity missing");
assert(entityIds.has("module:demo:external:serde"), "Cargo dependency entity missing");
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
assert(doc.diagnostics.files_seen === 9, "expected nine fixture files");
assert(doc.diagnostics.files_parsed === 9, "expected nine parsed files");
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
assert(report.includes("Dangling edges dropped: 0"), "graph report should mention no dangling edges");
NODE

printf '[code-facts] ok\n'
