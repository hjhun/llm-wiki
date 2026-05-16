"use client";

import { useMemo } from "react";
import type { GraphData, GraphNode } from "./types";

type Props = {
  graph: GraphData;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
};

type PositionedNode = GraphNode & {
  x: number;
  y: number;
  r: number;
};

const WIDTH = 920;
const HEIGHT = 560;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

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

function nodeRadius(node: GraphNode): number {
  const centrality = node.centrality ?? 0;
  return Math.max(7, Math.min(18, 8 + centrality * 18));
}

function nodeTitle(node: GraphNode): string {
  const bits = [node.label];
  if (node.type) bits.push(node.type);
  if (node.community != null) bits.push(`community ${node.community}`);
  return bits.join(" · ");
}

export default function GraphCanvas({
  graph,
  selectedId,
  onSelect,
}: Props) {
  const positioned = useMemo<PositionedNode[]>(() => {
    const communityIds = Array.from(
      new Set(graph.nodes.map((node) => node.community ?? -1)),
    ).sort((a, b) => a - b);
    const communityIndex = new Map(
      communityIds.map((id, index) => [id, index]),
    );
    const grouped = new Map<number, GraphNode[]>();
    for (const node of graph.nodes) {
      const key = node.community ?? -1;
      grouped.set(key, [...(grouped.get(key) ?? []), node]);
    }

    return graph.nodes.map((node) => {
      const key = node.community ?? -1;
      const group = grouped.get(key) ?? [node];
      const groupIndex = group.findIndex((item) => item.id === node.id);
      const ringIndex = communityIndex.get(key) ?? 0;
      const groupAngle =
        (2 * Math.PI * ringIndex) / Math.max(communityIds.length, 1) -
        Math.PI / 2;
      const groupCx = CX + Math.cos(groupAngle) * 170;
      const groupCy = CY + Math.sin(groupAngle) * 135;
      const localAngle =
        (2 * Math.PI * groupIndex) / Math.max(group.length, 1) +
        ringIndex * 0.63;
      const localRadius = Math.max(38, Math.min(96, 24 + group.length * 7));
      return {
        ...node,
        x: groupCx + Math.cos(localAngle) * localRadius,
        y: groupCy + Math.sin(localAngle) * localRadius,
        r: nodeRadius(node),
      };
    });
  }, [graph.nodes]);

  const byId = useMemo(() => {
    return new Map(positioned.map((node) => [node.id, node]));
  }, [positioned]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const out = new Set<string>([selectedId]);
    for (const edge of graph.edges) {
      if (edge.src === selectedId) out.add(edge.dst);
      if (edge.dst === selectedId) out.add(edge.src);
    }
    return out;
  }, [graph.edges, selectedId]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">
        graph.json에 노드가 없습니다.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-full w-full"
      role="img"
      aria-label="LLM Wiki knowledge graph"
    >
      <defs>
        <radialGradient id="nodeGlow">
          <stop offset="0%" stopColor="white" stopOpacity="0.28" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={WIDTH} height={HEIGHT} fill="#0b0d10" />
      <g opacity="0.35">
        {Array.from({ length: 9 }).map((_, i) => (
          <line
            key={`grid-v-${i}`}
            x1={80 + i * 95}
            x2={80 + i * 95}
            y1="48"
            y2={HEIGHT - 48}
            stroke="#262b33"
            strokeWidth="1"
          />
        ))}
        {Array.from({ length: 5 }).map((_, i) => (
          <line
            key={`grid-h-${i}`}
            x1="56"
            x2={WIDTH - 56}
            y1={88 + i * 92}
            y2={88 + i * 92}
            stroke="#262b33"
            strokeWidth="1"
          />
        ))}
      </g>
      <g>
        {graph.edges.map((edge, index) => {
          const src = byId.get(edge.src);
          const dst = byId.get(edge.dst);
          if (!src || !dst) return null;
          const active =
            !selectedId ||
            edge.src === selectedId ||
            edge.dst === selectedId;
          return (
            <line
              key={`${edge.src}-${edge.dst}-${edge.type ?? "edge"}-${index}`}
              x1={src.x}
              y1={src.y}
              x2={dst.x}
              y2={dst.y}
              stroke={active ? "#7aa2ff" : "#3a414c"}
              strokeOpacity={active ? 0.58 : 0.16}
              strokeWidth={Math.max(1, Math.min(5, edge.weight))}
            />
          );
        })}
      </g>
      <g>
        {positioned.map((node) => {
          const selected = node.id === selectedId;
          const related = selectedNeighbors.has(node.id);
          const dimmed = selectedId != null && !related;
          const color = colorForCommunity(node.community);
          return (
            <g
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
              className="cursor-pointer"
              opacity={dimmed ? 0.32 : 1}
              onClick={() => onSelect(node)}
            >
              <title>{nodeTitle(node)}</title>
              <circle
                r={node.r + 9}
                fill="url(#nodeGlow)"
                opacity={selected ? 0.9 : 0.38}
              />
              <circle
                r={node.r}
                fill={color}
                stroke={selected ? "#e7ebf0" : "#0b0d10"}
                strokeWidth={selected ? 3 : 2}
              />
              <text
                x={node.r + 7}
                y="4"
                fill={selected ? "#e7ebf0" : "#aeb6c2"}
                fontSize="12"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                paintOrder="stroke"
                stroke="#0b0d10"
                strokeWidth="4"
              >
                {node.label.length > 22
                  ? `${node.label.slice(0, 21)}...`
                  : node.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
