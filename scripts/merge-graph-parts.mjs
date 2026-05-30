#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error(
    [
      "Usage: node scripts/merge-graph-parts.mjs",
      "  [--parts wiki/graph/parts]",
      "  [--out wiki/graph/graph.json]",
      "  [--report wiki/graph/GRAPH_REPORT.md]",
      "  [--state wiki/graph/.state.json]",
      "  [--min-confidence 0.65]",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const partsDir = option("--parts", "wiki/graph/parts");
const outPath = option("--out", "wiki/graph/graph.json");
const reportPath = option("--report", "wiki/graph/GRAPH_REPORT.md");
const statePath = option("--state", null);
const minConfidenceRaw = option("--min-confidence", "0");
const minConfidence = Number(minConfidenceRaw);

if (
  (args.includes("--parts") && !option("--parts", null)) ||
  (args.includes("--out") && !option("--out", null)) ||
  (args.includes("--report") && !option("--report", null)) ||
  (args.includes("--state") && !option("--state", null)) ||
  !Number.isFinite(minConfidence)
) {
  usage();
  process.exit(2);
}

const cwd = process.cwd();
const toPosix = (value) => value.split(path.sep).join("/");
const unique = (values) => [...new Set(values.filter(Boolean))];

async function readJson(file) {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text);
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return null;
  }
}

async function partFiles(dir) {
  const abs = path.resolve(cwd, dir);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(abs, entry.name))
    .sort();
}

function mergeNode(existing, next) {
  return {
    ...existing,
    ...next,
    tags: unique([...(existing.tags ?? []), ...(next.tags ?? [])]),
    sources: unique([...(existing.sources ?? []), ...(next.sources ?? [])]),
    aliases: unique([...(existing.aliases ?? []), ...(next.aliases ?? [])]),
    metadata: {
      ...(existing.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
  };
}

function edgeKey(edge) {
  return `${edge.src}\0${edge.dst}\0${edge.type ?? "links_to"}`;
}

function mergeEdge(existing, next) {
  return {
    ...existing,
    ...next,
    type: existing.type ?? next.type ?? "links_to",
    weight: (existing.weight ?? 1) + (next.weight ?? 1),
    sources: unique([...(existing.sources ?? []), ...(next.sources ?? [])]),
    metadata: {
      ...(existing.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
  };
}

function connectedComponents(nodes, edges) {
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    neighbors.get(edge.src)?.add(edge.dst);
    neighbors.get(edge.dst)?.add(edge.src);
  }

  const seen = new Set();
  const components = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const ids = [];
    seen.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop();
      ids.push(id);
      for (const next of neighbors.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(ids);
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function assignGraphMetrics(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }

  const components = connectedComponents(nodes, edges);
  const communities = components.map((ids, index) => {
    const representative = [...ids].sort((a, b) =>
      (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
    )[0];
    const node = byId.get(representative);
    return {
      id: index + 1,
      label: node?.label ?? representative,
      size: ids.length,
      nodes: ids.slice(0, 12),
    };
  });

  const communityByNode = new Map();
  for (const community of communities) {
    for (const id of components[community.id - 1] ?? []) {
      communityByNode.set(id, community.id);
    }
  }

  const divisor = Math.max(1, nodes.length - 1);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      community: communityByNode.get(node.id) ?? null,
      centrality: Number(((degree.get(node.id) ?? 0) / divisor).toFixed(6)),
    })),
    communities,
  };
}

function graphReport(graph, stats) {
  const topNodes = [...graph.nodes]
    .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 10);
  const isolated = graph.nodes
    .filter((node) => (node.centrality ?? 0) === 0)
    .slice(0, 20);

  return `${[
    "# Graph Report",
    "",
    "## Summary",
    "",
    `- Built at: ${graph.built_at}`,
    `- Parts read: ${stats.partsRead}`,
    `- Nodes: ${graph.nodes.length}`,
    `- Edges: ${graph.edges.length}`,
    `- Communities: ${graph.communities.length}`,
    `- Dangling edges dropped: ${stats.danglingEdgesDropped}`,
    `- Low-confidence edges dropped: ${stats.lowConfidenceEdgesDropped}`,
    "",
    "## God Nodes",
    "",
    ...topNodes.map((node) =>
      `- ${node.label ?? node.id} (${node.id}) - centrality ${node.centrality ?? 0}`,
    ),
    "",
    "## New Nodes",
    "",
    ...(
      stats.newNodes.length > 0
        ? stats.newNodes.slice(0, 50).map((node) => `- ${node.label ?? node.id} (${node.id})`)
        : ["- None"]
    ),
    "",
    "## Communities",
    "",
    ...graph.communities.map((community) =>
      `- #${community.id} ${community.label} - ${community.size} nodes`,
    ),
    "",
    "## Extraction Budget",
    "",
    "- Profile: code facts partial merge",
    `- Min confidence: ${stats.minConfidence}`,
    `- Nodes kept: ${graph.nodes.length}`,
    `- Edges kept: ${graph.edges.length}`,
    `- Edges pruned: ${stats.danglingEdgesDropped + stats.lowConfidenceEdgesDropped}`,
    "",
    "## Isolated Nodes",
    "",
    ...(
      isolated.length > 0
        ? isolated.map((node) => `- ${node.label ?? node.id} (${node.id})`)
        : ["- None"]
    ),
  ].join("\n")}\n`;
}

async function main() {
  const files = await partFiles(partsDir);
  const outAbs = path.resolve(cwd, outPath);
  const previousGraph = await readJsonIfExists(outAbs);
  const previousNodeIds = new Set(
    Array.isArray(previousGraph?.nodes)
      ? previousGraph.nodes.map((node) => node.id).filter(Boolean)
      : [],
  );
  const nodes = new Map();
  const edges = new Map();
  const leafState = {};
  let danglingEdgesDropped = 0;
  let lowConfidenceEdgesDropped = 0;

  for (const file of files) {
    const part = await readJson(file);
    const partNodes = Array.isArray(part.nodes) ? part.nodes : [];
    const partEdges = Array.isArray(part.edges)
      ? part.edges
      : Array.isArray(part.links)
        ? part.links
        : [];
    const relPartFile = toPosix(path.relative(cwd, file));
    const leafPath = part.leaf_path ?? relPartFile;
    leafState[leafPath] = {
      built_at: part.built_at ?? new Date().toISOString(),
      content_hash: part.leaf_hash ?? null,
      part_file: relPartFile,
      node_count: partNodes.length,
      edge_count: partEdges.length,
    };

    for (const node of partNodes) {
      if (!node?.id) continue;
      nodes.set(node.id, nodes.has(node.id) ? mergeNode(nodes.get(node.id), node) : node);
    }
    for (const edge of partEdges) {
      if (!edge?.src || !edge?.dst) continue;
      const key = edgeKey(edge);
      edges.set(key, edges.has(key) ? mergeEdge(edges.get(key), edge) : edge);
    }
  }

  const nodeIds = new Set(nodes.keys());
  const validEdges = [];
  for (const edge of edges.values()) {
    const confidence = edge.confidence ?? edge.weight ?? 1;
    if (confidence < minConfidence) {
      lowConfidenceEdgesDropped += 1;
      continue;
    }
    if (!nodeIds.has(edge.src) || !nodeIds.has(edge.dst)) {
      danglingEdgesDropped += 1;
      continue;
    }
    validEdges.push(edge);
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = validEdges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const { nodes: measuredNodes, communities } = assignGraphMetrics(sortedNodes, sortedEdges);
  const graph = {
    version: 1,
    built_at: new Date().toISOString(),
    source: "clio-graph-parts",
    nodes: measuredNodes,
    edges: sortedEdges,
    communities,
  };
  const newNodes = graph.nodes.filter((node) => !previousNodeIds.has(node.id));

  const reportAbs = path.resolve(cwd, reportPath);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.mkdir(path.dirname(reportAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await fs.writeFile(reportAbs, graphReport(graph, {
    partsRead: files.length,
    danglingEdgesDropped,
    lowConfidenceEdgesDropped,
    minConfidence,
    newNodes,
  }), "utf8");

  if (statePath) {
    const stateAbs = path.resolve(cwd, statePath);
    await fs.mkdir(path.dirname(stateAbs), { recursive: true });
    await fs.writeFile(stateAbs, `${JSON.stringify({
      version: 1,
      updated_at: graph.built_at,
      graph_file: toPosix(path.relative(cwd, outAbs)),
      report_file: toPosix(path.relative(cwd, reportAbs)),
      parts_dir: toPosix(path.relative(cwd, path.resolve(cwd, partsDir))),
      leaves: leafState,
    }, null, 2)}\n`, "utf8");
  }

  process.stdout.write(
    [
      `graph: ${toPosix(path.relative(cwd, outAbs))}`,
      `report: ${toPosix(path.relative(cwd, reportAbs))}`,
      `nodes: ${graph.nodes.length}`,
      `edges: ${graph.edges.length}`,
      `communities: ${graph.communities.length}`,
    ].join("\n") + "\n",
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
