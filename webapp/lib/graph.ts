import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config";
import { runCli, type CliName } from "./cli";
import {
  isLikelyText,
  resolveEntry,
  type WsKey,
} from "./files";
import {
  WIKI_GRAPH_PATH,
  WIKI_GRAPH_REPORT_PATH,
} from "./paths";
import {
  appendMessage,
  newSession,
} from "./sessions";

export type GraphDocument = {
  source: string;
  label: string;
  ws: WsKey | null;
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

export type GraphRunAction = "build" | "update" | "update-partial";

export type BuildGraphifyPromptOptions = {
  /**
   * For `update-partial`: list of leaf directory paths (POSIX, trailing `/`)
   * whose partials should be (re)built. The agent must NOT touch leaves
   * outside this list and must NOT run the merge pass.
   */
  leafPaths?: string[];
};

export function buildGraphifyPrompt(
  action: GraphRunAction,
  sessionPath: string,
  opts: BuildGraphifyPromptOptions = {},
): string {
  const leafList = (opts.leafPaths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const commandLabel =
    action === "update-partial" && leafList.length > 0
      ? `wiki-graphify update-partial (leaves: ${leafList.join(", ")})`
      : `wiki-graphify ${action}`;

  const actionGuidance: string =
    action === "update-partial"
      ? [
          "For this `update-partial` run, build ONLY per-leaf partial graphs and SKIP the merge pass:",
          leafList.length > 0
            ? `- Target leaves (process exactly these, nothing else): ${leafList.map((p) => `\`${p}\``).join(", ")}.`
            : "- Target leaves: auto-detect from wiki/.progress/ingest/.state.json (leaves whose status just turned `done`).",
          "- Output: write or overwrite wiki/graph/parts/<sha1(leafPath)>.json for those leaves only.",
          "- Update wiki/graph/.state.json entries for those leaves with `built_at` + `content_hash`.",
          "- Do NOT touch wiki/graph/graph.json, wiki/graph/GRAPH_REPORT.md, or rerun community clustering. The merge pass runs as a separate `wiki-graphify update` call later (typically at /ingest-loop end).",
          "- Canonical ids: if wiki/graph/graph.json already exists, read its `nodes` first and reuse the existing `id` (and `aliases`) for any entity that already appears there — including case/spacing/language/slug variants. Only mint a new id for genuinely new entities. Aligned partials leave the merge pass far less to reconcile.",
          "- This is intentionally cheap: extract just the new leaf's content, write the partial, exit.",
        ].join("\n")
      : action === "update"
        ? "For this `update` run, prefer reading wiki/.progress/ingest/.state.json and wiki/graph/.state.json to scope work to only the leaves whose content_hash changed since the previous build, then rerun the merge pass to produce a connected wiki/graph/graph.json + GRAPH_REPORT.md. Per-leaf partials may already exist when graph.autoUpdateStrategy allowed adaptive `update-partial`; if not, build the changed partials now before the merge pass."
        : "For this `build` run, enumerate all leaves under wiki/ (and raw/ if relevant), build per-leaf partials, then run the merge pass.";

  return [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md and use .agents/skills/wiki-graphify/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${sessionPath}`,
    `Run exactly this graph operation: ${commandLabel}`,
    "",
    "Output path is fixed by this repository (see paths.ts and the wiki-graphify SKILL):",
    "- wiki/graph/graph.json",
    "- wiki/graph/GRAPH_REPORT.md",
    "- wiki/graph/parts/<sha1(leafPath)>.json (per-leaf partials)",
    "- wiki/graph/.state.json (leaf -> built_at/content_hash)",
    "Do NOT write outputs to graphify-out/, the package's default location. The webapp's Graph tab and lib/graph.ts only read wiki/graph/graph.json, so any other path is invisible to the user.",
    "",
    "Execution path (from the SKILL):",
    "1. Prefer the global `graphify` command from PATH; fall back to `python3 -m graphify` only if the script is missing.",
    "2. For graphifyy 0.4.x the installed CLI exposes only code-oriented commands (`graphify update <path>` calls `_rebuild_code`, which by default writes to <path>/graphify-out/). Therefore:",
    "   - If you do invoke `graphify update`, pass `--out wiki/graph` so output lands in the correct directory: `graphify update wiki/ --out wiki/graph`.",
    "   - For Markdown wiki content (the common case here), `graphify update` alone will NOT extract entities/concepts — it is code-only. Use the Python package modules `graphify.detect`, `graphify.extract`, `graphify.build`, `graphify.cluster`, `graphify.report`, and `graphify.export` to assemble per-leaf partials in wiki/graph/parts/, then (for `update`/`build` only) merge into wiki/graph/graph.json. Follow the leaf-first chunk policy in §Chunk Policy of the SKILL.",
    "3. There is no literal `graphify build` subcommand; `wiki-graphify build` is an agent-level operation name, not a CLI command.",
    "4. During `/ingest-loop`, the webapp may skip `update-partial` for small workloads when `graph.autoUpdateStrategy` is `auto`; final `wiki-graphify update` still performs changed-partial rebuilds plus the merge pass.",
    "",
    actionGuidance,
    "",
    "Do not ask for a graphify-specific API key. If authentication is missing, report that the selected coding agent CLI must be logged in or have its own credentials available to the webapp process.",
    action === "update-partial"
      ? "After the operation, reply with a one-line Korean summary: which leaves got partials, file paths under wiki/graph/parts/, and any blocker."
      : "After the operation, reply with a concise Korean summary listing: changed files under wiki/graph/, node/edge/community counts, and any blocker.",
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
    documents: [],
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
    documents: [],
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

function parseGraphSource(source: string): { ws: WsKey; rel: string } | null {
  const normalized = source
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
  const match = /^(wiki|raw|sessions)\/(.+)$/.exec(normalized);
  if (!match) return null;
  return {
    ws: match[1] as WsKey,
    rel: match[2].replace(/^\/+/, ""),
  };
}

async function sourceDocument(source: string): Promise<GraphDocument> {
  const parsed = parseGraphSource(source);
  const label = parsed ? `${parsed.ws}/${parsed.rel}` : source;
  if (!parsed) {
    return {
      source,
      label,
      ws: null,
      path: null,
      exists: false,
      text: false,
      previewable: false,
      reason: "unsupported",
    };
  }

  try {
    const abs = resolveEntry(parsed.ws, parsed.rel);
    const st = await fs.stat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!st || !st.isFile()) {
      return {
        source,
        label,
        ws: parsed.ws,
        path: parsed.rel,
        exists: false,
        text: false,
        previewable: false,
        reason: "missing",
      };
    }

    const text = isLikelyText(parsed.rel);
    return {
      source,
      label,
      ws: parsed.ws,
      path: parsed.rel,
      exists: true,
      text,
      previewable: text,
      reason: text ? "ok" : "binary",
    };
  } catch {
    return {
      source,
      label,
      ws: parsed.ws,
      path: parsed.rel,
      exists: false,
      text: false,
      previewable: false,
      reason: "blocked",
    };
  }
}

async function attachDocuments(graph: GraphData): Promise<GraphData> {
  const cache = new Map<string, Promise<GraphDocument>>();
  const documentFor = (source: string) => {
    let cached = cache.get(source);
    if (!cached) {
      cached = sourceDocument(source);
      cache.set(source, cached);
    }
    return cached;
  };

  const nodes = await Promise.all(
    graph.nodes.map(async (node) => ({
      ...node,
      documents: await Promise.all(node.sources.map(documentFor)),
    })),
  );
  const edges = await Promise.all(
    graph.edges.map(async (edge) => ({
      ...edge,
      documents: await Promise.all(edge.sources.map(documentFor)),
    })),
  );

  return { ...graph, nodes, edges };
}

/**
 * Fuzzy key for matching edge endpoints back to a node: NFKD + accent-strip,
 * lowercase, non-alphanumeric runs collapsed to `-`. Lets an edge that points
 * at an un-reconciled id variant be remapped instead of silently dropped.
 */
function graphIdKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeGraph(raw: unknown): GraphData {
  const root = isRecord(raw) ? raw : {};
  const nodes = Array.isArray(root.nodes)
    ? root.nodes
        .map(normalizeNode)
        .filter((node): node is GraphNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  // Index every node surface form (id, label, aliases) to its canonical id so
  // edges referencing a variant the merge pass failed to reconcile can be
  // remapped. Dropping is the last resort, not the default.
  const aliasIndex = new Map<string, string>();
  for (const node of nodes) {
    for (const surface of [node.id, node.label, ...node.aliases]) {
      if (!surface) continue;
      const key = graphIdKey(surface);
      if (key && !aliasIndex.has(key)) aliasIndex.set(key, node.id);
    }
  }
  const resolveEndpoint = (id: string): string | null => {
    if (nodeIds.has(id)) return id;
    return aliasIndex.get(graphIdKey(id)) ?? null;
  };
  const edges = Array.isArray(root.edges)
    ? root.edges
        .map(normalizeEdge)
        .filter((edge): edge is GraphEdge => edge !== null)
        .map((edge): GraphEdge | null => {
          const src = resolveEndpoint(edge.src);
          const dst = resolveEndpoint(edge.dst);
          if (!src || !dst) return null;
          return src === edge.src && dst === edge.dst
            ? edge
            : { ...edge, src, dst };
        })
        .filter((edge): edge is GraphEdge => edge !== null)
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
    graph: await attachDocuments(normalizeGraph(JSON.parse(graphText))),
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
