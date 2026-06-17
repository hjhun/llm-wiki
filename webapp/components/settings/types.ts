export type CliName = "codex" | "claude" | "agy" | "cline";

export type CliInfo = {
  name: CliName;
  path: string | null;
  version: string | null;
  source: "config" | "PATH" | "missing";
};

export type ToolStatus = {
  name: "graphify" | "qmd" | "marp" | "bwrap";
  status: "ready" | "warning" | "missing";
  path: string | null;
  version: string | null;
  note: string;
  details?: Record<string, string | number | boolean | null>;
};

export type ReleaseInfo = {
  repo: string;
  installScriptUrl: string;
  currentVersion: string | null;
  latestVersion: string | null;
  latestName: string | null;
  latestUrl: string | null;
  latestPublishedAt: string | null;
  currentRef: string | null;
  currentCommit: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  note: string;
};

export type UpdateResult = {
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string;
  command: string;
};

export type TelegramAllowlistEntry = {
  chatId: number;
  kind: "private" | "group" | "channel";
  label: string;
  permission: "query" | "trusted";
  approvedAt: string;
};

export type TelegramPendingEntry = {
  chatId: number;
  kind: "private" | "group" | "channel";
  label: string;
  firstSeenAt: string;
  lastMessagePreview: string;
};

export type TelegramSettings = {
  enabled: boolean;
  botTokenSet: boolean;
  mode: "polling" | "webhook";
  webhookPublicUrl: string | null;
  webhookSecretSet: boolean;
  allowlist: TelegramAllowlistEntry[];
  pending: TelegramPendingEntry[];
  rejectionMessage: string;
  historyTurns: number;
  replyMaxChars: number;
  allowExternalLookup: boolean;
};

export type SettingsConfig = {
  server: {
    port: number;
    host: string;
  };
  agent: {
    default: CliName | null;
    safeMode: boolean;
    paths: Partial<Record<CliName, string>>;
    roles: {
      maintenance: CliName | null;
      query: CliName | null;
    };
    orchestration: {
      cli: CliName | null;
      maxConcurrentAgents: number;
      namePrefix: string;
      managerName: string;
    };
  };
  cli: {
    streamTokens: boolean;
    ingestLoop: {
      maxStagnantRounds: number;
    };
  };
  chunking: {
    maxFiles: number;
    maxBytes: number;
  };
  graph: {
    minCommunitySize: number;
    extraction: {
      profile: "wiki" | "code" | "deep";
      scope: "wiki" | "wiki+raw";
      maxNodesPerLeaf: number;
      maxConceptsPerSource: number;
      minConfidence: number;
      includeRationaleNodes: boolean;
      includeSemanticSimilarity: boolean;
      includeHyperedges: boolean;
      dropIsolatedDerivedNodes: boolean;
      proseEdges: "explicit" | "explicit+semantic";
      facetEdges: boolean;
      semanticMinConfidence: number;
      codeModel: "per-project-graphify-out";
      projectsDir: string;
      projectAnalysisDir: string;
    };
    autoUpdateOnIngest: boolean;
    autoUpdateStrategy: "auto" | "finalOnly" | "partialAndFinal";
    partialThresholds: {
      minLeaves: number;
      minFiles: number;
      minBytes: number;
      minSubChunks: number;
    };
  };
  search: {
    qmd: {
      enabled: boolean;
      autoUpdateOnWikiChange: boolean;
      scope: "wiki" | "wiki+raw";
      defaultNoRerank: boolean;
      embedEnabled: boolean;
    };
  };
  ui: {
    language: "ko" | "en";
    theme: "default" | "light" | "dark";
    appSubtitle: string;
    defaultTab: "chat" | "explorer" | "graph" | "automations" | "settings";
    agentEdgePanelEnabled: boolean;
  };
  auth: {
    passwordSet: boolean;
    sessionTtlSec: number | null;
  };
  publicQuery: {
    enabled: boolean;
    accessTokenSet: boolean;
    allowExternalLookup: boolean;
    sandboxEnabled: boolean;
    sandboxReadOnlyHomePaths: string[];
  };
  telegram: TelegramSettings;
  autoIngest: {
    enabled: boolean;
    mode: "watch" | "schedule";
    watch: { debounceMs: number };
    schedule: { intervalMinutes: number };
    skipIfBusy: boolean;
  };
  autoLint: {
    enabled: boolean;
    counter: { threshold: number };
    cron: {
      enabled: boolean;
      preset: "daily" | "weekly" | "monthly";
      time: { hour: number; minute: number };
      dayOfWeek: number;
      dayOfMonth: number;
    };
    fix: boolean;
    skipIfBusy: boolean;
  };
};

export type SettingsState = {
  projectRoot: string;
  configPaths: {
    root: string;
    default: string;
    local: string;
  };
  config: SettingsConfig;
  cli: CliInfo[];
  tools: ToolStatus[];
};
