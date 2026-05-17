export type GraphDocument = {
  source: string;
  label: string;
  ws: "wiki" | "raw" | "sessions" | null;
  path: string | null;
  exists: boolean;
  text: boolean;
  previewable: boolean;
  reason: "ok" | "unsupported" | "missing" | "blocked" | "binary";
};

export type GraphNode = {
  id: string;
  label: string;
  type?: string;
  tags: string[];
  sources: string[];
  documents: GraphDocument[];
  community: number | null;
  centrality: number | null;
  aliases: string[];
};

export type GraphEdge = {
  src: string;
  dst: string;
  type?: string;
  weight: number;
  sources: string[];
  documents: GraphDocument[];
};

export type GraphCommunity = {
  id: number;
  label: string;
  size: number;
};

export type GraphData = {
  version: number;
  builtAt: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
};

export type GraphState = {
  exists: boolean;
  graph: GraphData | null;
  report: string | null;
  graphPath: string;
  reportPath: string;
  updatedAt: string | null;
};
