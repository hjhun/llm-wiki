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
  218, 162, 44, 6, 282, 187, 29, 96, 334, 256, 142, 52, 205, 312, 116, 16,
];

type NodeVisual = {
  color: string;
  borderColor: string;
  haloColor: string;
  labelColor: string;
  shape: "ellipse" | "diamond" | "round-rectangle" | "hexagon" | "tag";
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`;
}

function shapeForNode(node: GraphNode): NodeVisual["shape"] {
  const type = (node.type ?? "").toLowerCase();
  if (type.includes("source") || type.includes("document")) return "tag";
  if (type.includes("entity") || type.includes("person")) return "ellipse";
  if (type.includes("concept") || type.includes("topic")) return "diamond";
  if (type.includes("analysis") || type.includes("comparison")) {
    return "round-rectangle";
  }
  return "hexagon";
}

function visualForNode(node: GraphNode): NodeVisual {
  const hash = hashString(`${node.id}:${node.type ?? ""}`);
  const baseHue =
    node.community == null
      ? hash % 360
      : COMMUNITY_COLORS[Math.abs(node.community) % COMMUNITY_COLORS.length];
  const hue = (baseHue + (hash % 29) - 14 + 360) % 360;
  const saturation = 63 + (hash % 17);
  const lightness = 52 + ((hash >> 5) % 10);

  return {
    color: hsl(hue, saturation, lightness),
    borderColor: hsl(hue, Math.min(94, saturation + 12), 78),
    haloColor: hsl(hue, Math.min(88, saturation + 8), 62),
    labelColor: "#f8fafc",
    shape: shapeForNode(node),
  };
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

const stylesheet = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      "border-color": "data(borderColor)",
      "border-opacity": 0.95,
      "border-width": 2.6,
      color: "data(labelColor)",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
      "font-size": 12,
      "font-weight": 600,
      height: "data(size)",
      label: "data(label)",
      "min-zoomed-font-size": 8,
      "overlay-opacity": 0,
      shape: "data(shape)",
      "shadow-blur": 16,
      "shadow-color": "data(haloColor)",
      "shadow-opacity": 0.42,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
      "text-background-color": "#111827",
      "text-background-opacity": 0.86,
      "text-background-padding": "3px",
      "text-margin-x": 8,
      "text-outline-color": "#020617",
      "text-outline-opacity": 0.78,
      "text-outline-width": 1.2,
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
      "line-color": "data(edgeColor)",
      "line-opacity": 0.54,
      "overlay-opacity": 0,
      "target-arrow-color": "data(edgeTargetColor)",
      width: "data(width)",
    },
  },
  {
    selector: ".selected",
    style: {
      "border-color": "#e7ebf0",
      "border-width": 4.5,
      color: "#ffffff",
      "shadow-blur": 28,
      "shadow-opacity": 0.76,
      "text-background-color": "#020617",
      "text-background-opacity": 0.95,
      "z-index": 10,
    },
  },
  {
    selector: "node.related",
    style: {
      "border-color": "data(borderColor)",
      "border-opacity": 1,
      "shadow-blur": 22,
      "shadow-opacity": 0.58,
      opacity: 1,
    },
  },
  {
    selector: "edge.related",
    style: {
      "line-color": "data(edgeTargetColor)",
      "line-opacity": 0.82,
      "target-arrow-color": "data(edgeTargetColor)",
      opacity: 1,
      width: "mapData(width, 1, 6, 2, 8)",
    },
  },
  {
    selector: ".dimmed",
    style: {
      opacity: 0.26,
    },
  },
] as unknown as StylesheetJson;

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
    const visualById = new Map(
      graph.nodes.map((node) => [node.id, visualForNode(node)]),
    );
    const nodes: ElementDefinition[] = graph.nodes.map((node) => {
      const visual = visualById.get(node.id) ?? visualForNode(node);
      return {
        data: {
          id: node.id,
          label:
            node.label.length > 38
              ? `${node.label.slice(0, 37)}...`
              : node.label,
          color: visual.color,
          borderColor: visual.borderColor,
          haloColor: visual.haloColor,
          labelColor: visual.labelColor,
          shape: visual.shape,
          size: nodeSize(node),
        },
      };
    });
    const edges: ElementDefinition[] = graph.edges.map((edge, index) => ({
      data: {
        id: edgeId(edge.src, edge.dst, edge.type, index),
        source: edge.src,
        target: edge.dst,
        edgeColor: visualById.get(edge.src)?.haloColor ?? "#3a414c",
        edgeTargetColor: visualById.get(edge.dst)?.haloColor ?? "#7aa2ff",
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
    <div
      className="relative h-full w-full overflow-hidden bg-bg"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgb(64 72 86 / 0.52) 1px, transparent 0), linear-gradient(135deg, rgb(15 18 24), rgb(21 25 32))",
        backgroundRepeat: "repeat, no-repeat",
        backgroundSize: "22px 22px, auto",
      }}
    >
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
