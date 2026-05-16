"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CliInfo,
  CliName,
  SettingsConfig,
  SettingsState,
  ToolStatus,
} from "./types";

const CLI_NAMES: CliName[] = ["codex", "claude", "gemini", "cline"];
const DEFAULT_TABS = ["chat", "explorer", "graph", "settings"] as const;
const SESSION_TTL_24H_SEC = 60 * 60 * 24;

async function asError(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(j?.error ?? `request failed (${res.status})`);
}

function cloneConfig(config: SettingsConfig): SettingsConfig {
  return {
    ...config,
    server: { ...config.server },
    agent: {
      ...config.agent,
      paths: { ...config.agent.paths },
    },
    chunking: { ...config.chunking },
    graph: { ...config.graph },
    ui: { ...config.ui },
    auth: { ...config.auth },
  };
}

function statusTone(status: "ready" | "missing") {
  return status === "ready"
    ? "border-emerald-900/60 bg-emerald-950/30 text-emerald-300"
    : "border-line bg-bg text-ink-faint";
}

export default function Settings() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState({ current: "", next: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as SettingsState;
      setState(next);
      setDraft(cloneConfig(next.config));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cliByName = useMemo(() => {
    return new Map(state?.cli.map((info) => [info.name, info]) ?? []);
  }, [state?.cli]);

  function updateDraft(mutator: (next: SettingsConfig) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      mutator(next);
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          server: draft.server,
          agent: draft.agent,
          chunking: draft.chunking,
          graph: draft.graph,
          ui: draft.ui,
          auth: {
            sessionTtlSec: draft.auth.sessionTtlSec,
          },
        }),
      });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as SettingsState;
      setState(next);
      setDraft(cloneConfig(next.config));
      setNotice("설정을 저장했습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function changePassword() {
    if (!password.current || !password.next) return;
    setBusy("password");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(password),
      });
      if (!res.ok) throw await asError(res);
      setPassword({ current: "", next: "" });
      setNotice("비밀번호를 변경했습니다.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Settings</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
            {state?.projectRoot ?? "loading project root"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy != null}
            className="h-8 rounded border border-line px-3 text-xs text-ink-dim hover:bg-bg-panel disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy != null || !draft}
            className="h-8 rounded bg-accent px-3 text-xs font-medium text-bg disabled:opacity-40"
          >
            {busy === "save" ? "Saving..." : "Save"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="border-b border-emerald-900/60 bg-emerald-950/30 px-4 py-1 text-[11px] text-emerald-300">
          {notice}
        </div>
      ) : null}

      {!draft ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
          설정을 읽는 중입니다.
        </div>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="space-y-4">
              <Panel title="Coding Agent" eyebrow="default cli">
                <div className="grid gap-3 lg:grid-cols-2">
                  {CLI_NAMES.map((name) => (
                    <CliCard
                      key={name}
                      info={cliByName.get(name)}
                      selected={draft.agent.default === name}
                      pathValue={draft.agent.paths[name] ?? ""}
                      onSelect={() =>
                        updateDraft((next) => {
                          next.agent.default = name;
                        })
                      }
                      onPathChange={(value) =>
                        updateDraft((next) => {
                          next.agent.paths[name] = value;
                        })
                      }
                    />
                  ))}
                </div>
                <label className="mt-4 flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      Safe mode
                    </span>
                    <span className="block text-xs text-ink-faint">
                      켜면 yolo/bypass 플래그를 빼고 CLI를 호출합니다.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.agent.safeMode}
                    onChange={(e) =>
                      updateDraft((next) => {
                        next.agent.safeMode = e.target.checked;
                      })
                    }
                    className="h-4 w-4 accent-accent"
                  />
                </label>
              </Panel>

              <Panel title="Runtime Defaults" eyebrow="wiki operation">
                <div className="grid gap-3 md:grid-cols-2">
                  <NumberField
                    label="Chunk max files"
                    value={draft.chunking.maxFiles}
                    min={1}
                    onChange={(value) =>
                      updateDraft((next) => {
                        next.chunking.maxFiles = value;
                      })
                    }
                  />
                  <NumberField
                    label="Chunk max bytes"
                    value={draft.chunking.maxBytes}
                    min={1024}
                    onChange={(value) =>
                      updateDraft((next) => {
                        next.chunking.maxBytes = value;
                      })
                    }
                  />
                  <NumberField
                    label="Min community size"
                    value={draft.graph.minCommunitySize}
                    min={1}
                    onChange={(value) =>
                      updateDraft((next) => {
                        next.graph.minCommunitySize = value;
                      })
                    }
                  />
                  <label className="rounded border border-line bg-bg px-3 py-2">
                    <span className="text-xs text-ink-faint">Default tab</span>
                    <select
                      value={draft.ui.defaultTab}
                      onChange={(e) =>
                        updateDraft((next) => {
                          next.ui.defaultTab = e.target.value as SettingsConfig["ui"]["defaultTab"];
                        })
                      }
                      className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                    >
                      {DEFAULT_TABS.map((tab) => (
                        <option key={tab} value={tab}>
                          {tab}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="mt-3 flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      Auto-update graph after ingest
                    </span>
                    <span className="block text-xs text-ink-faint">
                      ingest 머지 패스 후 wiki-graphify update를 권장합니다.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.graph.autoUpdateOnIngest}
                    onChange={(e) =>
                      updateDraft((next) => {
                        next.graph.autoUpdateOnIngest = e.target.checked;
                      })
                    }
                    className="h-4 w-4 accent-accent"
                  />
                </label>
              </Panel>
            </section>

            <aside className="space-y-4">
              <Panel title="Server" eyebrow="local web ui">
                <div className="grid gap-3">
                  <TextField
                    label="Host"
                    value={draft.server.host}
                    onChange={(value) =>
                      updateDraft((next) => {
                        next.server.host = value;
                      })
                    }
                  />
                  <NumberField
                    label="Port"
                    value={draft.server.port}
                    min={1}
                    onChange={(value) =>
                      updateDraft((next) => {
                        next.server.port = value;
                      })
                    }
                  />
                  <p className="text-xs leading-relaxed text-ink-faint">
                    host/port 변경은 다음 서버 시작부터 반영됩니다.
                  </p>
                </div>
              </Panel>

              <Panel title="Tools" eyebrow="detected">
                <div className="space-y-2">
                  {state?.tools.map((tool) => (
                    <ToolRow key={tool.name} tool={tool} />
                  ))}
                </div>
              </Panel>

              <Panel title="Login Session" eyebrow="auth">
                <div className="grid grid-cols-2 gap-2 rounded-md border border-line bg-bg p-1">
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft((next) => {
                        next.auth.sessionTtlSec = SESSION_TTL_24H_SEC;
                      })
                    }
                    className={[
                      "h-8 rounded text-xs font-medium transition-colors",
                      draft.auth.sessionTtlSec === SESSION_TTL_24H_SEC
                        ? "bg-accent text-bg"
                        : "text-ink-dim hover:bg-bg-panel hover:text-ink",
                    ].join(" ")}
                  >
                    24h
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft((next) => {
                        next.auth.sessionTtlSec = null;
                      })
                    }
                    className={[
                      "h-8 rounded text-xs font-medium transition-colors",
                      draft.auth.sessionTtlSec == null
                        ? "bg-accent text-bg"
                        : "text-ink-dim hover:bg-bg-panel hover:text-ink",
                    ].join(" ")}
                  >
                    계속 유지
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                  변경 후 새로 로그인한 세션부터 적용됩니다.
                </p>
              </Panel>

              <Panel title="Password" eyebrow="admin">
                <div className="space-y-3">
                  <TextField
                    label="Current password"
                    type="password"
                    value={password.current}
                    onChange={(value) =>
                      setPassword((next) => ({ ...next, current: value }))
                    }
                  />
                  <TextField
                    label="New password"
                    type="password"
                    value={password.next}
                    onChange={(value) =>
                      setPassword((next) => ({ ...next, next: value }))
                    }
                  />
                  <button
                    type="button"
                    onClick={() => void changePassword()}
                    disabled={busy != null || !password.current || !password.next}
                    className="h-8 w-full rounded border border-line text-xs font-medium text-ink-dim hover:bg-bg-panel disabled:opacity-40"
                  >
                    {busy === "password" ? "Changing..." : "Change password"}
                  </button>
                </div>
              </Panel>

              <Panel title="Config Files" eyebrow="paths">
                <div className="space-y-2 font-mono text-[11px] text-ink-faint">
                  <PathLine label="default" path={state?.configPaths.default} />
                  <PathLine label="local" path={state?.configPaths.local} />
                </div>
              </Panel>
            </aside>
          </div>
        </main>
      )}
    </div>
  );
}

function Panel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-bg-subtle">
      <header className="border-b border-line px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {eyebrow}
        </div>
        <h2 className="mt-1 text-sm font-semibold text-ink">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function CliCard({
  info,
  selected,
  pathValue,
  onSelect,
  onPathChange,
}: {
  info: CliInfo | undefined;
  selected: boolean;
  pathValue: string;
  onSelect: () => void;
  onPathChange: (value: string) => void;
}) {
  const status = info?.path ? "ready" : "missing";
  return (
    <div
      className={[
        "rounded-md border bg-bg p-3",
        selected ? "border-accent" : "border-line",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-sm font-semibold text-ink">
            {info?.name}
          </div>
          <div className="mt-1 truncate text-[11px] text-ink-faint">
            {info?.path ?? "not detected"}
          </div>
        </div>
        <button
          type="button"
          onClick={onSelect}
          className={[
            "h-7 rounded px-2 text-[11px] font-medium",
            selected
              ? "bg-accent text-bg"
              : "border border-line text-ink-dim hover:bg-bg-panel",
          ].join(" ")}
        >
          {selected ? "Default" : "Use"}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(status)}`}>
          {status}
        </span>
        <span className="text-[11px] text-ink-faint">
          {info?.source ?? "missing"}
        </span>
        {info?.version ? (
          <span className="truncate text-[11px] text-ink-faint">
            {info.version}
          </span>
        ) : null}
      </div>
      <label className="mt-3 block">
        <span className="text-[11px] text-ink-faint">Manual path</span>
        <input
          value={pathValue}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={`/usr/local/bin/${info?.name ?? "cli"}`}
          className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
        />
      </label>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolStatus }) {
  return (
    <div className="rounded border border-line bg-bg px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-semibold text-ink">
          {tool.name}
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(tool.status)}`}>
          {tool.status}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
        {tool.path ?? "not detected"}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-faint">{tool.note}</p>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-faint">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-faint">{label}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function PathLine({
  label,
  path,
}: {
  label: string;
  path: string | undefined;
}) {
  return (
    <div>
      <span className="text-ink-dim">{label}</span>
      <span className="mx-2 text-ink-faint">=</span>
      <span className="break-all">{path ?? "-"}</span>
    </div>
  );
}
