"use client";

import cytoscape from "cytoscape";
import type {
  Core,
  ElementDefinition,
  EventObject,
  StylesheetJson,
} from "cytoscape";
import { useEffect, useMemo, useRef } from "react";
import type { GraphData, GraphNode } from "./types";

type Props = {
  graph: GraphData;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  text: {
    fitGraph: string;
    zoomIn: string;
    zoomOut: string;
  };
};

const COMMUNITY_COLORS = [
  "#7aa2ff",
  "#6ee7b7",
  "#f7c948",
  "#f28f8f",
  "#c084fc",
  "#67e8f9",
  "#f6ad55",
  "#a3e635",
];

function colorForCommunity(community: number | null): string {
  if (community == null) return "#8a93a0";
  return COMMUNITY_COLORS[Math.abs(community) % COMMUNITY_COLORS.length];
}

function nodeSize(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(22, Math.min(52, 26 + centrality * 42));
}

function edgeWidth(weight: number): number {
  return Math.max(1, Math.min(6, weight));
}

function edgeId(
  src: string,
  dst: string,
  type: string | undefined,
  index: number,
) {
  return `${src}::${dst}::${type ?? "edge"}::${index}`;
}

const stylesheet: StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      "border-color": "#0b0d10",
      "border-width": 2,
      color: "#aeb6c2",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
      "font-size": 11,
      height: "data(size)",
      label: "data(label)",
      "min-zoomed-font-size": 8,
      "overlay-opacity": 0,
      "text-background-color": "#0b0d10",
      "text-background-opacity": 0.68,
      "text-background-padding": "2px",
      "text-margin-x": 8,
      "text-valign": "center",
      "text-wrap": "ellipsis",
      "text-max-width": "140px",
      width: "data(size)",
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "line-color": "#3a414c",
      "line-opacity": 0.48,
      "overlay-opacity": 0,
      "target-arrow-color": "#3a414c",
      width: "data(width)",
    },
  },
  {
    selector: ".selected",
    style: {
      "border-color": "#e7ebf0",
      "border-width": 4,
      color: "#e7ebf0",
      "text-background-opacity": 0.9,
      "z-index": 10,
    },
  },
  {
    selector: ".related",
    style: {
      "line-color": "#7aa2ff",
      "line-opacity": 0.82,
      "target-arrow-color": "#7aa2ff",
      opacity: 1,
    },
  },
  {
    selector: ".dimmed",
    style: {
      opacity: 0.18,
    },
  },
];

export default function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  text,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const graphRef = useRef(graph);

  graphRef.current = graph;

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodes: ElementDefinition[] = graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label:
          node.label.length > 38 ? `${node.label.slice(0, 37)}...` : node.label,
        color: colorForCommunity(node.community),
        size: nodeSize(node),
      },
    }));
    const edges: ElementDefinition[] = graph.edges.map((edge, index) => ({
      data: {
        id: edgeId(edge.src, edge.dst, edge.type, index),
        source: edge.src,
        target: edge.dst,
        width: edgeWidth(edge.weight),
      },
    }));
    return [...nodes, ...edges];
  }, [graph]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || graph.nodes.length === 0) return;

    const cy = cytoscape({
      container,
      elements,
      maxZoom: 3.5,
      minZoom: 0.08,
      style: stylesheet,
      wheelSensitivity: 0.18,
      layout: {
        name: graph.nodes.length > 1 ? "cose" : "grid",
        animate: false,
        componentSpacing: 110,
        fit: true,
        idealEdgeLength: 110,
        nodeOverlap: 12,
        nodeRepulsion: 5200,
        padding: 46,
      },
    });

    cyRef.current = cy;
    cy.on("tap", "node", (event: EventObject) => {
      const id = event.target.id();
      const node = graphRef.current.nodes.find(
        (candidate) => candidate.id === id,
      );
      if (node) onSelect(node);
    });

    const keepBrowserZoomOut = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    container.addEventListener("wheel", keepBrowserZoomOut, { passive: false });

    return () => {
      container.removeEventListener("wheel", keepBrowserZoomOut);
      cy.destroy();
      if (cyRef.current === cy) cyRef.current = null;
    };
  }, [elements, graph.nodes.length, onSelect]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("selected related dimmed");
    if (!selectedId) return;
    const selected = cy.getElementById(selectedId);
    if (selected.empty()) return;
    const related = selected.closedNeighborhood();
    related.addClass("related");
    selected.addClass("selected");
    cy.elements().difference(related).addClass("dimmed");
  }, [selectedId]);

  function fit() {
    cyRef.current?.fit(undefined, 46);
  }

  function zoomBy(factor: number) {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: Math.max(
        cy.minZoom(),
        Math.min(cy.maxZoom(), cy.zoom() * factor),
      ),
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2,
      },
    });
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">
        graph.json에 노드가 없습니다.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute right-3 top-3 flex overflow-hidden rounded border border-line bg-bg-subtle/95 shadow-lg">
        <button
          type="button"
          onClick={() => zoomBy(1.18)}
          title={text.zoomIn}
          className="h-8 w-8 border-r border-line text-sm text-ink-dim hover:bg-bg-panel hover:text-ink"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(0.84)}
          title={text.zoomOut}
          className="h-8 w-8 border-r border-line text-sm text-ink-dim hover:bg-bg-panel hover:text-ink"
        >
          -
        </button>
        <button
          type="button"
          onClick={fit}
          className="h-8 px-2.5 text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink"
        >
          {text.fitGraph}
        </button>
      </div>
    </div>
  );
}
