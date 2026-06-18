import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, WIKI_ROOT } from "./paths";

export type WikiMarkdownDoc = {
  /** Path relative to wiki/, e.g. sources/articles/foo.md. */
  relPath: string;
  /** Path relative to the project root, e.g. wiki/sources/articles/foo.md. */
  projectPath: string;
  title: string;
  text: string;
  size: number;
  mtimeMs: number;
};

type MarkdownFile = {
  abs: string;
  relPath: string;
  projectPath: string;
  size: number;
  mtimeMs: number;
};

type CacheEntry = {
  docs: WikiMarkdownDoc[];
  expiresAt: number;
  maxDocBytes: number;
  signature: string;
};

const MARKDOWN_EXT = /\.(md|mdx)$/i;
const DEFAULT_CACHE_TTL_MS = 1500;
const SKIP_DIRS = new Set([".git", ".progress", "archive"]);

let cache: CacheEntry | null = null;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function titleOfMarkdown(content: string, relPath: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content);
  if (frontmatter) {
    const m = /(^|\n)title:\s*(.+)/.exec(frontmatter[1]);
    if (m) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path.basename(relPath);
}

async function walkMarkdownFiles(dir: string, relDir: string, out: MarkdownFile[]) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      if (SKIP_DIRS.has(entry.name)) return;

      const abs = path.join(dir, entry.name);
      const relPath = toPosix(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        await walkMarkdownFiles(abs, relPath, out);
        return;
      }
      if (!entry.isFile() || !MARKDOWN_EXT.test(entry.name)) return;

      const st = await fs.stat(abs);
      out.push({
        abs,
        relPath,
        projectPath: toPosix(path.relative(PROJECT_ROOT, abs)),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }),
  );
}

async function discoverMarkdownFiles(): Promise<MarkdownFile[]> {
  const files: MarkdownFile[] = [];
  await walkMarkdownFiles(WIKI_ROOT, "", files);
  files.sort((a, b) => {
    if (a.relPath === "index.md") return -1;
    if (b.relPath === "index.md") return 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return files;
}

function signatureFor(files: MarkdownFile[]): string {
  return files
    .map((file) => `${file.relPath}:${file.size}:${Math.floor(file.mtimeMs)}`)
    .join("|");
}

export function clearWikiMarkdownDocCache(): void {
  cache = null;
}

export async function listWikiMarkdownDocs(options: {
  maxDocBytes?: number;
  cacheTtlMs?: number;
} = {}): Promise<WikiMarkdownDoc[]> {
  const now = Date.now();
  const maxDocBytes = options.maxDocBytes ?? Number.POSITIVE_INFINITY;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  if (cache && cache.maxDocBytes === maxDocBytes && cache.expiresAt > now) {
    return cache.docs;
  }

  const files = await discoverMarkdownFiles();
  const signature = signatureFor(files);
  if (
    cache &&
    cache.maxDocBytes === maxDocBytes &&
    cache.signature === signature
  ) {
    cache.expiresAt = now + cacheTtlMs;
    return cache.docs;
  }

  const docs = (
    await Promise.all(
      files.map(async (file) => {
        if (file.size > maxDocBytes) return null;
        const text = await fs.readFile(file.abs, "utf8");
        return {
          relPath: file.relPath,
          projectPath: file.projectPath,
          title: titleOfMarkdown(text, file.relPath),
          text,
          size: file.size,
          mtimeMs: file.mtimeMs,
        } satisfies WikiMarkdownDoc;
      }),
    )
  ).filter((doc): doc is WikiMarkdownDoc => Boolean(doc));

  cache = {
    docs,
    expiresAt: now + cacheTtlMs,
    maxDocBytes,
    signature,
  };
  return docs;
}
