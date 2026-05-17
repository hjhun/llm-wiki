export type CliName = "codex" | "claude" | "gemini" | "cline";

export type CliInfo = {
  name: CliName;
  path: string | null;
  version: string | null;
  source: "config" | "PATH" | "missing";
};

export type ToolStatus = {
  name: "graphify" | "qmd" | "marp";
  status: "ready" | "missing";
  path: string | null;
  version: string | null;
  note: string;
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
  };
  chunking: {
    maxFiles: number;
    maxBytes: number;
  };
  graph: {
    minCommunitySize: number;
    autoUpdateOnIngest: boolean;
  };
  ui: {
    language: "ko" | "en";
    defaultTab: "chat" | "explorer" | "graph" | "settings";
  };
  auth: {
    passwordSet: boolean;
    sessionTtlSec: number | null;
  };
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
