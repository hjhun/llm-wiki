import { describe, expect, it } from "vitest";
import type {
  GraphData,
  GraphDocument,
  GraphEdge,
  GraphNode,
} from "@/components/graph/types";
import { filterGraph, graphCounts, nodeKind } from "./graph-view";

function doc(over: Partial<GraphDocument> = {}): GraphDocument {
  return {
    source: "wiki/sources/x.md",
    label: "x",
    ws: "wiki",
    path: "sources/x.md",
    exists: true,
    text: true,
    previewable: true,
    reason: "ok",
    ...over,
  };
}

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    tags: [],
    sources: [],
    documents: [],
    community: null,
    centrality: null,
    aliases: [],
    ...over,
  };
}

function edge(src: string, dst: string): GraphEdge {
  return { src, dst, weight: 1, sources: [], documents: [] };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): GraphData {
  return { version: 1, builtAt: null, nodes, edges, communities: [] };
}

describe("nodeKind", () => {
  it("classifies wiki/code/ sources as code", () => {
    expect(nodeKind(node("a", { sources: ["wiki/code/proj.md"] }))).toBe(
      "code",
    );
  });

  it("classifies wiki/sources and wiki/concepts as wiki", () => {
    expect(
      nodeKind(node("a", { sources: ["wiki/sources/articles/foo.md"] })),
    ).toBe("wiki");
    expect(nodeKind(node("a", { sources: ["wiki/concepts/bar.md"] }))).toBe(
      "wiki",
    );
  });

  it("defaults sourceless nodes to wiki", () => {
    expect(nodeKind(node("a"))).toBe("wiki");
  });

  it("falls back to resolved documents when sources are bare", () => {
    expect(
      nodeKind(
        node("a", {
          documents: [
            doc({ ws: "wiki", path: "code/proj.md", source: "wiki/code/proj.md" }),
          ],
        }),
      ),
    ).toBe("code");
  });
});

describe("filterGraph", () => {
  const nodes = [
    node("c1", { sources: ["wiki/code/proj.md"], community: 0 }),
    node("c2", { sources: ["wiki/code/proj-architecture.md"], community: 0 }),
    node("w1", { sources: ["wiki/sources/foo.md"], community: 1 }),
    node("w2", { sources: ["wiki/concepts/bar.md"], community: 1 }),
  ];
  const edges = [edge("c1", "c2"), edge("w1", "w2"), edge("c1", "w1")];
  const g = graph(nodes, [...edges]);
  g.communities = [
    { id: 0, label: "code", size: 2 },
    { id: 1, label: "prose", size: 2 },
  ];

  it("returns the graph unchanged for all", () => {
    expect(filterGraph(g, "all")).toBe(g);
  });

  it("keeps only code nodes and intra-code edges", () => {
    const out = filterGraph(g, "code");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["c1", "c2"]);
    // c1->w1 dropped because w1 is filtered out
    expect(out.edges).toHaveLength(1);
    expect(out.communities).toEqual([{ id: 0, label: "code", size: 2 }]);
  });

  it("keeps only wiki nodes and intra-wiki edges", () => {
    const out = filterGraph(g, "wiki");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["w1", "w2"]);
    expect(out.edges).toHaveLength(1);
    expect(out.communities).toEqual([{ id: 1, label: "prose", size: 2 }]);
  });
});

describe("graphCounts", () => {
  it("counts code and wiki nodes", () => {
    const g = graph([
      node("c1", { sources: ["wiki/code/x.md"] }),
      node("w1", { sources: ["wiki/sources/a.md"] }),
      node("w2"),
    ]);
    expect(graphCounts(g)).toEqual({ all: 3, wiki: 2, code: 1 });
  });
});
