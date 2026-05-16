#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const flags = new Set(process.argv.slice(3));

if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/next-from-config.mjs <dev|start> [--lan]");
  process.exit(2);
}

function detectProjectRoot() {
  if (process.env.PROJECT_ROOT) return path.resolve(process.env.PROJECT_ROOT);

  const markers = ["llm-wiki.md", "CLAUDE.md"];
  let cur = path.resolve(process.cwd());
  while (true) {
    if (markers.some((marker) => existsSync(path.join(cur, marker)))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return process.cwd();
    cur = parent;
  }
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function deepMerge(base, over) {
  if (over == null) return base;
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof over !== "object" ||
    Array.isArray(over)
  ) {
    return over;
  }

  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

function readServerConfig(projectRoot) {
  const fallback = { server: { host: "127.0.0.1", port: 7777 } };
  const defaultConfig = readJsonIfExists(
    path.join(projectRoot, "config", "default.json"),
  );
  const localConfig = readJsonIfExists(
    path.join(projectRoot, "config", "local.json"),
  );
  const config = deepMerge(deepMerge(fallback, defaultConfig), localConfig);
  return {
    host: String(config.server?.host ?? fallback.server.host),
    port: Number(config.server?.port ?? fallback.server.port),
  };
}

const projectRoot = detectProjectRoot();
const server = readServerConfig(projectRoot);
const host = process.env.HOST ?? (flags.has("--lan") ? "0.0.0.0" : server.host);
const port = Number(process.env.PORT ?? server.port);
const nextBin = path.join(process.cwd(), "node_modules", ".bin", "next");

console.log(
  `Starting Next ${mode} on ${host}:${port}` +
    (flags.has("--lan") ? " (LAN mode)" : ""),
);

const child = spawn(nextBin, [mode, "-H", host, "-p", String(port)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
