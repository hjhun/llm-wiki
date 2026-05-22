#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go",
  ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
  ".php", ".rb", ".sh", ".sql",
]);

const CODE_MANIFESTS = new Set([
  "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml",
  "build.gradle", "Dockerfile", "compose.yaml", "tsconfig.json",
]);

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", ".venv",
  "vendor", "coverage", ".cache",
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;

function usage() {
  console.error("Usage: node scripts/code-index.mjs raw/<path> [--format=json|markdown]");
}

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
const formatArg = args.find((arg) => arg.startsWith("--format="));
const format = formatArg ? formatArg.split("=")[1] : "json";

if (!target || !["json", "markdown"].includes(format)) {
  usage();
  process.exit(2);
}

const projectRoot = process.cwd();
const rawRoot = path.resolve(projectRoot, "raw");
const targetAbs = path.resolve(projectRoot, target);

if (targetAbs !== rawRoot && !targetAbs.startsWith(`${rawRoot}${path.sep}`)) {
  console.error("Target must be inside raw/");
  process.exit(2);
}

const toPosix = (value) => value.split(path.sep).join("/");
const relProject = (abs) => toPosix(path.relative(projectRoot, abs));

function projectNameFromTarget(rel) {
  const parts = rel.split("/").filter(Boolean);
  if (parts[0] === "raw" && parts[1]) return parts[1] === "repos" && parts[2] ? parts[2] : parts[1];
  return "code";
}

async function statSafe(abs) {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function collectFiles(abs, out = []) {
  if (out.length >= MAX_FILES) return out;
  const st = await statSafe(abs);
  if (!st) return out;
  if (st.isFile()) {
    if (
      CODE_EXTS.has(path.extname(abs).toLowerCase()) ||
      CODE_MANIFESTS.has(path.basename(abs))
    ) {
      out.push(abs);
    }
    return out;
  }
  if (!st.isDirectory()) return out;
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    await collectFiles(path.join(abs, entry.name), out);
  }
  return out;
}

function symbolPatterns(ext) {
  const common = [
    { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g },
  ];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return [
      ...common,
      { kind: "function", re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g },
      { kind: "function", re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_$][\w$]*)/g },
      { kind: "type", re: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
      { kind: "route", re: /\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g },
    ];
  }
  if (ext === ".py") {
    return [
      { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
      { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm },
      { kind: "function", re: /^\s*async\s+def\s+([A-Za-z_]\w*)\s*\(/gm },
    ];
  }
  if (ext === ".rs") {
    return [
      { kind: "struct", re: /\bstruct\s+([A-Za-z_]\w*)/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
      { kind: "trait", re: /\btrait\s+([A-Za-z_]\w*)/g },
      { kind: "function", re: /\bfn\s+([A-Za-z_]\w*)\s*\(/g },
    ];
  }
  if (ext === ".go") {
    return [
      { kind: "type", re: /\btype\s+([A-Za-z_]\w*)\b/g },
      { kind: "function", re: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g },
    ];
  }
  if ([".java", ".kt", ".swift", ".cs", ".php", ".rb"].includes(ext)) return common;
  return common;
}

function dependencyPatterns(ext) {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return [
      /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
      /\brequire\(["']([^"']+)["']\)/g,
      /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
    ];
  }
  if (ext === ".py") return [/^\s*import\s+([A-Za-z_][\w.]*)/gm, /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm];
  if (ext === ".rs") return [/\buse\s+([^;]+);/g];
  if (ext === ".go") return [/"([^"]+)"/g];
  if ([".java", ".kt"].includes(ext)) return [/^\s*import\s+([A-Za-z_][\w.]*);?/gm];
  return [];
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractSymbols(text, ext, rel) {
  const symbols = [];
  for (const { kind, re } of symbolPatterns(ext)) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!name) continue;
      symbols.push({
        name,
        kind,
        file: rel,
        line: lineOfIndex(text, match.index ?? 0),
      });
    }
  }
  return symbols;
}

function extractDependencies(text, ext, rel) {
  const deps = new Set();
  for (const re of dependencyPatterns(ext)) {
    for (const match of text.matchAll(re)) {
      const value = (match[1] ?? "").trim();
      if (value) deps.add(value);
    }
  }
  return [...deps].map((target) => ({ source: rel, target }));
}

function moduleName(rel) {
  const parts = rel.split("/");
  const rawIndex = parts.indexOf("raw");
  const afterRaw = rawIndex >= 0 ? parts.slice(rawIndex + 1) : parts;
  const meaningful = afterRaw.filter((part) => !["src", "lib", "app"].includes(part));
  return meaningful.slice(0, -1).join("/") || path.posix.dirname(rel);
}

function buildMermaid(files, dependencies) {
  const modules = new Map();
  for (const file of files) modules.set(file.path, moduleName(file.path));
  const edges = new Set();
  for (const dep of dependencies) {
    if (!dep.target.startsWith(".")) continue;
    const srcModule = modules.get(dep.source);
    if (!srcModule) continue;
    const sourceDir = path.posix.dirname(dep.source);
    const resolved = path.posix.normalize(path.posix.join(sourceDir, dep.target));
    const targetFile = [...modules.keys()].find((candidate) =>
      candidate === resolved ||
      candidate.startsWith(`${resolved}.`) ||
      candidate.startsWith(`${resolved}/index.`)
    );
    const dstModule = targetFile ? modules.get(targetFile) : dep.target;
    if (dstModule && srcModule !== dstModule) edges.add(`${srcModule} --> ${dstModule}`);
  }
  const shown = [...edges].slice(0, 80);
  if (shown.length === 0) return "flowchart LR\n  Code[\"Code files\"]";
  const ids = new Map();
  let next = 1;
  const idFor = (label) => {
    if (!ids.has(label)) ids.set(label, `M${next++}`);
    return ids.get(label);
  };
  const lines = ["flowchart LR"];
  for (const edge of shown) {
    const [src, dst] = edge.split(" --> ");
    lines.push(`  ${idFor(src)}["${src}"] --> ${idFor(dst)}["${dst}"]`);
  }
  return lines.join("\n");
}

const filesAbs = await collectFiles(targetAbs);
const projectRel = relProject(targetAbs);
const project = projectNameFromTarget(projectRel);
const files = [];
const symbols = [];
const dependencies = [];

for (const abs of filesAbs) {
  const st = await fs.stat(abs);
  const rel = relProject(abs);
  const ext = path.extname(abs).toLowerCase();
  if (st.size > MAX_FILE_BYTES) {
    files.push({ path: rel, ext, size: st.size, skipped: "too_large" });
    continue;
  }
  const text = await fs.readFile(abs, "utf8").catch(() => "");
  const fileSymbols = extractSymbols(text, ext, rel);
  const fileDependencies = extractDependencies(text, ext, rel);
  files.push({
    path: rel,
    ext,
    size: st.size,
    lines: text ? text.split(/\r?\n/).length : 0,
    symbols: fileSymbols.length,
    dependencies: fileDependencies.length,
  });
  symbols.push(...fileSymbols);
  dependencies.push(...fileDependencies);
}

const result = {
  version: 1,
  target: projectRel,
  project,
  generated_at: new Date().toISOString(),
  files,
  symbols,
  dependencies,
  mermaid: buildMermaid(files, dependencies),
};

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# ${project} Code Index`);
  console.log("");
  console.log("## Symbols");
  console.log("");
  console.log("| Symbol | Kind | Location | Open |");
  console.log("|---|---|---|---|");
  for (const symbol of symbols.slice(0, 500)) {
    const rawPath = symbol.file.startsWith("raw/") ? symbol.file.slice(4) : symbol.file;
    console.log(`| \`${symbol.name}\` | ${symbol.kind} | \`${symbol.file}:L${symbol.line}\` | [open](/explorer?ws=raw&path=${rawPath}&line=${symbol.line}) |`);
  }
  console.log("");
  console.log("## Module Dependencies");
  console.log("");
  console.log("```mermaid");
  console.log(result.mermaid);
  console.log("```");
}
