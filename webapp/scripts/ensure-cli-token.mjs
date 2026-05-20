#!/usr/bin/env node

// Ensure config/local.json contains auth.cliToken so the local `clio` CLI
// can authenticate against the webapp HTTP API. Idempotent: if the token
// already exists, leaves the file untouched and prints "exists".
//
// Invoked by setup.sh after the webapp build. Safe to run standalone:
//   node webapp/scripts/ensure-cli-token.mjs
//
// Exit codes:
//   0 — token already present or successfully written
//   2 — config/local.json could not be parsed
//
// Prints "exists" or "generated" to stdout so callers can tell which path
// was taken without scraping the JSON.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

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

function readJsonOrEmpty(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(
      `[ensure-cli-token] failed to parse ${filePath}: ${
        err?.message ?? err
      }`,
    );
    process.exit(2);
  }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms that ignore the bits.
  }
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function newCliToken() {
  return "clio_" + randomBytes(32).toString("hex");
}

const projectRoot = detectProjectRoot();
const configDir = path.join(projectRoot, "config");
const localPath = path.join(configDir, "local.json");

const local = readJsonOrEmpty(localPath);
local.auth =
  typeof local.auth === "object" && local.auth !== null ? local.auth : {};

if (typeof local.auth.cliToken === "string" && local.auth.cliToken.length > 0) {
  console.log("[ensure-cli-token] exists");
  process.exit(0);
}

local.auth.cliToken = newCliToken();
writeJsonAtomic(localPath, local);
console.log("[ensure-cli-token] generated");
