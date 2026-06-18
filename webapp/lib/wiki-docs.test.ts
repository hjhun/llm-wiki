import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot = "";
let previousProjectRoot: string | undefined;

async function write(rel: string, content: string) {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("wiki markdown docs", () => {
  beforeEach(async () => {
    previousProjectRoot = process.env.PROJECT_ROOT;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clio-wiki-docs-"));
    process.env.PROJECT_ROOT = tmpRoot;
    vi.resetModules();
    await write("llm-wiki.md", "# marker\n");
    await write("wiki/index.md", "---\ntitle: Index\n---\n# Ignored\n");
  });

  afterEach(async () => {
    if (previousProjectRoot == null) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    vi.resetModules();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  });

  it("lists wiki markdown docs with index first and skips ignored dirs", async () => {
    await write("wiki/topics/foo.md", "# Foo\nbody");
    await write("wiki/archive/old.md", "# Old\nbody");
    await write("wiki/.hidden/secret.md", "# Secret\nbody");

    const { listWikiMarkdownDocs } = await import("./wiki-docs");
    const docs = await listWikiMarkdownDocs({ cacheTtlMs: 0 });

    expect(docs.map((doc) => doc.relPath)).toEqual([
      "index.md",
      "topics/foo.md",
    ]);
    expect(docs[0]).toMatchObject({
      projectPath: "wiki/index.md",
      title: "Index",
    });
  });

  it("reuses the cached doc list within the ttl", async () => {
    const { listWikiMarkdownDocs } = await import("./wiki-docs");

    const first = await listWikiMarkdownDocs({ cacheTtlMs: 60_000 });
    const second = await listWikiMarkdownDocs({ cacheTtlMs: 60_000 });

    expect(second).toBe(first);
  });

  it("refreshes after a wiki file changes", async () => {
    const { listWikiMarkdownDocs } = await import("./wiki-docs");

    await listWikiMarkdownDocs({ cacheTtlMs: 0 });
    await write("wiki/new.md", "# New\nbody");
    const docs = await listWikiMarkdownDocs({ cacheTtlMs: 0 });

    expect(docs.map((doc) => doc.relPath)).toContain("new.md");
  });
});
