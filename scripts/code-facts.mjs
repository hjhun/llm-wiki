#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs",
]);

const CODE_MANIFESTS = new Set([
  "package.json", "Cargo.toml", "pyproject.toml", "go.mod",
  "Dockerfile", "compose.yaml", "tsconfig.json",
]);

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", ".venv",
  "vendor", "coverage", ".cache",
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;
const EXTRACTOR_NAME = "clio-code-facts";
const EXTRACTOR_VERSION = 1;

function usage() {
  console.error(
    [
      "Usage: node scripts/code-facts.mjs raw/<path>",
      "  [--out <facts.json>]",
      "  [--graph-out <partial-graph.json>]",
      "  [--leaf raw/<path>/]",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
const outArgIndex = args.indexOf("--out");
const graphOutArgIndex = args.indexOf("--graph-out");
const leafArgIndex = args.indexOf("--leaf");
const outPath = outArgIndex >= 0 ? args[outArgIndex + 1] : null;
const graphOutPath = graphOutArgIndex >= 0 ? args[graphOutArgIndex + 1] : null;
const leafPathArg = leafArgIndex >= 0 ? args[leafArgIndex + 1] : null;

if (
  !target ||
  (outArgIndex >= 0 && !outPath) ||
  (graphOutArgIndex >= 0 && !graphOutPath) ||
  (leafArgIndex >= 0 && !leafPathArg)
) {
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
const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function normalizeLeafPath(value) {
  const rel = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${rel}/`;
}

function projectNameFromRawPath(rel) {
  const parts = rel.split("/").filter(Boolean);
  if (parts[0] === "raw" && parts[1]) {
    return parts[1] === "repos" && parts[2] ? parts[2] : parts[1];
  }
  return "code";
}

function moduleName(rawPath) {
  const parts = rawPath.split("/");
  const rawIndex = parts.indexOf("raw");
  const afterRaw = rawIndex >= 0 ? parts.slice(rawIndex + 1) : parts;
  const meaningful = afterRaw.filter((part) => !["src", "lib", "app"].includes(part));
  return meaningful.slice(0, -1).join("/") || path.posix.dirname(rawPath);
}

async function statSafe(abs) {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function realpathSafe(abs) {
  try {
    return await fs.realpath(abs);
  } catch {
    return null;
  }
}

async function collectFiles(abs, out = [], visitedDirs = new Set()) {
  if (out.length >= MAX_FILES) return out;
  const st = await statSafe(abs);
  if (!st) return out;
  if (st.isFile()) {
    const ext = path.extname(abs).toLowerCase();
    if (CODE_EXTS.has(ext) || CODE_MANIFESTS.has(path.basename(abs))) out.push(abs);
    return out;
  }
  if (!st.isDirectory()) return out;
  const real = await realpathSafe(abs);
  if (real) {
    if (visitedDirs.has(real)) return out;
    visitedDirs.add(real);
  }
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const childAbs = path.join(abs, entry.name);
    const childStat = entry.isSymbolicLink() ? await statSafe(childAbs) : null;
    const childIsDirectory = entry.isDirectory() || childStat?.isDirectory();
    if (childIsDirectory && IGNORE_DIRS.has(entry.name)) continue;
    await collectFiles(childAbs, out, visitedDirs);
  }
  return out;
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lineEnd(text, startLine) {
  const lines = text.split(/\r?\n/);
  return Math.min(lines.length, startLine);
}

function entity(id, type, name, project, rawPath, contentHash, extra = {}) {
  return {
    id,
    type,
    name,
    project,
    raw_path: rawPath,
    parser: extra.parser ?? "static-regex",
    confidence: extra.confidence ?? 0.75,
    content_hash: contentHash,
    ...(extra.kind ? { kind: extra.kind } : {}),
    ...(extra.source_location ? { source_location: extra.source_location } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  };
}

function relation(id, type, src, dst, rawPath, extra = {}) {
  return {
    id,
    type,
    src,
    dst,
    ...(rawPath ? { raw_path: rawPath } : {}),
    parser: extra.parser ?? "static-regex",
    confidence: extra.confidence ?? 0.75,
    ...(extra.source_location ? { source_location: extra.source_location } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  };
}

function addUnique(map, item) {
  if (!map.has(item.id)) map.set(item.id, item);
}

function relationId(type, src, dst, rawPath, line = "") {
  return `${type}:${src}->${dst}:${rawPath}${line ? `:L${line}` : ""}`;
}

function symbolKey(rawPath, name) {
  return `${rawPath}\0${name}`;
}

function graphNodeFromEntity(item) {
  const tags = ["code", item.type];
  if (item.kind) tags.push(item.kind);
  return {
    id: item.id,
    label: item.name,
    type: item.type,
    tags: [...new Set(tags)],
    sources: [item.raw_path].filter(Boolean),
    raw_path: item.raw_path,
    source_file: item.raw_path,
    source_location: item.source_location ?? null,
    project: item.project,
    aliases: item.type === "symbol" ? [item.name] : [],
    confidence: item.confidence,
    metadata: {
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.metadata ?? {}),
      parser: item.parser,
      content_hash: item.content_hash,
    },
  };
}

function graphEdgeFromRelation(item) {
  return {
    src: item.src,
    dst: item.dst,
    type: item.type,
    weight: item.confidence ?? 1,
    sources: [item.raw_path].filter(Boolean),
    source_file: item.raw_path ?? null,
    source_location: item.source_location ?? null,
    confidence: item.confidence,
    metadata: {
      ...(item.metadata ?? {}),
      parser: item.parser,
    },
  };
}

function graphFromFacts(facts) {
  return {
    version: 1,
    built_at: facts.generated_at,
    leaf_path: facts.leaf_path,
    leaf_hash: facts.leaf_hash,
    source: "clio-code-facts",
    nodes: facts.entities.map(graphNodeFromEntity),
    edges: facts.relations.map(graphEdgeFromRelation),
    communities: [],
    diagnostics: {
      ...facts.diagnostics,
      entities: facts.entities.length,
      relations: facts.relations.length,
    },
  };
}

function jsSymbolPatterns() {
  return [
    { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g },
    { kind: "function", re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g },
    { kind: "function", re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g },
    { kind: "interface", re: /\binterface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "type", re: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
  ];
}

function pySymbolPatterns() {
  return [
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
    { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm },
    { kind: "function", re: /^\s*async\s+def\s+([A-Za-z_]\w*)\s*\(/gm },
  ];
}

function rustSymbolPatterns() {
  return [
    { kind: "struct", re: /\bstruct\s+([A-Za-z_]\w*)/g },
    { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
    { kind: "trait", re: /\btrait\s+([A-Za-z_]\w*)/g },
    { kind: "function", re: /\bfn\s+([A-Za-z_]\w*)\s*\(/g },
  ];
}

function symbolPatterns(ext) {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return jsSymbolPatterns();
  if (ext === ".py") return pySymbolPatterns();
  if (ext === ".rs") return rustSymbolPatterns();
  return [];
}

function importPatterns(ext) {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return [
      /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
      /\brequire\(["']([^"']+)["']\)/g,
      /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
    ];
  }
  if (ext === ".py") {
    return [
      /^\s*import\s+([A-Za-z_][\w.]*)/gm,
      /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm,
    ];
  }
  if (ext === ".rs") return [/\buse\s+([^;]+);/g];
  return [];
}

function resolveRelativeImport(rawPath, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(rawPath), specifier));
  const matches = [
    base,
    ...[...CODE_EXTS].map((ext) => `${base}${ext}`),
    ...[...CODE_EXTS].map((ext) => `${base}/index${ext}`),
  ];
  return matches.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function extractSymbols(text, ext, rawPath, project, contentHash, entities, relations, fileId) {
  const symbols = [];
  for (const { kind, re } of symbolPatterns(ext)) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!name) continue;
      const startLine = lineOfIndex(text, match.index ?? 0);
      const id = `symbol:${rawPath}:${kind}:${name}:L${startLine}`;
      addUnique(entities, entity(id, "symbol", name, project, rawPath, contentHash, {
        kind,
        source_location: { start_line: startLine, end_line: lineEnd(text, startLine) },
      }));
      addUnique(relations, relation(
        relationId("defines", fileId, id, rawPath, startLine),
        "defines",
        fileId,
        id,
        rawPath,
        { source_location: { start_line: startLine } },
      ));
      symbols.push({ id, name, kind, line: startLine });
    }
  }
  return symbols;
}

function jsExportPatterns() {
  return [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g,
    /\bexport\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)\b/g,
  ];
}

function extractExports(text, ext, rawPath, relations, fileId, symbolLookup) {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return;
  for (const re of jsExportPatterns()) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!name) continue;
      const symbolId = symbolLookup.get(symbolKey(rawPath, name));
      if (!symbolId) continue;
      const startLine = lineOfIndex(text, match.index ?? 0);
      addUnique(relations, relation(
        relationId("exports", fileId, symbolId, rawPath, startLine),
        "exports",
        fileId,
        symbolId,
        rawPath,
        {
          confidence: 0.85,
          source_location: { start_line: startLine },
          metadata: { name },
        },
      ));
    }
  }
}

function importedNamesFromStatement(statement, ext) {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const named = /\{([^}]+)\}/.exec(statement);
    if (!named) return [];
    return named[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter(Boolean);
  }
  if (ext === ".py") {
    const fromImport = /^\s*from\s+[A-Za-z_][\w.]*\s+import\s+(.+)$/m.exec(statement);
    if (!fromImport) return [];
    return fromImport[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter((name) => /^[A-Za-z_]\w*$/.test(name));
  }
  return [];
}

function extractImports(text, ext, rawPath, project, contentHash, entities, relations, fileId, knownFiles) {
  const importedTargets = [];
  for (const re of importPatterns(ext)) {
    for (const match of text.matchAll(re)) {
      const specifier = (match[1] ?? "").trim();
      if (!specifier) continue;
      const startLine = lineOfIndex(text, match.index ?? 0);
      const resolved = resolveRelativeImport(rawPath, specifier, knownFiles);
      const importedNames = importedNamesFromStatement(match[0], ext);
      let dst;
      if (resolved) {
        dst = `file:${resolved}`;
        importedTargets.push({ dst, resolved, names: importedNames, line: startLine });
      } else {
        dst = `module:${project}:external:${specifier}`;
        addUnique(entities, entity(dst, "module", specifier, project, rawPath, contentHash, {
          confidence: specifier.startsWith(".") ? 0.45 : 0.7,
          metadata: { external: !specifier.startsWith("."), specifier },
        }));
      }
      addUnique(relations, relation(
        relationId("imports", fileId, dst, rawPath, startLine),
        "imports",
        fileId,
        dst,
        rawPath,
        { source_location: { start_line: startLine }, metadata: { specifier, imported_names: importedNames } },
      ));
    }
  }
  return importedTargets;
}

function extractCalls(text, rawPath, relations, fileId, importedTargets, symbolLookup) {
  for (const target of importedTargets) {
    if (!target.resolved) continue;
    for (const name of target.names) {
      const symbolId = symbolLookup.get(symbolKey(target.resolved, name));
      if (!symbolId) continue;
      const callRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
      for (const match of text.matchAll(callRe)) {
        const startLine = lineOfIndex(text, match.index ?? 0);
        if (startLine === target.line) continue;
        addUnique(relations, relation(
          relationId("calls", fileId, symbolId, rawPath, startLine),
          "calls",
          fileId,
          symbolId,
          rawPath,
          {
            confidence: 0.7,
            source_location: { start_line: startLine },
            metadata: { name, resolved_from: target.resolved },
          },
        ));
      }
    }
  }
}

function extractJsRoutes(text, rawPath, project, contentHash, entities, relations, fileId) {
  const routeRe = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  for (const match of text.matchAll(routeRe)) {
    const method = match[1];
    const startLine = lineOfIndex(text, match.index ?? 0);
    const projectPrefix = `raw/repos/${project}/`;
    const fallbackPrefix = `raw/${project}/`;
    const projectRelative = rawPath.startsWith(projectPrefix)
      ? rawPath.slice(projectPrefix.length)
      : rawPath.startsWith(fallbackPrefix)
        ? rawPath.slice(fallbackPrefix.length)
        : rawPath;
    const routePattern = projectRelative
      .replace(/\/route\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
      .replace(/^app\//, "/")
      .replace(/^\/api\//, "/api/");
    const routeId = `route:${project}:${method}:${routePattern || "/"}`;
    addUnique(entities, entity(routeId, "route", `${method} ${routePattern || "/"}`, project, rawPath, contentHash, {
      kind: method,
      source_location: { start_line: startLine },
      metadata: { method, route_pattern: routePattern || "/" },
    }));
    addUnique(relations, relation(
      relationId("handles_route", routeId, fileId, rawPath, startLine),
      "handles_route",
      routeId,
      fileId,
      rawPath,
      { source_location: { start_line: startLine } },
    ));
  }
}

function extractTests(text, ext, rawPath, project, contentHash, entities, relations, fileId) {
  const isTestFile = /(^|[./_-])(test|spec)s?([./_-]|$)|__tests__/.test(rawPath);
  const patterns = [];
  const testIds = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    patterns.push(/\b(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g);
  } else if (ext === ".py") {
    patterns.push(/^\s*def\s+(test_[A-Za-z_]\w*)\s*\(/gm);
  } else if (ext === ".rs") {
    patterns.push(/#\s*\[\s*test\s*\][\s\S]{0,200}?\bfn\s+([A-Za-z_]\w*)\s*\(/g);
  }
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const name = match[1] || `test@${lineOfIndex(text, match.index ?? 0)}`;
      const startLine = lineOfIndex(text, match.index ?? 0);
      const id = `test:${rawPath}:${name}:L${startLine}`;
      addUnique(entities, entity(id, "test", name, project, rawPath, contentHash, {
        kind: "test",
        source_location: { start_line: startLine },
      }));
      addUnique(relations, relation(
        relationId("defines", fileId, id, rawPath, startLine),
        "defines",
        fileId,
        id,
        rawPath,
        { source_location: { start_line: startLine } },
      ));
      testIds.push(id);
    }
  }
  if (isTestFile && patterns.length === 0) {
    const id = `test:${rawPath}:file`;
    addUnique(entities, entity(id, "test", path.posix.basename(rawPath), project, rawPath, contentHash, {
      kind: "test_file",
      confidence: 0.65,
    }));
    addUnique(relations, relation(relationId("defines", fileId, id, rawPath), "defines", fileId, id, rawPath));
    testIds.push(id);
  }
  return testIds;
}

function extractEnvReads(text, rawPath, project, contentHash, entities, relations, fileId) {
  const patterns = [
    /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bos\.environ(?:\.get)?\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /\benv::var\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!name) continue;
      const startLine = lineOfIndex(text, match.index ?? 0);
      const id = `env:${project}:${name}`;
      addUnique(entities, entity(id, "environment", name, project, rawPath, contentHash, {
        kind: "env",
        confidence: 0.9,
      }));
      addUnique(relations, relation(
        relationId("uses_env", fileId, id, rawPath, startLine),
        "uses_env",
        fileId,
        id,
        rawPath,
        { confidence: 0.9, source_location: { start_line: startLine } },
      ));
    }
  }
}

async function main() {
  const targetRel = relProject(targetAbs);
  const leafPath = normalizeLeafPath(leafPathArg ?? targetRel);
  const project = projectNameFromRawPath(targetRel);
  const filesAbs = await collectFiles(targetAbs);
  const knownFiles = new Set(filesAbs.map((abs) => relProject(abs)));
  const entities = new Map();
  const relations = new Map();
  const symbolLookup = new Map();
  const fileAnalyses = [];
  const diagnostics = {
    files_seen: filesAbs.length,
    files_parsed: 0,
    files_with_fallback: 0,
    files_failed: 0,
    truncated: [],
  };

  const projectId = `project:${project}`;
  addUnique(entities, entity(projectId, "project", project, project, targetRel, sha256(targetRel), {
    parser: EXTRACTOR_NAME,
    confidence: 1,
  }));

  for (const abs of filesAbs) {
    const rawPath = relProject(abs);
    const ext = path.extname(abs).toLowerCase();
    const st = await fs.stat(abs);
    let text = null;
    let readFailed = false;
    if (st.size <= MAX_FILE_BYTES) {
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        readFailed = true;
      }
    }
    const contentHash = text !== null
      ? sha256(text)
      : sha256(`${rawPath}:${st.size}:${st.mtimeMs}`);
    const fileId = `file:${rawPath}`;
    const modName = moduleName(rawPath);
    const moduleId = `module:${project}:${modName}`;

    addUnique(entities, entity(moduleId, "module", modName, project, rawPath, contentHash, {
      parser: EXTRACTOR_NAME,
      confidence: 0.85,
    }));
    addUnique(entities, entity(fileId, "file", path.posix.basename(rawPath), project, rawPath, contentHash, {
      kind: ext || path.posix.basename(rawPath),
      parser: EXTRACTOR_NAME,
      confidence: 1,
      metadata: { size: st.size },
    }));
    addUnique(relations, relation(relationId("contains", projectId, moduleId, rawPath), "contains", projectId, moduleId, rawPath, {
      parser: EXTRACTOR_NAME,
      confidence: 0.9,
    }));
    addUnique(relations, relation(relationId("contains", moduleId, fileId, rawPath), "contains", moduleId, fileId, rawPath, {
      parser: EXTRACTOR_NAME,
      confidence: 0.9,
    }));

    if (st.size > MAX_FILE_BYTES) {
      diagnostics.truncated.push(rawPath);
      continue;
    }
    if (readFailed || text === null) {
      diagnostics.files_failed += 1;
      continue;
    }

    diagnostics.files_parsed += 1;
    diagnostics.files_with_fallback += 1;
    const symbols = extractSymbols(text, ext, rawPath, project, contentHash, entities, relations, fileId);
    for (const symbol of symbols) symbolLookup.set(symbolKey(rawPath, symbol.name), symbol.id);
    const importedTargets = extractImports(text, ext, rawPath, project, contentHash, entities, relations, fileId, knownFiles);
    extractJsRoutes(text, rawPath, project, contentHash, entities, relations, fileId);
    const testIds = extractTests(text, ext, rawPath, project, contentHash, entities, relations, fileId);
    for (const testId of testIds) {
      for (const target of importedTargets) {
        addUnique(relations, relation(
          relationId("tested_by", target.dst, testId, rawPath),
          "tested_by",
          target.dst,
          testId,
          rawPath,
          { confidence: 0.65 },
        ));
      }
    }
    extractEnvReads(text, rawPath, project, contentHash, entities, relations, fileId);
    fileAnalyses.push({ text, ext, rawPath, fileId, importedTargets });
  }

  for (const analysis of fileAnalyses) {
    extractExports(analysis.text, analysis.ext, analysis.rawPath, relations, analysis.fileId, symbolLookup);
    extractCalls(analysis.text, analysis.rawPath, relations, analysis.fileId, analysis.importedTargets, symbolLookup);
  }

  const result = {
    version: 1,
    generated_at: new Date().toISOString(),
    leaf_path: leafPath,
    leaf_hash: sha1(leafPath),
    project,
    extractor: {
      name: EXTRACTOR_NAME,
      version: EXTRACTOR_VERSION,
    },
    entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outPath) {
    const outAbs = path.resolve(projectRoot, outPath);
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, json, "utf8");
  } else {
    process.stdout.write(json);
  }

  if (graphOutPath) {
    const graphOutAbs = path.resolve(projectRoot, graphOutPath);
    const graphJson = `${JSON.stringify(graphFromFacts(result), null, 2)}\n`;
    await fs.mkdir(path.dirname(graphOutAbs), { recursive: true });
    await fs.writeFile(graphOutAbs, graphJson, "utf8");
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
