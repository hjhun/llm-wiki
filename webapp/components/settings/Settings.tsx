"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Gauge,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { type Language, useLanguage } from "../i18n";
import { useTheme } from "../theme";
import AutoIngestPanel from "./AutoIngestPanel";
import AutoLintPanel from "./AutoLintPanel";
import { Button, PageHeader, StatusBadge, cx } from "../ui";
import type {
  CliInfo,
  CliName,
  SettingsConfig,
  SettingsState,
  ToolStatus,
} from "./types";

const CLI_NAMES: CliName[] = ["codex", "claude", "gemini", "cline"];
const DEFAULT_TABS = ["chat", "explorer", "graph", "automations", "settings"] as const;
const SESSION_TTL_24H_SEC = 60 * 60 * 24;

type SettingsTabId =
  | "agent"
  | "runtime"
  | "automation"
  | "access"
  | "diagnostics";

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
      orchestration: { ...config.agent.orchestration },
    },
    chunking: { ...config.chunking },
    graph: { ...config.graph },
    ui: { ...config.ui },
    auth: { ...config.auth },
    publicQuery: { ...config.publicQuery },
    autoIngest: {
      ...config.autoIngest,
      watch: { ...config.autoIngest.watch },
      schedule: { ...config.autoIngest.schedule },
    },
    autoLint: {
      ...config.autoLint,
      counter: { ...config.autoLint.counter },
      cron: {
        ...config.autoLint.cron,
        time: { ...config.autoLint.cron.time },
      },
    },
  };
}

function statusTone(status: "ready" | "missing") {
  return status === "ready" ? "status-ready" : "status-disabled";
}

export default function Settings() {
  const router = useRouter();
  const { language, setLanguage, t } = useLanguage();
  const { setTheme } = useTheme();
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState({ current: "", next: "" });
  const [activeTab, setActiveTab] = useState<SettingsTabId>("agent");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as SettingsState;
      setState(next);
      setTheme(next.config.ui.theme);
      setDraft({
        ...cloneConfig(next.config),
        ui: { ...next.config.ui, language },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [language, setTheme]);

  useEffect(() => {
    void load();
  }, [load]);

  const cliByName = useMemo(() => {
    return new Map(state?.cli.map((info) => [info.name, info]) ?? []);
  }, [state?.cli]);

  const settingsTabs = useMemo(
    () =>
      [
        {
          id: "agent",
          label: t.settings.settingsTabAgent,
          description: t.settings.settingsTabAgentDesc,
          icon: Bot,
        },
        {
          id: "runtime",
          label: t.settings.settingsTabRuntime,
          description: t.settings.settingsTabRuntimeDesc,
          icon: Gauge,
        },
        {
          id: "automation",
          label: t.settings.settingsTabAutomation,
          description: t.settings.settingsTabAutomationDesc,
          icon: Zap,
        },
        {
          id: "access",
          label: t.settings.settingsTabAccess,
          description: t.settings.settingsTabAccessDesc,
          icon: ShieldCheck,
        },
        {
          id: "diagnostics",
          label: t.settings.settingsTabDiagnostics,
          description: t.settings.settingsTabDiagnosticsDesc,
          icon: Wrench,
        },
      ] satisfies Array<{
        id: SettingsTabId;
        label: string;
        description: string;
        icon: LucideIcon;
      }>,
    [t],
  );

  const activeTabMeta =
    settingsTabs.find((tab) => tab.id === activeTab) ?? settingsTabs[0];

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
          ui: {
            ...draft.ui,
            language,
          },
          auth: {
            sessionTtlSec: draft.auth.sessionTtlSec,
          },
          publicQuery: draft.publicQuery,
          autoIngest: draft.autoIngest,
          autoLint: draft.autoLint,
        }),
      });
      if (!res.ok) throw await asError(res);
      const next = (await res.json()) as SettingsState;
      setState(next);
      setDraft({
        ...cloneConfig(next.config),
        ui: { ...next.config.ui, language },
      });
      setNotice(t.settings.savedNotice);
      router.refresh();
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
      setNotice(t.settings.passwordNotice);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const ActiveTabIcon = activeTabMeta.icon;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PageHeader
        eyebrow="local configuration"
        title={t.settings.title}
        meta={state?.projectRoot ?? t.settings.loadingRoot}
        actions={
          <>
            {busy ? <StatusBadge tone="running">{busy}</StatusBadge> : null}
            <Button
              onClick={() => void load()}
              disabled={busy != null}
              icon={RefreshCw}
            >
              {t.settings.refresh}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={busy != null || !draft}
              variant="primary"
              icon={Save}
            >
              {busy === "save" ? t.settings.saving : t.settings.save}
            </Button>
          </>
        }
      />

      {error ? (
        <div className="border-b border-danger/50 bg-danger/10 px-4 py-1 text-[11px] text-danger">
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
          {t.settings.loading}
        </div>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="grid min-h-full gap-4 p-4 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
              <nav className="rounded-md border border-line bg-bg-subtle/92 p-2 shadow-sm backdrop-blur-xl">
                <div className="px-2 py-2">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    {t.settings.settingsNavTitle}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                    {t.settings.settingsNavDesc}
                  </p>
                </div>
                <div className="mt-1 flex gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible xl:pb-0">
                  {settingsTabs.map((tab) => (
                    <SettingsTabButton
                      key={tab.id}
                      tab={tab}
                      active={activeTab === tab.id}
                      onClick={() => setActiveTab(tab.id)}
                    />
                  ))}
                </div>
              </nav>
            </aside>

            <section className="min-w-0 space-y-4">
              <div className="rounded-md border border-line bg-bg-panel/82 px-4 py-3 shadow-sm backdrop-blur-xl">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-bg-subtle text-accent">
                    <ActiveTabIcon aria-hidden className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                      {t.settings.settingsActiveSection}
                    </div>
                    <h2 className="mt-0.5 text-base font-semibold text-ink">
                      {activeTabMeta.label}
                    </h2>
                    <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-faint">
                      {activeTabMeta.description}
                    </p>
                  </div>
                </div>
              </div>

              {activeTab === "agent" ? (
                <Panel
                  title={t.settings.codingAgent}
                  eyebrow={t.settings.defaultCli}
                >
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
                        {t.settings.safeMode}
                      </span>
                      <span className="block text-xs text-ink-faint">
                        {t.settings.safeModeDesc}
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
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">
                        {t.settings.multiAgentCli}
                      </span>
                      <select
                        value={draft.agent.orchestration.cli ?? ""}
                        onChange={(e) =>
                          updateDraft((next) => {
                            next.agent.orchestration.cli =
                              e.target.value === ""
                                ? null
                                : (e.target.value as CliName);
                          })
                        }
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        <option value="">{t.settings.followDefaultCli}</option>
                        {CLI_NAMES.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumberField
                      label={t.settings.maxConcurrentAgents}
                      value={draft.agent.orchestration.maxConcurrentAgents}
                      min={1}
                      max={16}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.agent.orchestration.maxConcurrentAgents = value;
                        })
                      }
                    />
                    <TextField
                      label={t.settings.agentNamePrefix}
                      value={draft.agent.orchestration.namePrefix}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.agent.orchestration.namePrefix = value;
                        })
                      }
                    />
                    <TextField
                      label={t.settings.managerName}
                      value={draft.agent.orchestration.managerName}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.agent.orchestration.managerName = value;
                        })
                      }
                    />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                    {t.settings.agentOrchestrationDesc}
                  </p>
                </Panel>
              ) : null}

              {activeTab === "runtime" ? (
                <Panel
                  title={t.settings.runtimeDefaults}
                  eyebrow={t.settings.wikiOperation}
                >
                  <div className="grid gap-3 md:grid-cols-2">
                    <NumberField
                      label={t.settings.chunkMaxFiles}
                      value={draft.chunking.maxFiles}
                      min={1}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.chunking.maxFiles = value;
                        })
                      }
                    />
                    <NumberField
                      label={t.settings.chunkMaxBytes}
                      value={draft.chunking.maxBytes}
                      min={1024}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.chunking.maxBytes = value;
                        })
                      }
                    />
                    <NumberField
                      label={t.settings.minCommunitySize}
                      value={draft.graph.minCommunitySize}
                      min={1}
                      onChange={(value) =>
                        updateDraft((next) => {
                          next.graph.minCommunitySize = value;
                        })
                      }
                    />
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">
                        {t.settings.defaultTab}
                      </span>
                      <select
                        value={draft.ui.defaultTab}
                        onChange={(e) =>
                          updateDraft((next) => {
                            next.ui.defaultTab = e.target
                              .value as SettingsConfig["ui"]["defaultTab"];
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
                    <label className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">
                        {t.settings.uiLanguage}
                      </span>
                      <select
                        value={language}
                        onChange={(e) => {
                          const nextLanguage = e.target.value as Language;
                          updateDraft((next) => {
                            next.ui.language = nextLanguage;
                          });
                          void setLanguage(nextLanguage).catch(console.error);
                        }}
                        className="mt-1 block w-full rounded border border-line bg-bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                      >
                        <option value="ko">{t.common.korean}</option>
                        <option value="en">{t.common.english}</option>
                      </select>
                    </label>
                    <div className="rounded border border-line bg-bg px-3 py-2">
                      <span className="text-xs text-ink-faint">
                        {t.settings.uiTheme}
                      </span>
                      <div className="mt-1 grid grid-cols-3 gap-1 rounded border border-line bg-bg-subtle p-1">
                        {(["default", "light", "dark"] as const).map((themeOption) => (
                          <button
                            key={themeOption}
                            type="button"
                            onClick={() => {
                              updateDraft((next) => {
                                next.ui.theme = themeOption;
                              });
                              setTheme(themeOption);
                            }}
                            className={[
                              "h-8 rounded text-xs font-medium transition-colors",
                              draft.ui.theme === themeOption
                                ? "bg-accent text-bg"
                                : "text-ink-dim hover:bg-bg-panel hover:text-ink",
                            ].join(" ")}
                          >
                            {themeOption === "default"
                              ? t.settings.defaultTheme
                              : themeOption === "light"
                                ? t.settings.lightTheme
                                : t.settings.darkTheme}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <label className="mt-3 flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        {t.settings.autoGraph}
                      </span>
                      <span className="block text-xs text-ink-faint">
                        {t.settings.autoGraphDesc}
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
                  <label className="mt-3 flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        {t.settings.agentEdgePanel}
                      </span>
                      <span className="block text-xs text-ink-faint">
                        {t.settings.agentEdgePanelDesc}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.ui.agentEdgePanelEnabled}
                      onChange={(e) =>
                        updateDraft((next) => {
                          next.ui.agentEdgePanelEnabled = e.target.checked;
                        })
                      }
                      className="h-4 w-4 accent-accent"
                    />
                  </label>
                </Panel>
              ) : null}

              {activeTab === "automation" ? (
                <>
                  <AutoIngestPanel
                    draft={draft.autoIngest}
                    onChange={(nextAutoIngest) =>
                      updateDraft((next) => {
                        next.autoIngest = {
                          ...nextAutoIngest,
                          watch: { ...nextAutoIngest.watch },
                          schedule: { ...nextAutoIngest.schedule },
                        };
                      })
                    }
                  />

                  <AutoLintPanel
                    draft={draft.autoLint}
                    onChange={(nextAutoLint) =>
                      updateDraft((next) => {
                        next.autoLint = {
                          ...nextAutoLint,
                          counter: { ...nextAutoLint.counter },
                          cron: {
                            ...nextAutoLint.cron,
                            time: { ...nextAutoLint.cron.time },
                          },
                        };
                      })
                    }
                  />
                </>
              ) : null}

              {activeTab === "access" ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title={t.settings.server} eyebrow={t.settings.localWebUi}>
                    <div className="grid gap-3">
                      <TextField
                        label={t.settings.host}
                        value={draft.server.host}
                        onChange={(value) =>
                          updateDraft((next) => {
                            next.server.host = value;
                          })
                        }
                      />
                      <NumberField
                        label={t.settings.port}
                        value={draft.server.port}
                        min={1}
                        onChange={(value) =>
                          updateDraft((next) => {
                            next.server.port = value;
                          })
                        }
                      />
                      <p className="text-xs leading-relaxed text-ink-faint">
                        {t.settings.serverDesc}
                      </p>
                    </div>
                  </Panel>

                  <Panel title={t.settings.loginSession} eyebrow="auth">
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
                        {t.settings.keepSignedIn}
                      </button>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                      {t.settings.sessionDesc}
                    </p>
                  </Panel>

                  <Panel title={t.settings.publicQuery} eyebrow="share">
                    <label className="flex items-center justify-between gap-4 rounded border border-line bg-bg px-3 py-2">
                      <span>
                        <span className="block text-sm font-medium text-ink">
                          {t.settings.publicQueryEnabled}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {t.settings.publicQueryDesc}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.publicQuery.enabled}
                        onChange={(e) =>
                          updateDraft((next) => {
                            next.publicQuery.enabled = e.target.checked;
                          })
                        }
                        className="h-4 w-4 accent-accent"
                      />
                    </label>
                    <p className="mt-2 break-all font-mono text-[11px] text-ink-faint">
                      /clio
                    </p>
                  </Panel>

                  <Panel title={t.settings.password} eyebrow={t.settings.admin}>
                    <div className="space-y-3">
                      <TextField
                        label={t.settings.currentPassword}
                        type="password"
                        value={password.current}
                        onChange={(value) =>
                          setPassword((next) => ({ ...next, current: value }))
                        }
                      />
                      <TextField
                        label={t.settings.newPassword}
                        type="password"
                        value={password.next}
                        onChange={(value) =>
                          setPassword((next) => ({ ...next, next: value }))
                        }
                      />
                      <Button
                        onClick={() => void changePassword()}
                        disabled={busy != null || !password.current || !password.next}
                        icon={KeyRound}
                        className="w-full"
                      >
                        {busy === "password"
                          ? t.settings.changing
                          : t.settings.changePassword}
                      </Button>
                    </div>
                  </Panel>
                </div>
              ) : null}

              {activeTab === "diagnostics" ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title={t.settings.tools} eyebrow={t.settings.detected}>
                    <div className="space-y-2">
                      {state?.tools.map((tool) => (
                        <ToolRow key={tool.name} tool={tool} />
                      ))}
                    </div>
                  </Panel>

                  <Panel title={t.settings.configFiles} eyebrow={t.settings.paths}>
                    <div className="space-y-2 font-mono text-[11px] text-ink-faint">
                      <PathLine label="default" path={state?.configPaths.default} />
                      <PathLine label="local" path={state?.configPaths.local} />
                    </div>
                  </Panel>
                </div>
              ) : null}
            </section>
          </div>
        </main>
      )}
    </div>
  );
}

function SettingsTabButton({
  tab,
  active,
  onClick,
}: {
  tab: {
    id: SettingsTabId;
    label: string;
    description: string;
    icon: LucideIcon;
  };
  active: boolean;
  onClick: () => void;
}) {
  const Icon = tab.icon;

  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cx(
        "group flex min-w-52 items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors xl:min-w-0",
        active
          ? "border-accent bg-accent/10 text-ink shadow-[inset_3px_0_0_rgb(var(--color-accent))]"
          : "border-transparent text-ink-dim hover:border-line hover:bg-bg-panel/72 hover:text-ink",
      )}
    >
      <span
        className={cx(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          active
            ? "border-accent/40 bg-accent text-white"
            : "border-line bg-bg text-ink-faint group-hover:text-ink",
        )}
      >
        <Icon aria-hidden className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{tab.label}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-faint">
          {tab.description}
        </span>
      </span>
    </button>
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
  const { t } = useLanguage();
  const status = info?.path ? "ready" : "missing";
  const statusLabel =
    status === "ready" ? "ready" : t.settings.missing.toLowerCase();
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
            {info?.path ?? t.settings.notDetected}
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
          {selected ? t.settings.default : t.settings.use}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(status)}`}>
          {statusLabel}
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
        <span className="text-[11px] text-ink-faint">
          {t.settings.customPath}
        </span>
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
  const { t } = useLanguage();
  const statusLabel =
    tool.status === "ready" ? "ready" : t.settings.missing.toLowerCase();
  return (
    <div className="rounded border border-line bg-bg px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-semibold text-ink">
          {tool.name}
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(tool.status)}`}>
          {statusLabel}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
        {tool.path ?? t.settings.notDetected}
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
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-faint">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
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
