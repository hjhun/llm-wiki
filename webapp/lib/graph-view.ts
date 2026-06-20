import type { GraphData, GraphNode } from "@/components/graph/types";

/**
 * Which slice of the merged knowledge graph the Graph tab is showing.
 * The wiki graph is built only from Markdown under `wiki/`. The Graph tab still
 * lets users focus synthesized code-analysis pages separately when `wiki/code/`
 * pages exist.
 */
export type GraphViewMode = "all" | "wiki" | "code";

export type GraphViewCounts = {
  all: number;
  wiki: number;
  code: number;
};

// A node belongs to the Code Wiki only when its provenance points at a
// synthesized code-analysis page under `wiki/code/`. Raw sources are not graph
// inputs.
const CODE_SOURCE = /^wiki\/code\//;

function isCodeSource(source: string): boolean {
  return CODE_SOURCE.test(source.trim().replace(/^\.?\//, ""));
}

/**
 * Classify a node as belonging to the code or prose subgraph. Provenance is the
 * signal: any `wiki/code/` source (string or resolved document) marks a code
 * node; nodes with no code provenance default to prose.
 */
export function nodeKind(node: GraphNode): "code" | "wiki" {
  for (const source of node.sources) {
    if (isCodeSource(source)) return "code";
  }
  for (const doc of node.documents) {
    if (doc.path && isCodeSource(`wiki/${doc.path}`) && doc.ws === "wiki") {
      return "code";
    }
  }
  return "wiki";
}

/**
 * Project the merged graph down to one view. `all` is the identity; `wiki` and
 * `code` keep only nodes of that kind, drop edges with an endpoint outside the
 * kept set, and recompute community membership/size from the survivors so the
 * inspector's metrics reflect the active tab rather than the whole graph.
 */
export function filterGraph(graph: GraphData, mode: GraphViewMode): GraphData {
  if (mode === "all") return graph;

  const keep = new Set<string>();
  const nodes = graph.nodes.filter((node) => {
    if (nodeKind(node) !== mode) return false;
    keep.add(node.id);
    return true;
  });
  const edges = graph.edges.filter(
    (edge) => keep.has(edge.src) && keep.has(edge.dst),
  );

  const sizeByCommunity = new Map<number, number>();
  for (const node of nodes) {
    if (node.community != null) {
      sizeByCommunity.set(
        node.community,
        (sizeByCommunity.get(node.community) ?? 0) + 1,
      );
    }
  }
  const communities = graph.communities
    .filter((community) => sizeByCommunity.has(community.id))
    .map((community) => ({
      ...community,
      size: sizeByCommunity.get(community.id) ?? community.size,
    }));

  return { ...graph, nodes, edges, communities };
}

/** Node counts per view, for the segmented-tab badges. */
export function graphCounts(graph: GraphData): GraphViewCounts {
  let code = 0;
  for (const node of graph.nodes) {
    if (nodeKind(node) === "code") code += 1;
  }
  return {
    all: graph.nodes.length,
    wiki: graph.nodes.length - code,
    code,
  };
}
