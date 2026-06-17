import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config";
import { bootstrapIngestProgress } from "./bootstrap";

const cfg = {
  chunking: {
    maxFiles: 8,
    maxBytes: 256 * 1024,
    maxFilesPerInvocation: 2,
    maxBytesPerFile: 128 * 1024,
    unitPerCall: "one_subchunk",
  },
} as Config;

let root: string;

async function readState(): Promise<Record<string, any>> {
  return JSON.parse(
    await fs.readFile(path.join(root, "progress/ingest/.state.json"), "utf8"),
  );
}

describe("bootstrapIngestProgress", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "clio-bootstrap-"));
    await fs.mkdir(path.join(root, "raw/project/src"), { recursive: true });
    await fs.writeFile(path.join(root, "raw/project/README.md"), "# readme\n");
    await fs.writeFile(path.join(root, "raw/project/package.json"), "{}\n");
    await fs.writeFile(path.join(root, "raw/project/src/index.ts"), "export {}\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates direct-file pseudo-leaves and child leaves before workers run", async () => {
    const result = await bootstrapIngestProgress({
      cfg,
      projectRoot: root,
      rawScope: "raw/project",
    });

    expect(result).toMatchObject({ changed: true, leaves: 2, files: 3 });
    const state = await readState();
    expect(Object.keys(state.leaves).sort()).toEqual([
      "raw/project/",
      "raw/project/src/",
    ]);
    expect(state.leaves["raw/project/"]).toMatchObject({
      status: "pending",
      kind: "mixed",
      project: "project",
    });
    expect(state.leaves["raw/project/"].sub_chunks).toHaveLength(1);
    expect(state.leaves["raw/project/"].sub_chunks[0].files).toEqual([
      "raw/project/package.json",
      "raw/project/README.md",
    ]);
    expect(state.leaves["raw/project/src/"]).toMatchObject({
      status: "pending",
      kind: "code",
      project: "project",
      graph_scope: "raw/project/src/",
    });
    await expect(
      fs.readFile(path.join(root, "progress/ingest/DASHBOARD.md"), "utf8"),
    ).resolves.toContain("raw/project/src/");
  });

  it("excludes dot-prefixed files and directories from ingest leaves", async () => {
    await fs.mkdir(path.join(root, "raw/project/.obsidian"), { recursive: true });
    await fs.mkdir(path.join(root, "raw/project/src/.generated"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "raw/project/.obsidian/workspace.json"),
      "{}\n",
    );
    await fs.writeFile(path.join(root, "raw/project/.env"), "TOKEN=redacted\n");
    await fs.writeFile(
      path.join(root, "raw/project/src/.generated/schema.ts"),
      "export {}\n",
    );

    const result = await bootstrapIngestProgress({
      cfg,
      projectRoot: root,
      rawScope: "raw/project",
    });

    expect(result).toMatchObject({ changed: true, leaves: 2, files: 3 });
    const state = await readState();
    expect(Object.keys(state.leaves).sort()).toEqual([
      "raw/project/",
      "raw/project/src/",
    ]);
    expect(JSON.stringify(state.leaves)).not.toContain(".obsidian");
    expect(JSON.stringify(state.leaves)).not.toContain(".env");
    expect(JSON.stringify(state.leaves)).not.toContain(".generated");
  });

  it("is idempotent and rewrites only when source metadata changes", async () => {
    await bootstrapIngestProgress({ cfg, projectRoot: root, rawScope: "raw/project" });
    const first = await readState();

    const second = await bootstrapIngestProgress({
      cfg,
      projectRoot: root,
      rawScope: "raw/project",
    });
    expect(second.changed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.appendFile(path.join(root, "raw/project/src/index.ts"), "// changed\n");
    const third = await bootstrapIngestProgress({
      cfg,
      projectRoot: root,
      rawScope: "raw/project",
    });
    expect(third.changed).toBe(true);
    const changed = await readState();
    expect(changed.leaves["raw/project/"].hash).toBe(
      first.leaves["raw/project/"].hash,
    );
    expect(changed.leaves["raw/project/src/"].hash).not.toBe(
      first.leaves["raw/project/src/"].hash,
    );
    expect(changed.leaves["raw/project/src/"].status).toBe("pending");
  });
});
