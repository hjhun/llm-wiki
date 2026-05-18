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
    analysisNode: string;
    conceptNode: string;
    entityNode: string;
    fitGraph: string;
    graphLegend: string;
    sourceNode: string;
    zoomIn: string;
    zoomOut: string;
  };
};

const COMMUNITY_COLORS = [
  { fill: "#5b8def", border: "#9ab9ff", halo: "#6fa3ff", edge: "#6f8fbd" },
  { fill: "#37a98b", border: "#8de4ca", halo: "#58cfb0", edge: "#5da697" },
  { fill: "#d18a3d", border: "#f2c078", halo: "#e6a24d", edge: "#b99160" },
  { fill: "#b873d9", border: "#ddb4f2", halo: "#c68fea", edge: "#a985b9" },
  { fill: "#d96880", border: "#f4a9b8", halo: "#ec7e94", edge: "#b77f8d" },
  { fill: "#6fb6c9", border: "#a9e2ee", halo: "#7fd1e6", edge: "#6fa5b0" },
  { fill: "#a0a86b", border: "#d8dfa5", halo: "#c3cc7e", edge: "#9da36f" },
  { fill: "#8d96a8", border: "#c8d0de", halo: "#aab5c7", edge: "#8792a3" },
];

type NodeVisual = {
  color: string;
  borderColor: string;
  edgeColor: string;
  haloColor: string;
  labelColor: string;
  shape:
    | "ellipse"
    | "round-diamond"
    | "round-rectangle"
    | "round-hexagon"
    | "round-tag";
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shapeForNode(node: GraphNode): NodeVisual["shape"] {
  const type = (node.type ?? "").toLowerCase();
  if (type.includes("source") || type.includes("document")) return "round-tag";
  if (type.includes("entity") || type.includes("person")) return "ellipse";
  if (type.includes("concept") || type.includes("topic")) {
    return "round-diamond";
  }
  if (type.includes("analysis") || type.includes("comparison")) {
    return "round-rectangle";
  }
  return "round-hexagon";
}

function visualForNode(node: GraphNode): NodeVisual {
  const hash = hashString(`${node.id}:${node.type ?? ""}`);
  const paletteIndex =
    node.community == null
      ? hash % COMMUNITY_COLORS.length
      : Math.abs(node.community) % COMMUNITY_COLORS.length;
  const palette = COMMUNITY_COLORS[paletteIndex];

  return {
    color: palette.fill,
    borderColor: palette.border,
    edgeColor: palette.edge,
    haloColor: palette.halo,
    labelColor: "#f8fafc",
    shape: shapeForNode(node),
  };
}

function nodeSize(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(22, Math.min(48, 25 + centrality * 34));
}

function nodeWidth(node: GraphNode): number {
  const base = nodeSize(node);
  const type = (node.type ?? "").toLowerCase();
  if (type.includes("source") || type.includes("document")) return base * 1.36;
  if (type.includes("analysis") || type.includes("comparison")) return base * 1.22;
  return base;
}

function nodeHeight(node: GraphNode): number {
  const base = nodeSize(node);
  const type = (node.type ?? "").toLowerCase();
  if (type.includes("source") || type.includes("document")) return base * 0.82;
  if (type.includes("analysis") || type.includes("comparison")) return base * 0.9;
  return base;
}

function labelSize(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(10.5, Math.min(13, 10.8 + centrality * 3));
}

function edgeWidth(weight: number): number {
  return Math.max(0.8, Math.min(4.2, weight * 0.82));
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
      "border-width": 1.8,
      color: "data(labelColor)",
      "font-family":
        "ui-sans-serif, Pretendard, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "font-size": "data(labelSize)",
      "font-weight": 650,
      height: "data(height)",
      label: "data(label)",
      "min-zoomed-font-size": 7,
      "overlay-opacity": 0,
      shape: "data(shape)",
      "shadow-blur": 18,
      "shadow-color": "data(haloColor)",
      "shadow-opacity": 0.32,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
      "text-background-color": "#08111d",
      "text-background-opacity": 0.52,
      "text-background-padding": "3px",
      "text-border-color": "data(haloColor)",
      "text-border-opacity": 0.18,
      "text-border-width": 1,
      "text-halign": "center",
      "text-margin-x": 9,
      "text-margin-y": 8,
      "text-outline-color": "#050910",
      "text-outline-opacity": 0.62,
      "text-outline-width": 1,
      "text-valign": "bottom",
      "text-wrap": "ellipsis",
      "text-max-width": "150px",
      width: "data(width)",
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "line-color": "data(edgeColor)",
      "line-opacity": 0.42,
      "overlay-opacity": 0,
      "target-arrow-shape": "triangle",
      "target-arrow-color": "data(edgeTargetColor)",
      "target-arrow-fill": "filled",
      "arrow-scale": 0.72,
      width: "data(width)",
    },
  },
  {
    selector: ".selected",
    style: {
      "border-color": "#f8fafc",
      "border-width": 3.2,
      color: "#ffffff",
      "shadow-blur": 36,
      "shadow-color": "data(haloColor)",
      "shadow-opacity": 0.78,
      "text-background-color": "#07111f",
      "text-background-opacity": 0.84,
      "text-border-opacity": 0.44,
      "z-index": 10,
    },
  },
  {
    selector: "node.related",
    style: {
      "border-color": "data(borderColor)",
      "border-opacity": 1,
      "shadow-blur": 24,
      "shadow-opacity": 0.48,
      opacity: 1,
    },
  },
  {
    selector: "edge.related",
    style: {
      "line-color": "data(edgeTargetColor)",
      "line-opacity": 0.76,
      "target-arrow-color": "data(edgeTargetColor)",
      opacity: 1,
      width: "mapData(width, 0.8, 4.2, 1.8, 6.2)",
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
          edgeColor: visual.edgeColor,
          haloColor: visual.haloColor,
          labelColor: visual.labelColor,
          labelSize: labelSize(node),
          shape: visual.shape,
          height: nodeHeight(node),
          width: nodeWidth(node),
        },
      };
    });
    const edges: ElementDefinition[] = graph.edges.map((edge, index) => ({
      data: {
        id: edgeId(edge.src, edge.dst, edge.type, index),
        source: edge.src,
        target: edge.dst,
        edgeColor: visualById.get(edge.src)?.edgeColor ?? "#526071",
        edgeTargetColor: visualById.get(edge.dst)?.haloColor ?? "#8fb3ff",
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
        componentSpacing: 126,
        fit: true,
        idealEdgeLength: 128,
        nodeOverlap: 16,
        nodeRepulsion: 6200,
        padding: 58,
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
          "radial-gradient(circle at 18% 16%, rgb(91 141 239 / 0.18), transparent 28%), radial-gradient(circle at 82% 72%, rgb(55 169 139 / 0.13), transparent 34%), linear-gradient(135deg, rgb(7 12 20), rgb(13 18 27) 48%, rgb(8 13 20))",
        backgroundRepeat: "no-repeat",
        backgroundSize: "auto",
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.17]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(148 163 184 / 0.18) 1px, transparent 1px), linear-gradient(90deg, rgb(148 163 184 / 0.18) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage:
            "radial-gradient(circle at 50% 46%, black, transparent 78%)",
        }}
      />
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-white/10 bg-slate-950/62 px-3 py-2 shadow-xl shadow-black/20 backdrop-blur-md">
        <div className="mb-1.5 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          {text.graphLegend}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-slate-300">
          <LegendItem color="#5b8def" shape="ellipse" label={text.entityNode} />
          <LegendItem color="#37a98b" shape="diamond" label={text.conceptNode} />
          <LegendItem color="#d18a3d" shape="tag" label={text.sourceNode} />
          <LegendItem
            color="#b873d9"
            shape="rectangle"
            label={text.analysisNode}
          />
        </div>
      </div>
      <div className="absolute right-3 top-3 flex overflow-hidden rounded border border-white/10 bg-slate-950/72 shadow-xl shadow-black/30 backdrop-blur-md">
        <button
          type="button"
          onClick={() => zoomBy(1.18)}
          title={text.zoomIn}
          className="h-8 w-8 border-r border-white/10 text-sm text-slate-300 hover:bg-white/10 hover:text-white"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(0.84)}
          title={text.zoomOut}
          className="h-8 w-8 border-r border-white/10 text-sm text-slate-300 hover:bg-white/10 hover:text-white"
        >
          -
        </button>
        <button
          type="button"
          onClick={fit}
          className="h-8 px-2.5 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white"
        >
          {text.fitGraph}
        </button>
      </div>
    </div>
  );
}

function LegendItem({
  color,
  shape,
  label,
}: {
  color: string;
  shape: "ellipse" | "diamond" | "tag" | "rectangle";
  label: string;
}) {
  const shapeClass =
    shape === "ellipse"
      ? "rounded-full"
      : shape === "diamond"
        ? "rotate-45 rounded-[3px]"
        : shape === "tag"
          ? "rounded-r-full rounded-l-[3px]"
          : "rounded-[4px]";

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`h-2.5 w-3.5 shrink-0 border border-white/35 ${shapeClass}`}
        style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}66` }}
      />
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}
