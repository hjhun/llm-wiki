import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "./api";
import { loadConfig } from "./config";
import { runCli } from "./cli";
import { resolveAgentForRole } from "./agent-roles";
import { createChatJob, type ChatJob } from "./chat-jobs";
import { cleanCliText, displayChunk } from "./cli-output";
import {
  isLikelyText,
  resolveEntry,
  type WsKey,
} from "./files";
import {
  PROJECT_ROOT,
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
  status: "missing" | "partial-only" | "ready" | "invalid";
  graph: GraphData | null;
  report: string | null;
  graphPath: string;
  reportPath: string;
  updatedAt: string | null;
  diagnostics: {
    partsCount: number;
    stateExists: boolean;
    reportExists: boolean;
    message: string | null;
  };
};

export type GraphRunAction = "build" | "update" | "update-partial";

export type BuildGraphifyPromptOptions = {
  /**
   * For scoped `update`: leaves whose partials should be rebuilt before the
   * full merge pass. For `update-partial`: leaves whose cache files should be
   * rebuilt without touching graph.json.
   */
  leafPaths?: string[];
};

export function buildGraphifyPrompt(
  action: GraphRunAction,
  sessionPath: string,
  opts: BuildGraphifyPromptOptions = {},
): string {
  const requestedLeaves = (opts.leafPaths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const leafList = requestedLeaves.filter((p) => p === "wiki" || p.startsWith("wiki/"));
  const ignoredLeaves = requestedLeaves.filter((p) => !leafList.includes(p));
  const commandLabel =
    leafList.length > 0
      ? `wiki-graphify ${action} (leaves: ${leafList.join(", ")})`
      : `wiki-graphify ${action}`;
  const ignoredLeafGuidance =
    ignoredLeaves.length > 0
      ? `\n- Ignore non-wiki scoped leaves from the caller: ${ignoredLeaves.map((p) => `\`${p}\``).join(", ")}. Graph generation reads wiki/ only.`
      : "";

  const actionGuidance: string =
    action === "update-partial"
      ? [
          "For this `update-partial` run, build ONLY per-leaf partial graphs and SKIP the merge pass:",
          leafList.length > 0
            ? `- Target leaves (process exactly these, nothing else): ${leafList.map((p) => `\`${p}\``).join(", ")}.`
            : "- Target leaves: auto-detect changed/missing leaf directories under `wiki/` only.",
          ignoredLeafGuidance.trim(),
          "- Output: write or overwrite wiki/graph/parts/<sha1(leafPath)>.json for those leaves only.",
          "- Update wiki/graph/.state.json entries for those leaves with `built_at` + `content_hash`.",
          "- Do NOT touch wiki/graph/graph.json, wiki/graph/GRAPH_REPORT.md, or rerun community clustering. The merge pass runs as a separate `wiki-graphify update` call later (typically at /ingest-loop end).",
          "- Canonical ids: if wiki/graph/graph.json already exists, read its `nodes` first and reuse the existing `id` (and `aliases`) for any entity that already appears there — including case/spacing/language/slug variants. Only mint a new id for genuinely new entities. Aligned partials leave the merge pass far less to reconcile.",
          "- This is intentionally cheap: extract just the new leaf's content, write the partial, exit.",
        ].join("\n")
      : action === "update"
        ? [
            "For this `update` run, rebuild per-leaf partial graphs only for scoped `wiki/` leaves when a wiki leaf list is supplied, or for changed/missing leaf directories discovered under `wiki/` and wiki/graph/.state.json when no leaf list is supplied.",
            leafList.length > 0
              ? `- Scoped leaves to refresh before merge: ${leafList.map((p) => `\`${p}\``).join(", ")}.`
              : "- Scoped leaves: auto-detect changed/missing leaves.",
            ignoredLeafGuidance.trim(),
            "- Do not read, hash, enumerate, or graphify `raw/` files or directories. Code knowledge is represented only by Markdown pages that already exist under `wiki/`.",
            "- After refreshing those partials, ALWAYS run the connect pass across ALL valid wiki/graph/parts/*.json so the target is connected back into the existing graph.",
            "- Output connected artifacts: wiki/graph/graph.json and wiki/graph/GRAPH_REPORT.md.",
            "- Do not treat a scoped partial refresh as complete until graph.json has been rewritten from the full parts set.",
          ].join("\n")
        : "For this `build` run, enumerate all leaves under wiki/ only, build per-leaf partials, then run the merge pass. Do not enumerate or graphify raw/.";

  return [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md and use .agents/skills/wiki-graphify/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${sessionPath}`,
    `Run exactly this graph operation: ${commandLabel}`,
    "",
    "Output path is fixed by this repository (see paths.ts and the wiki-graphify SKILL):",
    "- wiki/graph/graph.json (final connected graph; `edges` is preferred; `links` from graphify's native exporter is accepted for compatibility)",
    "- wiki/graph/GRAPH_REPORT.md",
    "- wiki/graph/parts/<sha1(leafPath)>.json (page-title partials, one per wiki leaf)",
    "- wiki/graph/.state.json (wiki leaf -> built_at/content_hash)",
    "Do NOT write outputs to graphify-out/ at the repo root (the package default). The webapp's Graph tab and lib/graph.ts only read wiki/graph/graph.json, so any other final path is invisible to the user.",
    "",
    "Execution path (from the SKILL):",
    "1. Prefer the global `graphify` command from PATH; fall back to `python3 -m graphify` only if the script is missing.",
    "2. For graphifyy 0.4.x the installed CLI exposes only code-oriented commands (`graphify update <path>` calls `_rebuild_code`, which by default writes to <path>/graphify-out/). Therefore:",
    "   - Do not run `graphify update raw/<scope>` or otherwise point graphify at `raw/`; graph generation reads the compiled Markdown under `wiki/` only.",
    "   - For wiki/ Markdown content, if you do invoke `graphify update`, pass `--out wiki/graph` so output lands in the correct directory: `graphify update wiki/ --out wiki/graph`.",
    "   - For Markdown wiki content (the common case here), `graphify update` alone may not extract entities/concepts — use the Python package modules `graphify.detect`, `graphify.extract`, `graphify.build`, `graphify.cluster`, `graphify.report`, and `graphify.export` to assemble per-leaf partials in wiki/graph/parts/, then (for `update`/`build` only) merge into wiki/graph/graph.json. Follow the leaf-first chunk policy in §Chunk Policy of the SKILL.",
    "   - When partials are already available, scripts/merge-graph-parts.mjs can perform the final connected merge into wiki/graph/graph.json and wiki/graph/GRAPH_REPORT.md.",
    "3. There is no literal `graphify build` subcommand; `wiki-graphify build` is an agent-level operation name, not a CLI command.",
    "4. During `/ingest-loop`, the webapp may skip scoped incremental updates for small workloads when `graph.autoUpdateStrategy` is `auto`; whenever an incremental update does run, it is `wiki-graphify update` with scoped leaves and MUST still merge all existing parts into graph.json.",
    "5. Build the Obsidian-like page-title graph first: one node per Markdown page. Connect prose pages with two edge classes only — explicit links (wikilinks, Markdown links, frontmatter sources, raw_path) and high-confidence semantic relatedness (`related_to`) at/above `graph.extraction.semanticMinConfidence`. Frontmatter facets stay as node metadata; do NOT auto-convert facets to edges (`graph.extraction.facetEdges=false`).",
    "6. Use graphify's global extraction style only as a bounded enrichment layer for wiki Markdown, applying the merged config (`config/default.json` plus `config/local.json`): `graph.extraction.primaryNodeModel`, `profile`, `scope`, `maxNodesPerLeaf`, `maxConceptsPerSource`, `minConfidence`, `semanticMinConfidence`, and the include/drop toggles. `scope` is fixed to `wiki`.",
    "7. Do not build per-project graphify-out from `raw/`, do not write wiki/graph/projects/<project>/, and do not synthesize wiki/code/<project>.md as part of graph generation. If `wiki/code/` pages already exist, treat them like ordinary wiki Markdown pages.",
    "8. Default profile is `wiki`: keep page-backed source/entity/concept/code/project/map nodes and explicit link/citation edges plus thresholded `related_to` edges. Do not create one node per heading, paragraph, rationale snippet, incidental noun, or facet edge unless the profile is explicitly `deep`.",
    "9. After extraction, prune low-confidence inferred edges, below-threshold semantic edges, auto facet edges, rationale nodes, hyperedges, isolated derived nodes, and over-budget nodes according to `graph.extraction`. Record kept/pruned counts in GRAPH_REPORT.md.",
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

function asWorkspaceSource(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const source = v.trim().replace(/\\/g, "/");
  if (/^(wiki|raw|sessions)\//.test(source)) return source;
  if (path.isAbsolute(source)) {
    const rel = path.relative(PROJECT_ROOT, source).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== "..") return rel;
  }
  return source;
}

function graphSources(v: Record<string, unknown>): string[] {
  const sources = new Set(asStringArray(v.sources));
  const sourceFile = asWorkspaceSource(v.source_file);
  if (sourceFile) sources.add(sourceFile);
  return [...sources];
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
    sources: graphSources(v),
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
    type: asString(v.type) || asString(v.relation) || undefined,
    weight: asNumber(v.weight, 1) ?? 1,
    sources: graphSources(v),
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
  const rawEdges = Array.isArray(root.edges)
    ? root.edges
    : Array.isArray(root.links)
      ? root.links
      : [];
  const edges = rawEdges
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
        .filter((edge): edge is GraphEdge => edge !== null);
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

async function graphDiagnostics() {
  const graphDir = path.dirname(WIKI_GRAPH_PATH);
  const partsDir = path.join(graphDir, "parts");
  const statePath = path.join(graphDir, ".state.json");
  const [partEntries, stateStat, reportStat] = await Promise.all([
    fs.readdir(partsDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[];
      throw err;
    }),
    fs.stat(statePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    }),
    fs.stat(WIKI_GRAPH_REPORT_PATH).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    }),
  ]);
  return {
    partsCount: partEntries.filter((entry) => entry.endsWith(".json")).length,
    stateExists: stateStat?.isFile() ?? false,
    reportExists: reportStat?.isFile() ?? false,
  };
}

export async function readGraphState(): Promise<GraphState> {
  const [graphText, report, updatedAt, diagnosticsBase] = await Promise.all([
    readTextIfExists(WIKI_GRAPH_PATH),
    readTextIfExists(WIKI_GRAPH_REPORT_PATH),
    fileUpdatedAt(WIKI_GRAPH_PATH),
    graphDiagnostics(),
  ]);

  if (!graphText) {
    const partialOnly =
      diagnosticsBase.partsCount > 0 || diagnosticsBase.stateExists;
    return {
      exists: false,
      status: partialOnly ? "partial-only" : "missing",
      graph: null,
      report,
      graphPath: path.relative(process.cwd(), WIKI_GRAPH_PATH),
      reportPath: path.relative(process.cwd(), WIKI_GRAPH_REPORT_PATH),
      updatedAt: null,
      diagnostics: {
        ...diagnosticsBase,
        message: partialOnly
          ? "wiki/graph has partial artifacts but no connected graph.json. Run wiki-graphify update to finish the merge pass."
          : null,
      },
    };
  }

  let graph: GraphData;
  try {
    graph = normalizeGraph(JSON.parse(graphText));
  } catch (err) {
    return {
      exists: true,
      status: "invalid",
      graph: null,
      report,
      graphPath: path.relative(process.cwd(), WIKI_GRAPH_PATH),
      reportPath: path.relative(process.cwd(), WIKI_GRAPH_REPORT_PATH),
      updatedAt,
      diagnostics: {
        ...diagnosticsBase,
        message: `graph.json could not be parsed: ${errorMessage(err)}`,
      },
    };
  }

  return {
    exists: true,
    status: "ready",
    graph: await attachDocuments(graph),
    report,
    graphPath: path.relative(process.cwd(), WIKI_GRAPH_PATH),
    reportPath: path.relative(process.cwd(), WIKI_GRAPH_REPORT_PATH),
    updatedAt,
    diagnostics: {
      ...diagnosticsBase,
      message: null,
    },
  };
}

export type GraphStats = {
  status: GraphState["status"];
  nodes: number;
  edges: number;
  communities: number;
  updatedAt: string | null;
};

/**
 * Lightweight counts for the dashboard. Unlike {@link readGraphState} this does
 * not call `attachDocuments`, which fans out a filesystem `stat` per node/edge
 * source and dominates the cost on large graphs. We only need the totals here.
 */
export async function readGraphStats(): Promise<GraphStats> {
  const [graphText, updatedAt, diagnosticsBase] = await Promise.all([
    readTextIfExists(WIKI_GRAPH_PATH),
    fileUpdatedAt(WIKI_GRAPH_PATH),
    graphDiagnostics(),
  ]);
  if (!graphText) {
    const partialOnly =
      diagnosticsBase.partsCount > 0 || diagnosticsBase.stateExists;
    return {
      status: partialOnly ? "partial-only" : "missing",
      nodes: 0,
      edges: 0,
      communities: 0,
      updatedAt: null,
    };
  }
  try {
    const graph = normalizeGraph(JSON.parse(graphText));
    return {
      status: "ready",
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      communities: graph.communities.length,
      updatedAt,
    };
  } catch {
    return { status: "invalid", nodes: 0, edges: 0, communities: 0, updatedAt };
  }
}

/**
 * Starts a graphify run as a background chat job and returns the job so the
 * caller can stream its events (start / chunk / done / error). The coding
 * agent runs inside a detached async task: closing the HTTP stream does not
 * kill it — only an explicit cancel via ChatJob.abort does. This mirrors the
 * single-CLI path of /api/chat/send, so a graph build is visible both in the
 * chat job list (/api/chat/jobs) and in the ambient AgentEdgePanel mascot.
 */
export async function startGraphifyJob(
  action: GraphRunAction,
): Promise<ChatJob> {
  const cfg = await loadConfig();
  const agent = resolveAgentForRole(cfg, "maintenance");
  if (!agent) {
    throw new Error(
      "기본 코딩 에이전트가 지정되지 않았습니다. Settings에서 골라주세요.",
    );
  }

  const session = await newSession({
    subject: `graph ${action}`,
    agent,
  });
  const command = `wiki-graphify ${action}`;
  await appendMessage(session.path, "user", command);

  const prompt = buildGraphifyPrompt(action, session.path);
  const job = createChatJob({
    sessionPath: session.path,
    kind: "graph",
    agent,
  });

  // Detached task: drives the CLI and feeds the job's event log. Returning the
  // job before this resolves lets the route stream events as they arrive.
  void (async () => {
    job.append({ type: "start", sessionPath: session.path });
    try {
      const result = await runCli(agent, prompt, {
        safeMode: cfg.agent.safeMode,
        timeoutMs: cfg.cli.timeouts.graph ?? undefined,
        // Pair the child to the job's AbortController so an HTTP cancel
        // request can SIGTERM it, consistent with chat/ingest jobs.
        signal: job.abort.signal,
        onStdout: (chunk) => {
          const text = displayChunk(chunk);
          if (text) job.append({ type: "chunk", stream: "stdout", text });
        },
      });
      let reply =
        cleanCliText(result.stdout).trim() ||
        cleanCliText(result.stderr).trim() ||
        `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
      if (job.cancelled) {
        reply = [
          "⛔ 사용자 Stop 요청으로 중단됨.",
          "",
          "- kind: graph",
          `- exitCode: ${result.exitCode}`,
          `- durationMs: ${result.durationMs}`,
          "- result: 실행 중이던 CLI 프로세스에 SIGTERM을 보냈고, 추가 에이전트 응답 생성은 건너뛰었습니다.",
        ].join("\n");
      }
      const assistantMsg = await appendMessage(
        session.path,
        "assistant",
        reply,
        agent,
      );
      job.append({
        type: "done",
        sessionPath: session.path,
        assistant: assistantMsg,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const msg = errorMessage(err);
      await appendMessage(
        session.path,
        "system",
        `❌ CLI 호출 실패: ${msg}`,
      ).catch(() => undefined);
      job.append({ type: "error", sessionPath: session.path, error: msg });
    }
  })();

  return job;
}
