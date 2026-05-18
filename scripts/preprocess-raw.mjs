#!/usr/bin/env node

// Deterministic mover/cleaner for /preprocess.
//
// Two subcommands:
//   plan   --target <raw subpath> --rules-file <rules.json> --out <plan.json>
//   apply  --plan-file <plan.json>
//
// The wiki-preprocess skill drives this script. The LLM translates the
// user's noise description into a rules JSON, then runs `plan` to get a
// machine-readable proposal (no filesystem mutation), shows the user a
// summary, and only on /preprocess --apply runs this script in `apply`
// mode. Apply moves whole files to raw/.trash/<ts>_<basename> and, for
// content-level "strip" rules, backs the original up the same way before
// writing the cleaned bytes back to the original path.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const subcommand = args[0];

const rootArg = readArg("--root");
const projectRoot = path.resolve(rootArg ?? process.cwd());
const rawRoot = path.join(projectRoot, "raw");
const trashRoot = path.join(rawRoot, ".trash");

// Directories under raw/ that must never be scanned or trashed.
const EXCLUDED_DIR_NAMES = new Set([".trash", ".cleaned", ".preview"]);
// Files that must never be trashed regardless of rule match.
const PROTECTED_BASENAMES = new Set([".gitkeep"]);

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureInsideRaw(absPath, label) {
  const rel = path.relative(rawRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must be inside raw/: ${absPath}`);
  }
}

// Compile one glob like "**/*.{html,md}" to a RegExp anchored to a POSIX
// relative path. Supports **, *, ?, and {a,b,c} alternation.
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?";
          i += 1;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
        continue;
      }
      const alts = glob.slice(i + 1, close).split(",").map(escapeRe);
      re += `(?:${alts.join("|")})`;
      i = close;
    } else {
      re += escapeRe(ch);
    }
  }
  re += "$";
  return new RegExp(re);
}

function escapeRe(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// JS regexes don't accept inline flag modifiers like (?s) or (?im). Most
// LLM-generated rules will reach for that Perl/Python form, so strip a
// leading (?flags) and fold the flag chars into the explicit flags string.
function liftInlineFlags(pattern, extraFlags) {
  const match = pattern.match(/^\(\?([gimsuy]+)\)/);
  if (!match) return { pattern, flags: extraFlags };
  const flagSet = new Set((extraFlags ?? "").split(""));
  for (const ch of match[1]) flagSet.add(ch);
  return { pattern: pattern.slice(match[0].length), flags: [...flagSet].join("") };
}

function buildRegex(pattern, extraFlags) {
  const lifted = liftInlineFlags(pattern, extraFlags);
  return new RegExp(lifted.pattern, lifted.flags);
}

async function walk(dir, baseAbs, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !entry.name.startsWith(".cleaned")) {
        continue;
      }
      await walk(abs, baseAbs, out);
    } else if (entry.isFile()) {
      out.push({
        abs,
        rel: toPosix(path.relative(baseAbs, abs)),
        relFromProject: toPosix(path.relative(projectRoot, abs)),
        basename: entry.name,
      });
    }
  }
  return out;
}

function compileRules(rules) {
  const trash = (rules.trash ?? []).map((rule, idx) => {
    const reason = rule.reason ?? `trash[${idx}]`;
    if (typeof rule.emptyFile === "boolean" && rule.emptyFile) {
      return { kind: "emptyFile", reason, label: "emptyFile" };
    }
    if (rule.glob) {
      return {
        kind: "glob",
        reason,
        label: `glob:${rule.glob}`,
        match: globToRegExp(rule.glob),
      };
    }
    if (rule.filenameRegex) {
      return {
        kind: "filenameRegex",
        reason,
        label: `filenameRegex:${rule.filenameRegex}`,
        match: buildRegex(rule.filenameRegex, rule.regexFlags ?? ""),
      };
    }
    if (typeof rule.minBytes === "number" || typeof rule.maxBytes === "number") {
      return {
        kind: "size",
        reason,
        label: `size:[${rule.minBytes ?? 0},${rule.maxBytes ?? "inf"}]`,
        minBytes: rule.minBytes ?? 0,
        maxBytes: rule.maxBytes ?? Infinity,
      };
    }
    throw new Error(`trash rule [${idx}] has no recognized matcher`);
  });

  const strip = (rules.strip ?? []).map((rule, idx) => {
    const reason = rule.reason ?? `strip[${idx}]`;
    const filenameMatch = rule.filenameGlob
      ? globToRegExp(rule.filenameGlob)
      : null;
    if (rule.contentRegex) {
      return {
        kind: "contentRegex",
        reason,
        label: `regex:${rule.contentRegex.slice(0, 40)}`,
        filenameMatch,
        regex: buildRegex(rule.contentRegex, rule.regexFlags ?? "g"),
      };
    }
    if (rule.contentLineMatch) {
      return {
        kind: "contentLine",
        reason,
        label: `line:${rule.contentLineMatch.slice(0, 40)}`,
        filenameMatch,
        regex: buildRegex(rule.contentLineMatch, rule.regexFlags ?? ""),
      };
    }
    throw new Error(`strip rule [${idx}] has no recognized matcher`);
  });

  return { trash, strip };
}

function matchTrash(file, stat, rules) {
  for (const rule of rules) {
    if (rule.kind === "emptyFile" && stat.size === 0) return rule;
    if (rule.kind === "glob" && rule.match.test(file.rel)) return rule;
    if (rule.kind === "filenameRegex" && rule.match.test(file.basename)) {
      return rule;
    }
    if (
      rule.kind === "size" &&
      stat.size >= rule.minBytes &&
      stat.size <= rule.maxBytes
    ) {
      return rule;
    }
  }
  return null;
}

function applyStripRules(text, file, rules) {
  let next = text;
  const matchedLabels = [];
  let removedRegions = 0;
  for (const rule of rules) {
    if (rule.filenameMatch && !rule.filenameMatch.test(file.rel)) continue;
    if (rule.kind === "contentRegex") {
      let hit = false;
      next = next.replace(rule.regex, (match) => {
        hit = true;
        removedRegions += 1;
        return "";
      });
      if (hit) matchedLabels.push(rule.label);
    } else if (rule.kind === "contentLine") {
      const lines = next.split("\n");
      const kept = [];
      let dropped = 0;
      for (const line of lines) {
        if (rule.regex.test(line)) {
          dropped += 1;
        } else {
          kept.push(line);
        }
      }
      if (dropped > 0) {
        next = kept.join("\n");
        matchedLabels.push(rule.label);
        removedRegions += dropped;
      }
    }
  }
  return { next, matchedLabels, removedRegions };
}

function shortPreviewDiff(before, after) {
  // Tiny human-readable preview that captures up to 240 chars of the
  // first removed region. Not a true unified diff — that would be heavy
  // and the LLM only needs enough to summarize the change.
  if (before === after) return "";
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) {
    i += 1;
  }
  const removed = before.slice(i, i + 240);
  return `- ${removed.replace(/\n/g, "\\n")}${removed.length === 240 ? "…" : ""}`;
}

async function cmdPlan() {
  const targetArg = readArg("--target");
  const rulesFileArg = readArg("--rules-file");
  const outArg = readArg("--out");
  if (!targetArg) throw new Error("plan requires --target <raw subpath>");
  if (!rulesFileArg) throw new Error("plan requires --rules-file <path>");
  if (!outArg) throw new Error("plan requires --out <path>");

  const targetAbs = path.resolve(projectRoot, targetArg);
  ensureInsideRaw(targetAbs, "--target");
  const targetStat = await fs.stat(targetAbs).catch(() => null);
  if (!targetStat) throw new Error(`--target not found: ${targetArg}`);

  const rulesRaw = await fs.readFile(rulesFileArg, "utf8");
  const rulesJson = JSON.parse(rulesRaw);
  const rules = compileRules(rulesJson);

  let files = [];
  if (targetStat.isDirectory()) {
    files = await walk(targetAbs, targetAbs);
  } else {
    files = [
      {
        abs: targetAbs,
        rel: path.basename(targetAbs),
        relFromProject: toPosix(path.relative(projectRoot, targetAbs)),
        basename: path.basename(targetAbs),
      },
    ];
  }

  const actions = [];
  let trashCount = 0;
  let stripCount = 0;
  let skipCount = 0;
  for (const file of files) {
    if (PROTECTED_BASENAMES.has(file.basename)) {
      actions.push({
        kind: "skip",
        path: file.relFromProject,
        reason: "protected basename",
      });
      skipCount += 1;
      continue;
    }
    const stat = await fs.stat(file.abs);
    const trashHit = matchTrash(file, stat, rules.trash);
    if (trashHit) {
      actions.push({
        kind: "trash",
        path: file.relFromProject,
        size: stat.size,
        reason: trashHit.reason,
        matchedRule: trashHit.label,
      });
      trashCount += 1;
      continue;
    }
    if (rules.strip.length === 0) {
      actions.push({ kind: "skip", path: file.relFromProject, reason: "no rule matched" });
      skipCount += 1;
      continue;
    }
    // Strip rules require reading the file. Skip binaries by a quick
    // utf-8 sniff — files containing a NUL byte in the first 4 KB are
    // assumed binary and left alone (HTML/markdown/text are the target).
    let textBuf;
    try {
      textBuf = await fs.readFile(file.abs);
    } catch (err) {
      actions.push({
        kind: "skip",
        path: file.relFromProject,
        reason: `read failed: ${err.message ?? err}`,
      });
      skipCount += 1;
      continue;
    }
    const sniff = textBuf.subarray(0, Math.min(4096, textBuf.length));
    if (sniff.includes(0)) {
      actions.push({
        kind: "skip",
        path: file.relFromProject,
        reason: "binary (NUL detected)",
      });
      skipCount += 1;
      continue;
    }
    const text = textBuf.toString("utf8");
    const stripResult = applyStripRules(text, file, rules.strip);
    if (stripResult.next === text) {
      actions.push({
        kind: "skip",
        path: file.relFromProject,
        reason: "no rule matched",
      });
      skipCount += 1;
      continue;
    }
    actions.push({
      kind: "strip",
      path: file.relFromProject,
      originalBytes: Buffer.byteLength(text, "utf8"),
      cleanedBytes: Buffer.byteLength(stripResult.next, "utf8"),
      removedRegions: stripResult.removedRegions,
      previewDiff: shortPreviewDiff(text, stripResult.next),
      matchedRules: stripResult.matchedLabels,
    });
    stripCount += 1;
  }

  const plan = {
    createdAt: new Date().toISOString(),
    target: toPosix(path.relative(projectRoot, targetAbs)),
    rulesFile: toPosix(path.relative(projectRoot, path.resolve(rulesFileArg))),
    actions,
    summary: {
      trash: trashCount,
      strip: stripCount,
      skip: skipCount,
      totalScanned: files.length,
    },
  };

  const outAbs = path.resolve(projectRoot, outArg);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify({
      mode: "plan",
      out: toPosix(path.relative(projectRoot, outAbs)),
      summary: plan.summary,
    }, null, 2)}\n`,
  );
}

async function uniqueTrashTarget(basename, usedSet) {
  const stamp = isoStamp();
  let candidate = path.join(trashRoot, `${stamp}_${basename}`);
  let suffix = 2;
  while (usedSet.has(candidate)) {
    candidate = path.join(trashRoot, `${stamp}_${basename}_${suffix}`);
    suffix += 1;
  }
  // Also check disk for the rare case of an existing collision (e.g.
  // multiple apply runs landing within the same millisecond).
  while (await fs.access(candidate).then(() => true).catch(() => false)) {
    candidate = path.join(trashRoot, `${stamp}_${basename}_${suffix}`);
    suffix += 1;
  }
  usedSet.add(candidate);
  return candidate;
}

async function cmdApply() {
  const planFileArg = readArg("--plan-file");
  if (!planFileArg) throw new Error("apply requires --plan-file <path>");
  const planAbs = path.resolve(projectRoot, planFileArg);
  const planRaw = await fs.readFile(planAbs, "utf8");
  const plan = JSON.parse(planRaw);

  await fs.mkdir(trashRoot, { recursive: true });
  const usedTrashTargets = new Set();
  const applied = [];
  let failed = 0;

  for (const action of plan.actions) {
    if (action.kind === "skip") {
      applied.push({ ...action, status: "skipped" });
      continue;
    }
    const srcAbs = path.resolve(projectRoot, action.path);
    ensureInsideRaw(srcAbs, "action.path");
    if (PROTECTED_BASENAMES.has(path.basename(srcAbs))) {
      applied.push({ ...action, status: "protected" });
      continue;
    }
    const exists = await fs.stat(srcAbs).catch(() => null);
    if (!exists) {
      applied.push({ ...action, status: "missing" });
      continue;
    }

    if (action.kind === "trash") {
      try {
        const trashTarget = await uniqueTrashTarget(
          path.basename(srcAbs),
          usedTrashTargets,
        );
        await fs.rename(srcAbs, trashTarget);
        applied.push({
          ...action,
          status: "ok",
          trashedTo: toPosix(path.relative(projectRoot, trashTarget)),
        });
      } catch (err) {
        failed += 1;
        applied.push({ ...action, status: "error", error: String(err.message ?? err) });
      }
      continue;
    }

    if (action.kind === "strip") {
      try {
        const buf = await fs.readFile(srcAbs);
        const text = buf.toString("utf8");
        // Re-apply rules from the plan to be safe: the plan stored the
        // matched rule labels but not the rules themselves. We trust the
        // plan's cleanedBytes only as a heuristic; the user-facing rules
        // file must still exist for apply to be reproducible.
        const rulesRaw = await fs.readFile(
          path.resolve(projectRoot, plan.rulesFile),
          "utf8",
        );
        const rules = compileRules(JSON.parse(rulesRaw));
        const result = applyStripRules(
          text,
          {
            abs: srcAbs,
            rel: toPosix(path.relative(path.resolve(projectRoot, plan.target), srcAbs)),
            relFromProject: action.path,
            basename: path.basename(srcAbs),
          },
          rules.strip,
        );
        if (result.next === text) {
          applied.push({ ...action, status: "nochange" });
          continue;
        }
        const backupTarget = await uniqueTrashTarget(
          path.basename(srcAbs),
          usedTrashTargets,
        );
        await fs.copyFile(srcAbs, backupTarget);
        await fs.writeFile(srcAbs, result.next, "utf8");
        applied.push({
          ...action,
          status: "ok",
          backupAt: toPosix(path.relative(projectRoot, backupTarget)),
          cleanedBytes: Buffer.byteLength(result.next, "utf8"),
        });
      } catch (err) {
        failed += 1;
        applied.push({ ...action, status: "error", error: String(err.message ?? err) });
      }
    }
  }

  const appliedPath = planAbs.replace(/-plan\.json$/, "-applied.json");
  const finalPath =
    appliedPath === planAbs ? `${planAbs}.applied.json` : appliedPath;
  await fs.writeFile(
    finalPath,
    `${JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        plan: toPosix(path.relative(projectRoot, planAbs)),
        actions: applied,
        summary: {
          ok: applied.filter((a) => a.status === "ok").length,
          skipped: applied.filter((a) => a.status === "skipped").length,
          failed,
          nochange: applied.filter((a) => a.status === "nochange").length,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const summary = {
    mode: "apply",
    plan: toPosix(path.relative(projectRoot, planAbs)),
    applied: toPosix(path.relative(projectRoot, finalPath)),
    ok: applied.filter((a) => a.status === "ok").length,
    skipped: applied.filter((a) => a.status === "skipped").length,
    failed,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(
      "Usage:\n" +
        "  preprocess-raw.mjs plan --target <raw subpath> --rules-file <rules.json> --out <plan.json>\n" +
        "  preprocess-raw.mjs apply --plan-file <plan.json>\n",
    );
    return;
  }
  if (subcommand === "plan") return cmdPlan();
  if (subcommand === "apply") return cmdApply();
  throw new Error(`unknown subcommand: ${subcommand}`);
}

main().catch((err) => {
  process.stderr.write(`preprocess-raw: ${err.message ?? err}\n`);
  process.exitCode = 2;
});
