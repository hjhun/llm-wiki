#!/usr/bin/env node
// Deterministic post-merge mini-lint.
//
// Runs three fast structural checks the LLM lint workflow does not need to
// repeat on every ingest cycle:
//
//   1. Near-duplicate concept/entity pages — normalized title collisions.
//   2. Broken wikilinks — `[[wiki/...]]` references whose target file does
//      not exist on disk.
//   3. Orphan synthesis pages — wiki/concepts, wiki/entities, wiki/answers,
//      wiki/comparisons, wiki/code pages with no inbound wikilink from any
//      other wiki page.
//
// Default writes a Markdown report to wiki/lint/post-merge-<YYYY-MM-DD>.md
// and prints a one-line summary to stderr. --json emits findings to stdout.
// --check exits with code 1 when any finding is present (CI / merge gate).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const json = args.includes("--json");
const check = args.includes("--check");
const quiet = args.includes("--quiet");
const noReport = args.includes("--no-report");
const rootArg = readArg("--root");
const projectRoot = path.resolve(rootArg ?? process.cwd());
const wikiRoot = path.join(projectRoot, "wiki");

// Synthesis page roots that should not be orphaned. Sources and the index/log
// are excluded — source pages are evidence cards and are allowed to be linked
// only by the synthesis layer; if a source is orphaned, the lint workflow
// surfaces it under its own category.
const SYNTHESIS_DIRS = [
  "wiki/concepts",
  "wiki/entities",
  "wiki/answers",
  "wiki/comparisons",
  "wiki/code",
];

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function walkMarkdown(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err?.code === "ENOENT") return [];
    throw err;
  });
  const out = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip transient progress / archive / lint output directories.
      if (
        entry.name === ".progress" ||
        entry.name === "archive" ||
        entry.name === "lint"
      ) {
        continue;
      }
      out.push(...(await walkMarkdown(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
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

function normalizeTitleKey(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{Diacritic}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(model|page|system|framework|library)$/u, "");
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;

function extractWikilinks(text) {
  const links = [];
  let m;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    links.push(raw);
  }
  return links;
}

function isUnderSynthesisDir(relPath) {
  return SYNTHESIS_DIRS.some(
    (dir) => relPath === dir || relPath.startsWith(`${dir}/`),
  );
}

async function fileExists(absPath) {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveLinkTarget(rawTarget) {
  // Accept both with and without .md, and treat trailing slash as <dir>/index.md.
  const candidates = [];
  const t = rawTarget.replace(/^\.?\/*/, "");
  if (t.endsWith("/")) {
    candidates.push(`${t}index.md`);
  } else if (t.endsWith(".md")) {
    candidates.push(t);
  } else {
    candidates.push(`${t}.md`);
    candidates.push(`${t}/index.md`);
  }
  for (const candidate of candidates) {
    const abs = path.join(projectRoot, candidate);
    if (await fileExists(abs)) return candidate;
  }
  return null;
}

async function collectPages() {
  const files = await walkMarkdown(wikiRoot);
  const pages = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(projectRoot, abs));
    const text = await fs.readFile(abs, "utf8");
    const fm = parseFrontmatter(text);
    const title = fm ? parseScalar(fm, "title") : null;
    const type = fm ? parseScalar(fm, "type") : null;
    pages.push({
      abs,
      rel,
      relNoExt: rel.replace(/\.md$/, ""),
      title: title ?? rel.replace(/\.md$/, ""),
      type,
      text,
    });
  }
  return pages;
}

function findDuplicateTitles(pages) {
  const groups = new Map();
  for (const page of pages) {
    if (!page.type || page.type === "source" || page.type === "index" || page.type === "log") {
      continue;
    }
    const key = normalizeTitleKey(page.title);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(page);
    groups.set(key, bucket);
  }
  const findings = [];
  for (const [key, bucket] of groups.entries()) {
    if (bucket.length < 2) continue;
    findings.push({
      key,
      pages: bucket.map((p) => ({ path: p.rel, title: p.title })),
    });
  }
  findings.sort((a, b) => a.key.localeCompare(b.key));
  return findings;
}

async function findBrokenWikilinks(pages) {
  const findings = [];
  for (const page of pages) {
    const targets = extractWikilinks(page.text);
    const seen = new Set();
    for (const target of targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      // Only check links that point inside wiki/ — `[[Page Name]]` shorthand
      // would need an index lookup beyond what this fast check does.
      if (!target.startsWith("wiki/")) continue;
      const resolved = await resolveLinkTarget(target);
      if (!resolved) {
        findings.push({
          from: page.rel,
          target,
        });
      }
    }
  }
  findings.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target));
  return findings;
}

function findOrphans(pages) {
  // Build inbound link index: for each page, who links to it?
  const refsByTarget = new Map();
  for (const page of pages) {
    const targets = new Set(extractWikilinks(page.text));
    for (const rawTarget of targets) {
      const normalized = rawTarget
        .replace(/^\.?\/*/, "")
        .replace(/\.md$/, "")
        .replace(/\/$/, "");
      if (!refsByTarget.has(normalized)) refsByTarget.set(normalized, new Set());
      refsByTarget.get(normalized).add(page.rel);
    }
  }

  const findings = [];
  for (const page of pages) {
    if (!isUnderSynthesisDir(page.rel)) continue;
    // index pages are entry points, not orphans.
    if (path.posix.basename(page.rel) === "index.md") continue;
    const key = page.relNoExt;
    const inbound = refsByTarget.get(key);
    const inboundFromOthers = inbound
      ? [...inbound].filter((src) => src !== page.rel)
      : [];
    if (inboundFromOthers.length === 0) {
      findings.push({ page: page.rel, title: page.title });
    }
  }
  findings.sort((a, b) => a.page.localeCompare(b.page));
  return findings;
}

function renderReport(findings, generatedAt) {
  const lines = [
    "---",
    "title: Post-Merge Mini Lint",
    "type: log",
    "tags: [lint, post-merge, deterministic]",
    `updated: ${generatedAt}`,
    "---",
    "",
    `> Deterministic post-merge lint. Generated by \`scripts/mini-lint.mjs\` at ${generatedAt}.`,
    "> Complements the LLM \`wiki-lint\` workflow with three fast structural checks.",
    "",
    `## Summary`,
    `- Near-duplicate titles: **${findings.duplicates.length}**`,
    `- Broken wikilinks: **${findings.brokenLinks.length}**`,
    `- Orphan synthesis pages: **${findings.orphans.length}**`,
    "",
    "## Near-Duplicate Titles",
  ];
  if (findings.duplicates.length === 0) {
    lines.push("- (none)");
  } else {
    for (const group of findings.duplicates) {
      lines.push(`- **${group.key}**`);
      for (const p of group.pages) {
        lines.push(`  - [[${p.path.replace(/\.md$/, "")}|${p.title}]] · \`${p.path}\``);
      }
    }
  }
  lines.push("", "## Broken Wikilinks");
  if (findings.brokenLinks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const broken of findings.brokenLinks) {
      lines.push(`- \`${broken.from}\` → \`[[${broken.target}]]\``);
    }
  }
  lines.push("", "## Orphan Synthesis Pages");
  if (findings.orphans.length === 0) {
    lines.push("- (none)");
  } else {
    for (const orphan of findings.orphans) {
      lines.push(`- \`${orphan.page}\` — *${orphan.title}*`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const pages = await collectPages();
  const duplicates = findDuplicateTitles(pages);
  const brokenLinks = await findBrokenWikilinks(pages);
  const orphans = findOrphans(pages);
  const findings = { duplicates, brokenLinks, orphans };
  const totals = {
    pages: pages.length,
    duplicates: duplicates.length,
    brokenLinks: brokenLinks.length,
    orphans: orphans.length,
  };

  const generatedAt = new Date().toISOString().slice(0, 10);
  const report = renderReport(findings, generatedAt);

  let reportPath = null;
  if (!noReport) {
    const lintDir = path.join(wikiRoot, "lint");
    await fs.mkdir(lintDir, { recursive: true });
    reportPath = path.join(lintDir, `post-merge-${generatedAt}.md`);
    await fs.writeFile(reportPath, report, "utf8");
  }

  const reportRel = reportPath
    ? toPosix(path.relative(projectRoot, reportPath))
    : null;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          totals,
          findings,
          reportPath: reportRel,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (!quiet) {
    const summary =
      `[mini-lint] pages=${totals.pages} ` +
      `duplicates=${totals.duplicates} ` +
      `broken=${totals.brokenLinks} ` +
      `orphans=${totals.orphans}` +
      (reportRel ? ` report=${reportRel}` : "");
    process.stderr.write(`${summary}\n`);
  }

  if (check) {
    const any = totals.duplicates + totals.brokenLinks + totals.orphans;
    if (any > 0) process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[mini-lint] ${err?.stack ?? err}\n`);
  process.exit(2);
});
