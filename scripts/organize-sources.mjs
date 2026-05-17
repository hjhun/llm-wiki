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
const rawRoot = path.join(projectRoot, "raw");

const DATE_DIR_RE = /^(\d{4})\/(\d{4}-\d{2})\/([^/]+\.md)$/;
const ISO_DATE_RE = /\b((?:19|20)\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/;
const YEAR_MONTH_RE = /\b((?:19|20)\d{2})[-/.](0[1-9]|1[0-2])\b/;
const KOREAN_YEAR_MONTH_RE = /((?:19|20)\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월/;
const YEAR_ONLY_RE = /\b((?:19|20)\d{2})\b/;

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

function padMonth(value) {
  return String(Number(value)).padStart(2, "0");
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

function parseDateHint(text) {
  const iso = text.match(ISO_DATE_RE);
  if (iso) return { year: iso[1], month: iso[2], strongMonth: true };

  const yearMonth = text.match(YEAR_MONTH_RE);
  if (yearMonth) {
    return { year: yearMonth[1], month: yearMonth[2], strongMonth: true };
  }

  const korean = text.match(KOREAN_YEAR_MONTH_RE);
  if (korean) {
    return {
      year: korean[1],
      month: padMonth(korean[2]),
      strongMonth: true,
    };
  }

  const yearOnly = text.match(YEAR_ONLY_RE);
  if (yearOnly) return { year: yearOnly[1], month: null, strongMonth: false };
  return null;
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
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

async function fallbackDate(fileAbs, sourcePaths, updated) {
  for (const sourcePath of sourcePaths) {
    if (!sourcePath.startsWith("raw/")) continue;
    const rawRel = sourcePath.slice("raw/".length);
    const rawStat = await statOrNull(path.join(rawRoot, rawRel));
    if (rawStat) return rawStat.mtime;
  }

  if (updated) {
    const updatedDate = new Date(updated);
    if (!Number.isNaN(updatedDate.valueOf())) return updatedDate;
  }

  const fileStat = await fs.stat(fileAbs);
  return fileStat.mtime;
}

async function inferChronology(fileAbs, rel, text) {
  const { frontmatter, body } = parseFrontmatter(text);
  const sourceDate = parseField(frontmatter, "source_date");
  const updated = parseField(frontmatter, "updated");
  const sourcePaths = parseSourceList(frontmatter);
  const fallback = await fallbackDate(fileAbs, sourcePaths, updated);
  const fallbackYear = String(fallback.getFullYear());
  const fallbackMonth = String(fallback.getMonth() + 1).padStart(2, "0");

  const sourceDateHint = sourceDate ? parseDateHint(sourceDate) : null;
  const bodyHint = parseDateHint(body);
  const rawPathHint = parseDateHint(sourcePaths.join("\n"));
  const hint = sourceDateHint ?? bodyHint ?? rawPathHint;

  if (hint) {
    return {
      year: hint.year,
      month: hint.month ?? fallbackMonth,
      strongMonth: hint.strongMonth,
      reason: sourceDateHint
        ? "source_date"
        : bodyHint
          ? "body"
          : "raw path",
    };
  }

  const dateDir = rel.match(DATE_DIR_RE);
  if (dateDir) {
    return {
      year: dateDir[1],
      month: dateDir[2].slice(5),
      strongMonth: false,
      reason: "existing dated path",
    };
  }

  return {
    year: fallbackYear,
    month: fallbackMonth,
    strongMonth: false,
    reason: updated ? "updated/raw mtime fallback" : "mtime fallback",
  };
}

function candidateTarget(rel, chronology) {
  const dated = rel.match(DATE_DIR_RE);
  if (dated) {
    const currentMonth = dated[2];
    const inferredMonth = `${chronology.year}-${chronology.month}`;
    if (!chronology.strongMonth || currentMonth === inferredMonth) {
      return rel;
    }
  }
  return `${chronology.year}/${chronology.year}-${chronology.month}/${path.basename(rel)}`;
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
    const chronology = await inferChronology(fileAbs, rel, text);
    const desired = candidateTarget(rel, chronology);
    if (desired === rel) continue;

    occupied.delete(rel);
    const target = await uniqueTarget(desired, occupied);
    occupied.add(target);
    moves.push({ from: `wiki/sources/${rel}`, to: `wiki/sources/${target}`, reason: chronology.reason });
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
  const entry = `\n## [${stamp}] lint | source chronology layout\n- Moved sources: ${moved}\n- Updated references: ${refs}\n`;
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
  process.stdout.write("No source chronology moves needed.\n");
} else {
  process.stdout.write(`${apply ? "Moved" : "Would move"} ${moves.length} source page(s):\n`);
  for (const move of moves) {
    process.stdout.write(`- ${move.from} -> ${move.to} (${move.reason})\n`);
  }
  if (apply) {
    process.stdout.write(`Updated ${changedReferences.length} referencing file(s).\n`);
  }
}
