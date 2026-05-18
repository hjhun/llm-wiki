"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Hammer, RefreshCw, RotateCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLanguage } from "../i18n";
import { Button, EmptyState, PageHeader, StatusBadge } from "../ui";
import GraphCanvas from "./GraphCanvas";
import type {
  GraphData,
  GraphDocument,
  GraphEdge,
  GraphNode,
  GraphState,
} from "./types";

type RunResult = {
  sessionPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

type SelectionHistory = {
  ids: string[];
  index: number;
};

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

function fmtDate(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function topNodes(graph: GraphData): GraphNode[] {
  return [...graph.nodes]
    .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))
    .slice(0, 8);
}

function nodeSummary(node: GraphNode): string {
  const bits = [];
  if (node.type) bits.push(node.type);
  if (node.community != null) bits.push(`C${node.community}`);
  if (node.tags.length > 0) bits.push(node.tags.slice(0, 3).join(", "));
  return bits.join(" · ") || node.id;
}

function documentKey(doc: GraphDocument): string {
  return `${doc.ws ?? "none"}:${doc.path ?? doc.source}`;
}

function isMarkdownDocument(doc: GraphDocument): boolean {
  return /\.mdx?$/i.test(doc.path ?? doc.source);
}

function blobHref(doc: GraphDocument): string | null {
  if (!doc.ws || !doc.path) return null;
  const params = new URLSearchParams({ ws: doc.ws, path: doc.path });
  return `/api/files/blob?${params.toString()}`;
}

function explorerHref(doc: GraphDocument): string | null {
  if (!doc.exists || !doc.ws || !doc.path) return null;
  const params = new URLSearchParams({ ws: doc.ws, path: doc.path });
  return `/explorer?${params.toString()}`;
}

const EMPTY_SELECTION_HISTORY: SelectionHistory = { ids: [], index: -1 };

function activeHistoryId(history: SelectionHistory): string | null {
  return history.index >= 0 ? (history.ids[history.index] ?? null) : null;
}

export default function Graph() {
  const { t } = useLanguage();
  const [state, setState] = useState<GraphState | null>(null);
  const [selectionHistory, setSelectionHistory] = useState<SelectionHistory>(
    EMPTY_SELECTION_HISTORY,
  );
  const [busy, setBusy] = useState<"build" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const selectedId = activeHistoryId(selectionHistory);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as GraphState;
      setState(next);
      setSelectionHistory((current) => {
        if (!next.graph) return EMPTY_SELECTION_HISTORY;
        const validIds = new Set(next.graph.nodes.map((node) => node.id));
        const ids = current.ids.filter((id) => validIds.has(id));
        if (ids.length === 0) return EMPTY_SELECTION_HISTORY;
        return {
          ids,
          index:
            current.index >= 0 ? Math.min(current.index, ids.length - 1) : 0,
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectNodeId = useCallback((id: string) => {
    setSelectionHistory((current) => {
      if (activeHistoryId(current) === id) return current;
      const previousIds =
        current.index >= 0 ? current.ids.slice(0, current.index + 1) : [];
      return { ids: [...previousIds, id], index: previousIds.length };
    });
  }, []);

  const handleNodeSelect = useCallback((node: GraphNode) => {
    selectNodeId(node.id);
  }, [selectNodeId]);

  const goToPreviousSelection = useCallback(() => {
    setSelectionHistory((current) =>
      current.index > 0 ? { ...current, index: current.index - 1 } : current,
    );
  }, []);

  const goToNextSelection = useCallback(() => {
    setSelectionHistory((current) =>
      current.index >= 0 && current.index < current.ids.length - 1
        ? { ...current, index: current.index + 1 }
        : current,
    );
  }, []);

  async function run(action: "build" | "update") {
    if (busy) return;
    setBusy(action);
    setError(null);
    setLastRun(null);
    try {
      const res = await fetch("/api/graph/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw await asError(res);
      const result = (await res.json()) as RunResult;
      setLastRun(result);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const graph = state?.graph ?? null;
  const selected = useMemo(() => {
    if (!graph || !selectedId) return null;
    return graph.nodes.find((node) => node.id === selectedId) ?? null;
  }, [graph, selectedId]);
  const selectedEdges = useMemo(() => {
    if (!graph || !selectedId) return [];
    return graph.edges.filter(
      (edge) => edge.src === selectedId || edge.dst === selectedId,
    );
  }, [graph, selectedId]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PageHeader
        eyebrow="knowledge graph"
        title={t.graph.title}
        meta={state?.graphPath ?? "wiki/graph/graph.json"}
        actions={
          <>
            {busy ? <StatusBadge tone="running">{busy}</StatusBadge> : null}
            <Button
              onClick={() => void load()}
              disabled={busy != null}
              icon={RefreshCw}
            >
              {t.graph.refresh}
            </Button>
            <Button
              onClick={() => void run("update")}
              disabled={busy != null}
              icon={RotateCw}
            >
              {busy === "update" ? t.graph.updating : t.graph.update}
            </Button>
            <Button
              onClick={() => void run("build")}
              disabled={busy != null}
              variant="primary"
              icon={Hammer}
            >
              {busy === "build" ? t.graph.building : t.graph.build}
            </Button>
          </>
        }
      />

      {error ? (
        <div className="border-b border-danger/50 bg-danger/10 px-4 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
      {lastRun ? (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-[11px] text-ink-faint">
          {t.graph.runSummary(lastRun.exitCode, lastRun.durationMs)}{" "}
          <span className="font-mono text-ink-dim">{lastRun.sessionPath}</span>
        </div>
      ) : null}

      <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] overflow-hidden">
        <main className="flex min-w-0 flex-col overflow-hidden">
          <div className="grid shrink-0 grid-cols-4 border-b border-line bg-bg-subtle">
            <Metric label={t.graph.nodes} value={graph?.nodes.length ?? 0} />
            <Metric label={t.graph.edges} value={graph?.edges.length ?? 0} />
            <Metric
              label={t.graph.communities}
              value={graph?.communities.length ?? 0}
            />
            <Metric
              label={t.graph.updated}
              value={fmtDate(state?.updatedAt ?? null)}
            />
          </div>

          {graph ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <GraphCanvas
                graph={graph}
                selectedId={selectedId}
                onSelect={handleNodeSelect}
                text={t.graph}
              />
            </div>
          ) : (
            <EmptyGraph
              loading={state == null}
              onBuild={() => void run("build")}
              busy={busy != null}
              text={t.graph}
            />
          )}
        </main>

        <aside className="min-h-0 overflow-auto border-l border-line bg-bg-subtle">
          {graph ? (
            <GraphInspector
              graph={graph}
              selected={selected}
              selectedEdges={selectedEdges}
              history={{
                canGoBack: selectionHistory.index > 0,
                canGoForward:
                  selectionHistory.index >= 0 &&
                  selectionHistory.index < selectionHistory.ids.length - 1,
                onBack: goToPreviousSelection,
                onForward: goToNextSelection,
              }}
              onSelect={selectNodeId}
              report={state?.report ?? null}
              reportPath={state?.reportPath ?? "wiki/graph/GRAPH_REPORT.md"}
              text={t.graph}
            />
          ) : (
            <EmptyState
              title={t.graph.waiting}
              description={t.graph.waitingText}
              className="m-4 min-h-52"
            />
          )}
        </aside>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="border-r border-line bg-bg-subtle/80 px-4 py-3 last:border-r-0">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-ink">{value}</div>
    </div>
  );
}

function EmptyGraph({
  loading,
  busy,
  onBuild,
  text,
}: {
  loading: boolean;
  busy: boolean;
  onBuild: () => void;
  text: ReturnType<typeof useLanguage>["t"]["graph"];
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <EmptyState
        title={text.emptyTitle}
        description={`${loading ? text.loading : text.noGraph} - ${text.emptyText}`}
        action={
          <Button onClick={onBuild} disabled={busy} variant="primary" size="md" icon={GitBranch}>
            {busy ? text.running : text.buildGraph}
          </Button>
        }
        className="max-w-lg"
      />
    </div>
  );
}

function GraphInspector({
  graph,
  selected,
  selectedEdges,
  history,
  onSelect,
  report,
  reportPath,
  text,
}: {
  graph: GraphData;
  selected: GraphNode | null;
  selectedEdges: GraphEdge[];
  history: {
    canGoBack: boolean;
    canGoForward: boolean;
    onBack: () => void;
    onForward: () => void;
  };
  onSelect: (id: string) => void;
  report: string | null;
  reportPath: string;
  text: ReturnType<typeof useLanguage>["t"]["graph"];
}) {
  const [activeDoc, setActiveDoc] = useState<GraphDocument | null>(null);
  const [preview, setPreview] = useState<
    | { status: "idle" }
    | { status: "loading"; doc: GraphDocument }
    | { status: "ready"; doc: GraphDocument; content: string }
    | { status: "unavailable"; doc: GraphDocument }
    | { status: "error"; doc: GraphDocument; message: string }
  >({ status: "idle" });

  const nodeById = useMemo(() => {
    return new Map(graph.nodes.map((node) => [node.id, node]));
  }, [graph.nodes]);

  const documents = useMemo(() => {
    const byKey = new Map<string, GraphDocument>();
    for (const doc of selected?.documents ?? []) {
      byKey.set(documentKey(doc), doc);
    }
    for (const edge of selectedEdges) {
      for (const doc of edge.documents) byKey.set(documentKey(doc), doc);
    }
    return Array.from(byKey.values());
  }, [selected, selectedEdges]);

  useEffect(() => {
    setActiveDoc(null);
    setPreview({ status: "idle" });
  }, [selected?.id]);

  async function openDocument(doc: GraphDocument) {
    setActiveDoc(doc);
    if (!doc.previewable || !doc.ws || !doc.path) {
      setPreview({ status: "unavailable", doc });
      return;
    }

    setPreview({ status: "loading", doc });
    try {
      const u = new URL("/api/files/content", window.location.origin);
      u.searchParams.set("ws", doc.ws);
      u.searchParams.set("path", doc.path);
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) throw await asError(res);
      const body = (await res.json()) as { content: string };
      setPreview({ status: "ready", doc, content: body.content });
    } catch (err) {
      setPreview({
        status: "error",
        doc,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <section className="border-b border-line p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            {text.selectedNode}
          </div>
          <div className="flex overflow-hidden rounded border border-line bg-bg/60">
            <button
              type="button"
              onClick={history.onBack}
              disabled={!history.canGoBack}
              title={text.previousSelection}
              className="h-7 min-w-9 border-r border-line px-2 font-mono text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            >
              {text.previousSelection}
            </button>
            <button
              type="button"
              onClick={history.onForward}
              disabled={!history.canGoForward}
              title={text.nextSelection}
              className="h-7 min-w-9 px-2 font-mono text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            >
              {text.nextSelection}
            </button>
          </div>
        </div>
        {selected ? (
          <div className="mt-3">
            <h2 className="text-sm font-semibold text-ink">{selected.label}</h2>
            <p className="mt-1 break-all font-mono text-[11px] text-ink-dim">
              {selected.id}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selected.type ? <Pill>{selected.type}</Pill> : null}
              {selected.community != null ? (
                <Pill>C{selected.community}</Pill>
              ) : null}
              {selected.centrality != null ? (
                <Pill>{selected.centrality.toFixed(3)}</Pill>
              ) : null}
              {selected.tags.slice(0, 6).map((tag) => (
                <Pill key={tag}>{tag}</Pill>
              ))}
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-ink-dim">
                {text.links} ({selectedEdges.length})
              </div>
              <div className="mt-2 space-y-1">
                {selectedEdges.slice(0, 10).map((edge, index) => {
                  const otherId = edge.src === selected.id ? edge.dst : edge.src;
                  const other = nodeById.get(otherId);
                  return (
                    <button
                      key={`${edge.src}-${edge.dst}-${index}`}
                      type="button"
                      onClick={() => onSelect(otherId)}
                      className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] text-ink-dim hover:bg-bg-panel hover:text-ink"
                      title={`${edge.src} -> ${edge.dst}`}
                    >
                      {other?.label ?? otherId}
                      {edge.type ? ` · ${edge.type}` : ""}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-ink-dim">
                {text.documents} ({documents.length})
              </div>
              <div className="mt-2 space-y-1">
                {documents.length > 0 ? (
                  documents.map((doc) => {
                    const active =
                      activeDoc && documentKey(activeDoc) === documentKey(doc);
                    const href = doc.reason === "binary" ? blobHref(doc) : null;
                    const explorer = explorerHref(doc);
                    return (
                      <div
                        key={documentKey(doc)}
                        className={[
                          "rounded border border-line bg-bg/40",
                          active ? "border-accent/70" : "",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          onClick={() => void openDocument(doc)}
                          className="block w-full px-2 py-1.5 text-left hover:bg-bg-panel"
                        >
                          <div className="truncate text-xs text-ink-dim">
                            {doc.label}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-ink-dim">
                            {doc.previewable
                              ? text.previewReady
                              : text.previewUnavailable}
                          </div>
                        </button>
                        {explorer || href ? (
                          <div className="flex border-t border-line">
                            {explorer ? (
                              <a
                                className="min-w-0 flex-1 truncate px-2 py-1 font-mono text-[10px] text-accent hover:bg-bg-panel"
                                href={explorer}
                              >
                                {text.openInExplorer}
                              </a>
                            ) : null}
                            {href ? (
                              <a
                                className="min-w-0 flex-1 truncate border-l border-line px-2 py-1 font-mono text-[10px] text-accent hover:bg-bg-panel first:border-l-0"
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {text.openBlob}
                              </a>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm text-ink-dim">{text.noDocuments}</p>
                )}
              </div>
            </div>
            <DocumentPreview preview={preview} text={text} />
          </div>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {text.chooseNode}
          </p>
        )}
      </section>

      <section className="border-b border-line p-4">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {text.godNodes}
        </div>
        <div className="mt-2 space-y-1">
          {topNodes(graph).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-bg-panel"
            >
              <div className="truncate text-xs font-medium text-ink">
                {node.label}
              </div>
              <div className="truncate text-[11px] text-ink-faint">
                {nodeSummary(node)}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="border-b border-line p-4">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {text.communities}
        </div>
        <div className="mt-2 space-y-1">
          {graph.communities.length > 0 ? (
            graph.communities.map((community) => (
              <div
                key={community.id}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs"
              >
                <span className="truncate text-ink">
                  C{community.id} · {community.label}
                </span>
                <span className="font-mono text-ink-dim">
                  {community.size}
                </span>
              </div>
            ))
          ) : (
            <p className="text-sm text-ink-dim">{text.noCommunity}</p>
          )}
        </div>
      </section>

      <section className="p-4">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {text.report}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
          {reportPath}
        </div>
        {report ? (
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg p-3 text-[11px] leading-relaxed text-ink-dim">
            {report}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-ink-dim">{text.noReport}</p>
        )}
      </section>
    </div>
  );
}

function DocumentPreview({
  preview,
  text,
}: {
  preview:
    | { status: "idle" }
    | { status: "loading"; doc: GraphDocument }
    | { status: "ready"; doc: GraphDocument; content: string }
    | { status: "unavailable"; doc: GraphDocument }
    | { status: "error"; doc: GraphDocument; message: string };
  text: ReturnType<typeof useLanguage>["t"]["graph"];
}) {
  if (preview.status === "idle") return null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        {text.preview}
      </div>
      {preview.status === "loading" ? (
        <p className="mt-2 text-sm text-ink-dim">{text.loadingDocument}</p>
      ) : preview.status === "unavailable" ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          {text.previewUnavailable}
        </p>
      ) : preview.status === "error" ? (
        <p className="mt-2 text-sm leading-relaxed text-red-300">
          {preview.message}
        </p>
      ) : isMarkdownDocument(preview.doc) ? (
        <div className="prose prose-theme mt-3 max-h-80 overflow-auto rounded border border-line bg-bg p-3 text-xs leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {preview.content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg p-3 text-[11px] leading-relaxed text-ink-dim">
          {preview.content}
        </pre>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
      {children}
    </span>
  );
}
