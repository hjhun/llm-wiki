#!/usr/bin/env node
// Deterministic builder for wiki/sources/index.md.
//
// Walks wiki/sources/, parses each source page's frontmatter, and emits a
// faceted catalog (recently updated, by topic, entity, source_kind, status,
// source_date, plus a full alphabetical list by raw_path prefix).
//
// LLM merge passes may append supplemental prose after the
// `<!-- clio:sources-index:custom -->` marker; the deterministic header is
// rewritten on every run, but anything past the marker is preserved.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const json = args.includes("--json");
const check = args.includes("--check");
const rootArg = readArg("--root");
const projectRoot = path.resolve(rootArg ?? process.cwd());
const wikiRoot = path.join(projectRoot, "wiki");
const sourcesRoot = path.join(wikiRoot, "sources");
const indexPath = path.join(sourcesRoot, "index.md");

const CUSTOM_MARKER = "<!-- clio:sources-index:custom -->";
const RECENT_LIMIT = 30;

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  return text.slice(4, end);
}

function parseScalar(frontmatter, name) {
  const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function parseList(frontmatter, name) {
  const raw = parseScalar(frontmatter, name);
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

async function collectSources() {
  const files = await walk(sourcesRoot);
  const records = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(sourcesRoot, abs));
    // index.md is generated; never include it as a source entry.
    if (rel === "index.md") continue;
    const text = await fs.readFile(abs, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const type = parseScalar(fm, "type");
    // Only consider source pages. Other page types should not pollute the
    // source catalog even if they happen to live under wiki/sources/.
    if (type && type !== "source") continue;
    const title = parseScalar(fm, "title") ?? rel.replace(/\.md$/, "");
    records.push({
      wikiPath: `wiki/sources/${rel}`,
      relPath: rel,
      title,
      source_kind: parseScalar(fm, "source_kind"),
      source_date: parseScalar(fm, "source_date"),
      raw_path: parseScalar(fm, "raw_path"),
      language: parseScalar(fm, "language"),
      status: parseScalar(fm, "status"),
      updated: parseScalar(fm, "updated"),
      topics: parseList(fm, "topics"),
      entities: parseList(fm, "entities"),
      concepts: parseList(fm, "concepts"),
      projects: parseList(fm, "projects"),
      tags: parseList(fm, "tags"),
    });
  }
  records.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return records;
}

function fmtLink(record) {
  // Strip the .md extension so the wikilink matches CLAUDE.md conventions.
  const pageRef = record.wikiPath.replace(/\.md$/, "");
  return `[[${pageRef}|${record.title}]]`;
}

function groupBy(records, key) {
  const groups = new Map();
  for (const record of records) {
    const value = record[key];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    if (values.length === 0) {
      const bucket = groups.get("(unspecified)") ?? [];
      bucket.push(record);
      groups.set("(unspecified)", bucket);
      continue;
    }
    for (const v of values) {
      const bucket = groups.get(v) ?? [];
      bucket.push(record);
      groups.set(v, bucket);
    }
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function compareDateDesc(a, b) {
  // Empty/null dates sort last under descending order.
  const av = a || "";
  const bv = b || "";
  if (av === bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return bv.localeCompare(av);
}

function renderSection(title, lines) {
  return [`## ${title}`, "", ...lines, ""].join("\n");
}

function renderRecentlyUpdated(records) {
  const sorted = [...records].sort((a, b) => compareDateDesc(a.updated, b.updated));
  const top = sorted.slice(0, RECENT_LIMIT);
  const lines = top.map((r) => {
    const date = r.updated ? `\`${r.updated}\`` : "`—`";
    return `- ${date} · ${fmtLink(r)}`;
  });
  if (lines.length === 0) lines.push("- (no sources yet)");
  return renderSection(`Recently Updated (top ${RECENT_LIMIT})`, lines);
}

function renderFacet(title, records, key) {
  const groups = groupBy(records, key);
  const lines = [];
  for (const [groupName, items] of groups) {
    lines.push(`- **${groupName}** (${items.length})`);
    for (const r of items) {
      lines.push(`  - ${fmtLink(r)}`);
    }
  }
  if (lines.length === 0) lines.push("- (none)");
  return renderSection(title, lines);
}

function renderByDate(records) {
  const sorted = [...records].sort((a, b) => compareDateDesc(a.source_date, b.source_date));
  const lines = [];
  let currentBucket = null;
  for (const r of sorted) {
    const bucket = r.source_date ? r.source_date.slice(0, 7) : "(unknown)";
    if (bucket !== currentBucket) {
      if (currentBucket !== null) lines.push("");
      lines.push(`- **${bucket}**`);
      currentBucket = bucket;
    }
    const sd = r.source_date ? `\`${r.source_date}\`` : "`—`";
    lines.push(`  - ${sd} · ${fmtLink(r)}`);
  }
  if (lines.length === 0) lines.push("- (none)");
  return renderSection("By Source Date", lines);
}

function renderStatus(records) {
  const needsReview = records.filter(
    (r) => r.status === "needs_review" || r.status === "partial",
  );
  const lines = needsReview.map((r) => `- \`${r.status}\` · ${fmtLink(r)}`);
  if (lines.length === 0) lines.push("- (none — all sources are summarized)");
  return renderSection("Needs Review", lines);
}

function renderFullList(records) {
  const lines = records.map((r) => {
    const rp = r.raw_path ? `\`${r.raw_path}\`` : "`—`";
    return `- ${fmtLink(r)} · ${rp}`;
  });
  if (lines.length === 0) lines.push("- (none)");
  return renderSection("All Sources (by path)", lines);
}

function buildIndex(records, generatedAt) {
  const header = [
    "---",
    "title: Source Catalog",
    "type: index",
    "tags: [sources, catalog]",
    `updated: ${generatedAt}`,
    "---",
    "",
    "<!-- clio:sources-index:generated -->",
    "",
    `> Generated by \`scripts/build-sources-index.mjs\` at ${generatedAt}.`,
    "> The header section is rewritten deterministically on every run.",
    `> LLM-authored prose may live after the \`${CUSTOM_MARKER}\` marker below.`,
    "",
    `Total sources: **${records.length}**`,
    "",
  ].join("\n");

  const sections = [
    renderRecentlyUpdated(records),
    renderStatus(records),
    renderFacet("By Topic", records, "topics"),
    renderFacet("By Entity", records, "entities"),
    renderFacet("By Source Kind", records, "source_kind"),
    renderFacet("By Project", records, "projects"),
    renderByDate(records),
    renderFullList(records),
  ];

  // End on the marker with no trailing newline. Any user-authored content
  // appended after the marker is preserved verbatim by readExistingCustom();
  // a fresh write yields no trailing newline so re-runs are idempotent.
  return `${header}\n${sections.join("\n")}${CUSTOM_MARKER}`;
}

async function readExistingCustom() {
  try {
    const text = await fs.readFile(indexPath, "utf8");
    // The marker string also appears inside the generated header's instructions
    // ("prose may live after the `<!-- ... -->` marker below."), so we must
    // anchor on the LAST occurrence, which is the real boundary at end of file.
    const idx = text.lastIndexOf(CUSTOM_MARKER);
    if (idx === -1) return "";
    return text.slice(idx + CUSTOM_MARKER.length);
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

async function main() {
  const records = await collectSources();
  // ISO date in UTC, day precision — keeps the file stable across re-runs on
  // the same day and avoids spurious diffs.
  const generatedAt = new Date().toISOString().slice(0, 10);
  const generated = buildIndex(records, generatedAt);
  const custom = await readExistingCustom();
  const next = generated + custom;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          total: records.length,
          indexPath: toPosix(path.relative(projectRoot, indexPath)),
        },
        null,
        2,
      ) + "\n",
    );
  }

  if (check) {
    let prev = "";
    try {
      prev = await fs.readFile(indexPath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (prev !== next) {
      process.stderr.write(
        `[build-sources-index] wiki/sources/index.md is out of date; run scripts/build-sources-index.mjs\n`,
      );
      process.exit(1);
    }
    return;
  }

  await fs.mkdir(sourcesRoot, { recursive: true });
  await fs.writeFile(indexPath, next, "utf8");
  if (!json) {
    process.stdout.write(
      `[build-sources-index] wrote ${toPosix(path.relative(projectRoot, indexPath))} (${records.length} sources)\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[build-sources-index] ${err?.stack ?? err}\n`);
  process.exit(1);
});
