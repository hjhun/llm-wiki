/**
 * Pure leaf/file classification for the ingest loop: decides whether a raw
 * file looks like code, runtime evidence, or prose, and what kind a whole
 * leaf is. Drives Code Wiki vs prose ingest routing.
 *
 * Extracted verbatim from ingest-loop.ts (constants and predicates only — the
 * fs-touching collectors stay in the loop module). These predicates are not
 * part of the public ingest-loop surface; they are imported back internally.
 */

import path from "node:path";
import { pathSegments } from "./scope";

export const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".sh",
  ".sql",
]);

export const CODE_MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "compose.yaml",
  "tsconfig.json",
]);

export const IGNORE_CODE_DIRS = new Set([
  ".git",
  ".trash",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "vendor",
  "coverage",
]);

export type LeafKind = "prose" | "code" | "mixed" | "ignore";

export function isIgnoredCodePath(relPath: string): boolean {
  return pathSegments(relPath).some((part) => IGNORE_CODE_DIRS.has(part));
}

export function fileLooksLikeCode(relPath: string): boolean {
  if (isIgnoredCodePath(relPath)) return false;
  const basename = path.posix.basename(relPath);
  if (CODE_MANIFESTS.has(basename)) return true;
  if (CODE_EXTS.has(path.posix.extname(relPath).toLowerCase())) return true;
  const lower = relPath.toLowerCase();
  return (
    lower.includes("test") ||
    lower.includes("spec") ||
    lower.includes("__tests__/") ||
    lower.includes("tests/")
  );
}

export function fileLooksLikeRuntimeEvidence(relPath: string): boolean {
  if (isIgnoredCodePath(relPath)) return false;
  const lower = relPath.toLowerCase();
  return (
    lower.endsWith(".log") ||
    lower.includes("stacktrace") ||
    lower.includes("stack-trace") ||
    lower.includes("ci") ||
    lower.includes("crash") ||
    lower.includes("failure") ||
    lower.includes("failing-test")
  );
}

export function classifyLeafFromFiles(files: string[]): LeafKind {
  const actionable = files.filter((file) => !isIgnoredCodePath(file));
  if (actionable.length === 0 && files.length > 0) return "ignore";
  const codeCount = actionable.filter(
    (file) => fileLooksLikeCode(file) || fileLooksLikeRuntimeEvidence(file),
  ).length;
  if (codeCount === 0) return "prose";
  return codeCount === actionable.length ? "code" : "mixed";
}
