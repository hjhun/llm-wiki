"use client";

import cytoscape from "cytoscape";
import type {
  Core,
  ElementDefinition,
  EventObject,
  StylesheetJson,
} from "cytoscape";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { IconButton } from "../ui";
import { useLanguage } from "../i18n";
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
  { fill: "#8b8df7", border: "#c2c4ff", halo: "#8b8df7", edge: "#6f7397" },
  { fill: "#53c7a5", border: "#a3f3d8", halo: "#53c7a5", edge: "#5f8d80" },
  { fill: "#f2b56b", border: "#ffdba2", halo: "#f2b56b", edge: "#9a8161" },
  { fill: "#e46e9f", border: "#ffb5d0", halo: "#e46e9f", edge: "#9b6b7e" },
  { fill: "#68c5df", border: "#b8edf8", halo: "#68c5df", edge: "#668d99" },
  { fill: "#c4d867", border: "#edf7ad", halo: "#c4d867", edge: "#858f61" },
  { fill: "#f0835d", border: "#ffc4aa", halo: "#f0835d", edge: "#9a7162" },
  { fill: "#a7b1c2", border: "#d5dce8", halo: "#a7b1c2", edge: "#717987" },
];

type NodeVisual = {
  color: string;
  borderColor: string;
  edgeColor: string;
  haloColor: string;
  labelColor: string;
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
    labelColor: "#d8dde7",
  };
}

function nodeSize(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(9, Math.min(30, 10 + centrality * 28));
}

function labelSize(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(10, Math.min(12.5, 10 + centrality * 2.8));
}

function edgeWidth(weight: number): number {
  return Math.max(0.55, Math.min(2.8, 0.55 + weight * 0.42));
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
      "border-opacity": 0.82,
      "border-width": 1.2,
      color: "data(labelColor)",
      "font-family":
        "ui-sans-serif, Pretendard, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "font-size": "data(labelSize)",
      "font-weight": 520,
      height: "data(size)",
      label: "data(label)",
      "min-zoomed-font-size": 9,
      "overlay-opacity": 0,
      opacity: 0.92,
      shape: "ellipse",
      "shadow-blur": 9,
      "shadow-color": "data(haloColor)",
      "shadow-opacity": 0.2,
      "shadow-offset-x": 0,
      "shadow-offset-y": 0,
      "text-background-opacity": 0,
      "text-halign": "center",
      "text-margin-y": 9,
      "text-outline-color": "#101216",
      "text-outline-opacity": 0.86,
      "text-outline-width": 2,
      "text-valign": "bottom",
      "text-wrap": "ellipsis",
      "text-max-width": "132px",
      width: "data(size)",
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "haystack",
      "haystack-radius": 0.64,
      "line-color": "data(edgeColor)",
      "line-opacity": 0.26,
      "overlay-opacity": 0,
      width: "data(width)",
    },
  },
  {
    selector: ".selected",
    style: {
      "border-color": "#f8fafc",
      "border-width": 2.4,
      color: "#ffffff",
      label: "data(fullLabel)",
      "shadow-blur": 30,
      "shadow-color": "data(haloColor)",
      "shadow-opacity": 0.84,
      "text-outline-opacity": 0.95,
      "z-index": 20,
    },
  },
  {
    selector: "node.related",
    style: {
      "border-color": "data(borderColor)",
      "border-opacity": 1,
      label: "data(fullLabel)",
      "shadow-blur": 18,
      "shadow-opacity": 0.46,
      opacity: 1,
      "z-index": 12,
    },
  },
  {
    selector: "edge.related",
    style: {
      "line-color": "data(edgeTargetColor)",
      "line-opacity": 0.78,
      opacity: 1,
      width: "mapData(width, 0.55, 2.8, 1.5, 4.2)",
      "z-index": 8,
    },
  },
  {
    selector: ".dimmed",
    style: {
      opacity: 0.18,
    },
  },
] as unknown as StylesheetJson;

function truncateLabel(label: string, max = 30): string {
  return label.length > max ? `${label.slice(0, max - 1)}...` : label;
}

function labeledNodeIds(nodes: GraphNode[]): Set<string> {
  if (nodes.length <= 70) return new Set(nodes.map((node) => node.id));
  const count = Math.min(42, Math.max(16, Math.round(nodes.length * 0.16)));
  return new Set(
    [...nodes]
      .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))
      .slice(0, count)
      .map((node) => node.id),
  );
}

export default function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  text,
}: Props) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const graphRef = useRef(graph);

  graphRef.current = graph;

  const elements = useMemo<ElementDefinition[]>(() => {
    const visualById = new Map(
      graph.nodes.map((node) => [node.id, visualForNode(node)]),
    );
    const labelIds = labeledNodeIds(graph.nodes);
    const nodes: ElementDefinition[] = graph.nodes.map((node) => {
      const visual = visualById.get(node.id) ?? visualForNode(node);
      return {
        data: {
          id: node.id,
          label: labelIds.has(node.id) ? truncateLabel(node.label) : "",
          fullLabel: truncateLabel(node.label, 42),
          color: visual.color,
          borderColor: visual.borderColor,
          edgeColor: visual.edgeColor,
          haloColor: visual.haloColor,
          labelColor: visual.labelColor,
          labelSize: labelSize(node),
          size: nodeSize(node),
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
        componentSpacing: 118,
        fit: true,
        idealEdgeLength: 104,
        nodeOverlap: 8,
        nodeRepulsion: 7400,
        padding: 64,
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
    cy.animate(
      {
        center: { eles: selected },
        zoom: Math.max(cy.zoom(), Math.min(1.35, cy.maxZoom())),
      },
      { duration: 240 },
    );
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
        {t.graph.noNodes}
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#101216]"
      style={{
        backgroundImage:
          "linear-gradient(rgb(255 255 255 / 0.022) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.018) 1px, transparent 1px)",
        backgroundRepeat: "no-repeat",
        backgroundSize: "36px 36px",
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-[#17191f]/82 px-3 py-2 shadow-xl shadow-black/20 backdrop-blur-md">
        <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
          {text.graphLegend}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-slate-300">
          <LegendItem color="#8b8df7" label={text.entityNode} />
          <LegendItem color="#53c7a5" label={text.conceptNode} />
          <LegendItem color="#f2b56b" label={text.sourceNode} />
          <LegendItem
            color="#e46e9f"
            label={text.analysisNode}
          />
        </div>
      </div>
      <div className="absolute right-3 top-3 flex gap-1 rounded-md border border-white/10 bg-[#17191f]/82 p-1 shadow-xl shadow-black/30 backdrop-blur-md">
        <IconButton
          icon={ZoomIn}
          label={text.zoomIn}
          onClick={() => zoomBy(1.18)}
          className="border-transparent bg-transparent text-slate-300 hover:bg-white/10 hover:text-white"
        />
        <IconButton
          icon={ZoomOut}
          label={text.zoomOut}
          onClick={() => zoomBy(0.84)}
          className="border-transparent bg-transparent text-slate-300 hover:bg-white/10 hover:text-white"
        />
        <IconButton
          icon={Maximize2}
          label={text.fitGraph}
          onClick={fit}
          className="border-transparent bg-transparent text-slate-300 hover:bg-white/10 hover:text-white"
        />
      </div>
    </div>
  );
}

function LegendItem({
  color,
  label,
}: {
  color: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/35"
        style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}66` }}
      />
      <span className="whitespace-nowrap">{label}</span>
    </div>
  );
}
