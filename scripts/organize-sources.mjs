#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const json = args.includes("--json");
const rootArg = readArg("--root");
const projectRoot = path.resolve(rootArg ?? process.cwd());
const wikiRoot = path.join(projectRoot, "wiki");
const sourcesRoot = path.join(wikiRoot, "sources");

const DATE_DIR_RE = /^(\d{4})\/(\d{4}-\d{2})\/([^/]+\.md)$/;

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: "", body: text };
  return {
    frontmatter: text.slice(4, end),
    body: text.slice(end + 4),
  };
}

function parseField(frontmatter, name) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function parseSourceList(frontmatter) {
  const raw = parseField(frontmatter, "sources");
  if (!raw) return [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [raw];
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err?.code === "ENOENT") return [];
    throw err;
  });
  const out = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

function trimRawPath(value) {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^\.?\/*/, "")
    .replace(/#.*$/, "");
}

function firstRawPath(frontmatter) {
  const rawPath = parseField(frontmatter, "raw_path");
  if (rawPath && trimRawPath(rawPath).startsWith("raw/")) {
    return trimRawPath(rawPath);
  }

  const sourcePaths = parseSourceList(frontmatter);
  return sourcePaths.map(trimRawPath).find((sourcePath) => sourcePath.startsWith("raw/")) ?? null;
}

function sourceTargetFromRawPath(rawPath) {
  const rawRel = rawPath.slice("raw/".length).replace(/^\/+/, "");
  if (!rawRel || rawRel.endsWith("/")) {
    return `${rawRel}index.md`;
  }

  const parsed = path.posix.parse(rawRel);
  const name = parsed.ext ? parsed.name : parsed.base;
  return path.posix.join(parsed.dir, `${name}.md`);
}

function candidateTarget(rel, frontmatter) {
  const rawPath = firstRawPath(frontmatter);
  if (!rawPath) return { target: rel, reason: "missing raw_path" };

  const target = sourceTargetFromRawPath(rawPath);
  if (target === rel) return { target: rel, reason: "already raw mirror" };

  const dateDir = rel.match(DATE_DIR_RE);
  return {
    target,
    reason: dateDir ? "migrate dated source to raw mirror" : "raw_path",
  };
}

async function uniqueTarget(rel, occupied) {
  if (!occupied.has(rel)) return rel;
  const parsed = path.parse(rel);
  for (let index = 2; ; index += 1) {
    const next = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    const posix = toPosix(next);
    if (!occupied.has(posix)) return posix;
  }
}

async function buildPlan() {
  const files = await walk(sourcesRoot);
  const occupied = new Set(files.map((file) => toPosix(path.relative(sourcesRoot, file))));
  const moves = [];

  for (const fileAbs of files) {
    const rel = toPosix(path.relative(sourcesRoot, fileAbs));
    const text = await fs.readFile(fileAbs, "utf8");
    const { frontmatter } = parseFrontmatter(text);
    const { target: desired, reason } = candidateTarget(rel, frontmatter);
    if (desired === rel) continue;

    occupied.delete(rel);
    const target = await uniqueTarget(desired, occupied);
    occupied.add(target);
    if (target === rel) continue;
    moves.push({ from: `wiki/sources/${rel}`, to: `wiki/sources/${target}`, reason });
  }

  return moves;
}

async function ensureParent(abs) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
}

async function updateReferences(moves) {
  const markdownFiles = await walk(wikiRoot);
  const replacements = moves.flatMap((move) => {
    const fromNoExt = move.from.replace(/\.md$/, "");
    const toNoExt = move.to.replace(/\.md$/, "");
    return [
      [move.from, move.to],
      [fromNoExt, toNoExt],
    ];
  });

  const changed = [];
  for (const fileAbs of markdownFiles) {
    const rel = toPosix(path.relative(projectRoot, fileAbs));
    if (rel === "wiki/log.md") continue;
    let text = await fs.readFile(fileAbs, "utf8");
    const before = text;
    for (const [from, to] of replacements) {
      text = text.replace(new RegExp(escapeRegExp(from), "g"), to);
    }
    if (text !== before) {
      await fs.writeFile(fileAbs, text, "utf8");
      changed.push(rel);
    }
  }
  return changed;
}

async function appendLog(moves, changedRefs) {
  if (moves.length === 0) return;
  const logPath = path.join(wikiRoot, "log.md");
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const moved = moves.map((move) => `\`${move.from}\` -> \`${move.to}\``).join(", ");
  const refs = changedRefs.length ? changedRefs.map((file) => `\`${file}\``).join(", ") : "none";
  const entry = `\n## [${stamp}] lint | source raw-mirror layout\n- Moved sources: ${moved}\n- Updated references: ${refs}\n`;
  await fs.appendFile(logPath, entry, "utf8");
}

async function applyPlan(moves) {
  for (const move of moves) {
    const fromAbs = path.join(projectRoot, move.from);
    const toAbs = path.join(projectRoot, move.to);
    await ensureParent(toAbs);
    await fs.rename(fromAbs, toAbs);
  }
  const changedRefs = await updateReferences(moves);
  await appendLog(moves, changedRefs);
  return changedRefs;
}

const moves = await buildPlan();
let changedReferences = [];
if (apply && moves.length > 0) {
  changedReferences = await applyPlan(moves);
}

const result = {
  apply,
  moveCount: moves.length,
  moves,
  changedReferences,
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (moves.length === 0) {
  process.stdout.write("No source raw-mirror moves needed.\n");
} else {
  process.stdout.write(`${apply ? "Moved" : "Would move"} ${moves.length} source page(s):\n`);
  for (const move of moves) {
    process.stdout.write(`- ${move.from} -> ${move.to} (${move.reason})\n`);
  }
  if (apply) {
    process.stdout.write(`Updated ${changedReferences.length} referencing file(s).\n`);
  }
}
