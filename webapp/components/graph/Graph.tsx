"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "../i18n";
import GraphCanvas from "./GraphCanvas";
import type { GraphData, GraphNode, GraphState } from "./types";

type RunResult = {
  sessionPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
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

export default function Graph() {
  const { t } = useLanguage();
  const [state, setState] = useState<GraphState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as GraphState;
      setState(next);
      if (
        selectedId &&
        !next.graph?.nodes.some((node) => node.id === selectedId)
      ) {
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

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
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">{t.graph.title}</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
            {state?.graphPath ?? "wiki/graph/graph.json"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy != null}
            className="h-8 rounded border border-line px-3 text-xs text-ink-dim hover:bg-bg-panel disabled:opacity-40"
          >
            {t.graph.refresh}
          </button>
          <button
            type="button"
            onClick={() => void run("update")}
            disabled={busy != null}
            className="h-8 rounded border border-line px-3 text-xs text-ink-dim hover:bg-bg-panel disabled:opacity-40"
          >
            {busy === "update" ? t.graph.updating : t.graph.update}
          </button>
          <button
            type="button"
            onClick={() => void run("build")}
            disabled={busy != null}
            className="h-8 rounded bg-accent px-3 text-xs font-medium text-bg disabled:opacity-40"
          >
            {busy === "build" ? t.graph.building : t.graph.build}
          </button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
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
                onSelect={(node) => setSelectedId(node.id)}
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
              onSelect={setSelectedId}
              report={state?.report ?? null}
              reportPath={state?.reportPath ?? "wiki/graph/GRAPH_REPORT.md"}
              text={t.graph}
            />
          ) : (
            <div className="p-4 text-sm text-ink-dim">
              <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                {t.graph.waiting}
              </div>
              <p className="mt-2 leading-relaxed">{t.graph.waitingText}</p>
            </div>
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
    <div className="border-r border-line px-4 py-3 last:border-r-0">
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
      <div className="max-w-lg text-center">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {loading ? text.loading : text.noGraph}
        </div>
        <h2 className="mt-3 text-lg font-semibold text-ink">
          {text.emptyTitle}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          {text.emptyText}
        </p>
        <button
          type="button"
          onClick={onBuild}
          disabled={busy}
          className="mt-5 h-9 rounded bg-accent px-4 text-sm font-medium text-bg disabled:opacity-40"
        >
          {busy ? text.running : text.buildGraph}
        </button>
      </div>
    </div>
  );
}

function GraphInspector({
  graph,
  selected,
  selectedEdges,
  onSelect,
  report,
  reportPath,
  text,
}: {
  graph: GraphData;
  selected: GraphNode | null;
  selectedEdges: { src: string; dst: string; type?: string; weight: number }[];
  onSelect: (id: string) => void;
  report: string | null;
  reportPath: string;
  text: ReturnType<typeof useLanguage>["t"]["graph"];
}) {
  return (
    <div className="flex min-h-full flex-col">
      <section className="border-b border-line p-4">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          {text.selectedNode}
        </div>
        {selected ? (
          <div className="mt-3">
            <h2 className="text-sm font-semibold text-ink">{selected.label}</h2>
            <p className="mt-1 break-all font-mono text-[11px] text-ink-faint">
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
                {selectedEdges.slice(0, 10).map((edge, index) => (
                  <div
                    key={`${edge.src}-${edge.dst}-${index}`}
                    className="truncate font-mono text-[11px] text-ink-faint"
                    title={`${edge.src} -> ${edge.dst}`}
                  >
                    {edge.src === selected.id ? edge.dst : edge.src}
                    {edge.type ? ` · ${edge.type}` : ""}
                  </div>
                ))}
              </div>
            </div>
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
                <span className="truncate text-ink-dim">
                  C{community.id} · {community.label}
                </span>
                <span className="font-mono text-ink-faint">
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

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
      {children}
    </span>
  );
}
