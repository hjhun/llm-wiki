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

node - "${TMP_ROOT}/wiki/graph/facts/demo.json" "${TMP_ROOT}/wiki/graph/parts/demo.json" <<'NODE'
const fs = require("node:fs");
const factsPath = process.argv[2];
const graphPath = process.argv[3];
const doc = JSON.parse(fs.readFileSync(factsPath, "utf8"));
const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

const entityIds = new Set(doc.entities.map((entity) => entity.id));
const relationTypes = new Set(doc.relations.map((relation) => relation.type));

assert(doc.version === 1, "version should be 1");
assert(doc.leaf_path === "raw/repos/demo/", "leaf path should be preserved");
assert(doc.project === "demo", "project should be inferred from raw/repos/<name>");
assert(entityIds.has("project:demo"), "project entity missing");
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
assert(doc.diagnostics.files_seen === 7, "expected seven fixture files");
assert(doc.diagnostics.files_parsed === 7, "expected seven parsed files");
assert(graph.version === 1, "graph version should be 1");
assert(graph.leaf_path === "raw/repos/demo/", "graph leaf path should match facts");
assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, "graph nodes missing");
assert(Array.isArray(graph.edges) && graph.edges.length > 0, "graph edges missing");
assert(graph.nodes.some((node) => node.id === "project:demo"), "graph project missing");
assert(graph.edges.some((edge) => edge.type === "handles_route"), "graph route edge missing");
assert(graph.edges.some((edge) => edge.type === "calls"), "graph call edge missing");
assert(graph.edges.every((edge) => edge.src && edge.dst), "graph edge endpoint missing");
NODE

printf '[code-facts] ok\n'
