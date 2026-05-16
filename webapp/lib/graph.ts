import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config";
import { runCli, type CliName } from "./cli";
import {
  WIKI_GRAPH_PATH,
  WIKI_GRAPH_REPORT_PATH,
} from "./paths";
import {
  appendMessage,
  newSession,
} from "./sessions";

export type GraphNode = {
  id: string;
  label: string;
  type?: string;
  tags: string[];
  sources: string[];
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

export type GraphRunAction = "build" | "update";

export function buildGraphifyPrompt(
  action: GraphRunAction,
  sessionPath: string,
): string {
  const command = `wiki-graphify ${action}`;
  return [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md and use .agents/skills/wiki-graphify/SKILL.md.",
    `Active session log: sessions/${sessionPath}`,
    `Run exactly this graph operation: ${command}`,
    "Follow the repository rule: use the global graphify command from PATH; if only the package is available, python3 -m graphify is acceptable.",
    "Do not call a non-existent `graphify build` subcommand. For graphifyy 0.4.x, use the installed graphify package modules and the skill workflow to create wiki/graph/graph.json and GRAPH_REPORT.md.",
    "Do not ask for a graphify-specific API key. If authentication is missing, report that the selected coding agent CLI must be logged in or have its own credentials available to the webapp process.",
    "After the operation, reply with a concise Korean summary, changed files, and any blocker.",
  ].join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback: number | null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === "string")
    .filter(Boolean);
}

function normalizeNode(v: unknown, index: number): GraphNode | null {
  if (!isRecord(v)) return null;
  const id =
    asString(v.id) ||
    asString(v.name) ||
    asString(v.label) ||
    `node-${index + 1}`;
  const label =
    asString(v.label) ||
    asString(v.name) ||
    id;
  return {
    id,
    label,
    type: asString(v.type) || undefined,
    tags: asStringArray(v.tags),
    sources: asStringArray(v.sources),
    community: asNumber(v.community, null),
    centrality: asNumber(v.centrality, null),
    aliases: asStringArray(v.aliases),
  };
}

function normalizeEdge(v: unknown): GraphEdge | null {
  if (!isRecord(v)) return null;
  const src =
    asString(v.src) ||
    asString(v.source) ||
    asString(v.from);
  const dst =
    asString(v.dst) ||
    asString(v.target) ||
    asString(v.to);
  if (!src || !dst) return null;
  return {
    src,
    dst,
    type: asString(v.type) || undefined,
    weight: asNumber(v.weight, 1) ?? 1,
    sources: asStringArray(v.sources),
  };
}

function normalizeCommunity(v: unknown, index: number): GraphCommunity | null {
  if (!isRecord(v)) return null;
  const id = asNumber(v.id, index + 1);
  if (id == null) return null;
  return {
    id,
    label: asString(v.label) || `Community ${id}`,
    size: asNumber(v.size, 0) ?? 0,
  };
}

function normalizeGraph(raw: unknown): GraphData {
  const root = isRecord(raw) ? raw : {};
  const nodes = Array.isArray(root.nodes)
    ? root.nodes
        .map(normalizeNode)
        .filter((node): node is GraphNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(root.edges)
    ? root.edges
        .map(normalizeEdge)
        .filter((edge): edge is GraphEdge => {
          return edge !== null && nodeIds.has(edge.src) && nodeIds.has(edge.dst);
        })
    : [];
  const communities = Array.isArray(root.communities)
    ? root.communities
        .map(normalizeCommunity)
        .filter((community): community is GraphCommunity => community !== null)
    : [];

  return {
    version: asNumber(root.version, 1) ?? 1,
    builtAt:
      asString(root.built_at) ||
      asString(root.builtAt) ||
      null,
    nodes,
    edges,
    communities,
  };
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function fileUpdatedAt(filePath: string): Promise<string | null> {
  try {
    const st = await fs.stat(filePath);
    return st.mtime.toISOString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readGraphState(): Promise<GraphState> {
  const [graphText, report, updatedAt] = await Promise.all([
    readTextIfExists(WIKI_GRAPH_PATH),
    readTextIfExists(WIKI_GRAPH_REPORT_PATH),
    fileUpdatedAt(WIKI_GRAPH_PATH),
  ]);

  if (!graphText) {
    return {
      exists: false,
      graph: null,
      report,
      graphPath: path.relative(process.cwd(), WIKI_GRAPH_PATH),
      reportPath: path.relative(process.cwd(), WIKI_GRAPH_REPORT_PATH),
      updatedAt: null,
    };
  }

  return {
    exists: true,
    graph: normalizeGraph(JSON.parse(graphText)),
    report,
    graphPath: path.relative(process.cwd(), WIKI_GRAPH_PATH),
    reportPath: path.relative(process.cwd(), WIKI_GRAPH_REPORT_PATH),
    updatedAt,
  };
}

export async function runGraphify(action: GraphRunAction): Promise<{
  sessionPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}> {
  const cfg = await loadConfig();
  const agent = cfg.agent.default as CliName | null;
  if (!agent) {
    throw new Error("기본 코딩 에이전트가 지정되지 않았습니다. Settings에서 골라주세요.");
  }

  const session = await newSession({
    subject: `graph ${action}`,
    agent,
  });
  const command = `wiki-graphify ${action}`;
  await appendMessage(session.path, "user", command);

  const prompt = buildGraphifyPrompt(action, session.path);

  const result = await runCli(agent, prompt, {
    safeMode: cfg.agent.safeMode,
    timeoutMs: cfg.cli.timeouts.graph ?? undefined,
  });
  const reply =
    result.stdout.trim() ||
    result.stderr.trim() ||
    `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
  await appendMessage(session.path, "assistant", reply, agent);

  return {
    sessionPath: session.path,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
