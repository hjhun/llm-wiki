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
      "  [--semantic-min-confidence 0.72]",
      "  [--profile page-title|code-facts]",
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
const semanticMinConfidenceRaw = option("--semantic-min-confidence", "0.72");
const semanticMinConfidence = Number(semanticMinConfidenceRaw);
const profile = option("--profile", "page-title");

if (
  (args.includes("--parts") && !option("--parts", null)) ||
  (args.includes("--out") && !option("--out", null)) ||
  (args.includes("--report") && !option("--report", null)) ||
  (args.includes("--state") && !option("--state", null)) ||
  !Number.isFinite(minConfidence) ||
  !Number.isFinite(semanticMinConfidence) ||
  !["page-title", "code-facts"].includes(profile)
) {
  usage();
  process.exit(2);
}

const cwd = process.cwd();
const toPosix = (value) => value.split(path.sep).join("/");
const unique = (values) => [...new Set(values.filter(Boolean))];
const WIKI_PAGE_SOURCE = /^wiki\/.+\.md$/;
const PAGE_ID_PREFIXES = new Set([
  "answers",
  "archive",
  "code",
  "comparisons",
  "concepts",
  "entities",
  "graph",
  "lint",
  "maps",
  "sources",
]);
const EXPLICIT_EDGE_TYPES = new Set([
  "links_to",
  "cites",
  "derived_from",
  "references",
]);
const FACET_EDGE_TYPES = new Set([
  "about",
  "has_claim",
  "has_concept",
  "has_entity",
  "has_project",
  "has_tag",
  "mentions",
]);

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

async function collectWikiPageIds(root = "wiki") {
  const absRoot = path.resolve(cwd, root);
  const ids = new Set();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (toPosix(path.relative(absRoot, abs)).startsWith("graph")) {
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const rel = toPosix(path.relative(cwd, abs));
      const id = pageIdFromWikiPath(rel);
      if (id) ids.add(id);
    }
  }

  await walk(absRoot);
  return ids;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function canonicalWikiPath(value) {
  const source = asString(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!source) return null;
  if (WIKI_PAGE_SOURCE.test(source)) return source;
  if (source.startsWith("wiki/") && !source.endsWith(".md")) {
    return `${source}.md`;
  }
  return null;
}

function pageIdFromWikiPath(value) {
  const source = canonicalWikiPath(value);
  if (!source) return null;
  return source.slice("wiki/".length, -".md".length);
}

function pageIdFromNodeId(id, existingPageIds) {
  const value = asString(id).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value) return null;
  const withoutWiki = value.startsWith("wiki/") ? value.slice("wiki/".length) : value;
  const withoutExt = withoutWiki.endsWith(".md")
    ? withoutWiki.slice(0, -".md".length)
    : withoutWiki;
  const firstSegment = withoutExt.split("/")[0];
  if (withoutExt === "index" || withoutExt === "log") return withoutExt;
  if (!PAGE_ID_PREFIXES.has(firstSegment)) return null;
  if (existingPageIds.size > 0 && !existingPageIds.has(withoutExt)) return null;
  return withoutExt;
}

function pagePathFromNode(node) {
  return (
    canonicalWikiPath(node.page_path) ||
    canonicalWikiPath(node.pagePath) ||
    canonicalWikiPath(node.metadata?.page_path) ||
    canonicalWikiPath(node.metadata?.pagePath) ||
    canonicalWikiPath(node.source_file)
  );
}

function nodeTypeFromPageId(id, fallback) {
  const firstSegment = id.split("/")[0];
  if (firstSegment === "sources") return "source";
  if (firstSegment === "concepts") return "concept";
  if (firstSegment === "entities") return "entity";
  if (firstSegment === "answers") return "answer";
  if (firstSegment === "maps") return "map";
  if (firstSegment === "code") return "code";
  if (firstSegment === "lint") return "lint";
  if (id === "index") return "index";
  if (id === "log") return "log";
  return fallback ?? "page";
}

function normalizePageNode(node, existingPageIds) {
  if (!node?.id) return null;
  const pagePath = pagePathFromNode(node);
  const id = pagePath
    ? pageIdFromWikiPath(pagePath)
    : pageIdFromNodeId(node.id, existingPageIds);
  if (!id) return null;

  const wikiPath = pagePath ?? `wiki/${id}.md`;
  const label =
    asString(node.label) ||
    asString(node.title) ||
    id.split("/").at(-1) ||
    id;
  return {
    ...node,
    id,
    label,
    type: nodeTypeFromPageId(id, node.type),
    page_path: wikiPath,
    sources: unique([
      wikiPath,
      ...asArray(node.sources).filter((item) => typeof item === "string"),
    ]),
    aliases: unique([
      ...asArray(node.aliases).filter((item) => typeof item === "string"),
      node.id !== id ? node.id : "",
    ]),
  };
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
    `- Non-page nodes dropped: ${stats.nonPageNodesDropped}`,
    `- Non-page edges dropped: ${stats.nonPageEdgesDropped}`,
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
    `- Profile: ${stats.profile}`,
    `- Min confidence: ${stats.minConfidence}`,
    `- Semantic min confidence: ${stats.semanticMinConfidence}`,
    `- Nodes kept: ${graph.nodes.length}`,
    `- Edges kept: ${graph.edges.length}`,
    `- Nodes pruned: ${stats.nonPageNodesDropped}`,
    `- Edges pruned: ${
      stats.danglingEdgesDropped +
      stats.lowConfidenceEdgesDropped +
      stats.nonPageEdgesDropped
    }`,
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

function edgeConfidence(edge) {
  const value =
    typeof edge.confidence_score === "number"
      ? edge.confidence_score
      : typeof edge.confidence === "number"
        ? edge.confidence
        : null;
  return value == null || Number.isFinite(value) ? value : null;
}

function keepPageTitleEdge(edge) {
  const type = edge.type ?? "links_to";
  if (EXPLICIT_EDGE_TYPES.has(type)) return true;
  if (FACET_EDGE_TYPES.has(type)) return false;
  if (type !== "related_to" && type !== "semantically_similar_to") {
    return false;
  }
  const confidence = edgeConfidence(edge);
  return confidence != null && confidence >= semanticMinConfidence;
}

function shouldDropLowConfidence(edge) {
  if (profile === "page-title") {
    const type = edge.type ?? "links_to";
    if (EXPLICIT_EDGE_TYPES.has(type)) return false;
    const confidence = edgeConfidence(edge);
    return confidence != null && confidence < minConfidence;
  }
  const confidence = edgeConfidence(edge) ?? edge.weight ?? 1;
  return confidence < minConfidence;
}

function resolveEndpoint(endpoint, nodeIds, endpointAliases, existingPageIds) {
  if (nodeIds.has(endpoint)) return endpoint;
  const aliased = endpointAliases.get(endpoint);
  if (aliased && nodeIds.has(aliased)) return aliased;
  const pageId = pageIdFromNodeId(endpoint, existingPageIds);
  if (pageId && nodeIds.has(pageId)) return pageId;
  return null;
}

async function main() {
  const files = await partFiles(partsDir);
  const existingPageIds = profile === "page-title"
    ? await collectWikiPageIds("wiki")
    : new Set();
  const outAbs = path.resolve(cwd, outPath);
  const previousGraph = await readJsonIfExists(outAbs);
  const previousNodeIds = new Set(
    Array.isArray(previousGraph?.nodes)
      ? previousGraph.nodes.map((node) => node.id).filter(Boolean)
      : [],
  );
  const nodes = new Map();
  const edges = new Map();
  const rawEdges = [];
  const endpointAliases = new Map();
  const leafState = {};
  let danglingEdgesDropped = 0;
  let lowConfidenceEdgesDropped = 0;
  let nonPageNodesDropped = 0;
  let nonPageEdgesDropped = 0;

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

    let keptPartNodes = 0;
    for (const node of partNodes) {
      if (!node?.id) continue;
      const normalized = profile === "page-title"
        ? normalizePageNode(node, existingPageIds)
        : node;
      if (!normalized?.id) {
        nonPageNodesDropped += 1;
        continue;
      }
      endpointAliases.set(node.id, normalized.id);
      nodes.set(
        normalized.id,
        nodes.has(normalized.id)
          ? mergeNode(nodes.get(normalized.id), normalized)
          : normalized,
      );
      keptPartNodes += 1;
    }
    for (const edge of partEdges) {
      if (!edge?.src || !edge?.dst) continue;
      rawEdges.push(edge);
    }
    if (profile === "page-title") {
      leafState[leafPath].node_count = keptPartNodes;
      leafState[leafPath].raw_node_count = partNodes.length;
    }
  }

  const nodeIds = new Set(nodes.keys());
  for (const edge of rawEdges) {
    const src = profile === "page-title"
      ? resolveEndpoint(edge.src, nodeIds, endpointAliases, existingPageIds)
      : edge.src;
    const dst = profile === "page-title"
      ? resolveEndpoint(edge.dst, nodeIds, endpointAliases, existingPageIds)
      : edge.dst;
    if (!src || !dst || src === dst) {
      nonPageEdgesDropped += 1;
      continue;
    }
    const normalizedEdge = {
      ...edge,
      src,
      dst,
      type: edge.type ?? "links_to",
    };
    if (profile === "page-title" && !keepPageTitleEdge(normalizedEdge)) {
      nonPageEdgesDropped += 1;
      continue;
    }
    const key = edgeKey(normalizedEdge);
    edges.set(
      key,
      edges.has(key) ? mergeEdge(edges.get(key), normalizedEdge) : normalizedEdge,
    );
  }

  const validEdges = [];
  for (const edge of edges.values()) {
    if (shouldDropLowConfidence(edge)) {
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
    nonPageNodesDropped,
    nonPageEdgesDropped,
    minConfidence,
    semanticMinConfidence,
    profile,
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
