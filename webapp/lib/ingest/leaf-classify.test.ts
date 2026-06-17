import { describe, expect, it } from "vitest";
import {
  classifyLeafFromFiles,
  collectLeafFiles,
  fileLooksLikeCode,
  fileLooksLikeRuntimeEvidence,
  inferLeafKind,
  isHiddenPath,
  isIgnoredCodePath,
} from "./leaf-classify";

describe("isHiddenPath", () => {
  it("flags any path segment that starts with a dot", () => {
    expect(isHiddenPath("raw/.obsidian/workspace.json")).toBe(true);
    expect(isHiddenPath("raw/project/.env")).toBe(true);
    expect(isHiddenPath("raw/project/src/.generated/file.ts")).toBe(true);
  });

  it("leaves ordinary paths alone", () => {
    expect(isHiddenPath("raw/project/src/main.ts")).toBe(false);
  });
});

describe("isIgnoredCodePath", () => {
  it("flags vendor/build/git directories anywhere in the path", () => {
    expect(isIgnoredCodePath("raw/app/node_modules/x.js")).toBe(true);
    expect(isIgnoredCodePath("raw/.git/config")).toBe(true);
    expect(isIgnoredCodePath("raw/target/debug/bin")).toBe(true);
  });
  it("flags dot-prefixed directories and files anywhere in the path", () => {
    expect(isIgnoredCodePath("raw/.obsidian/workspace.json")).toBe(true);
    expect(isIgnoredCodePath("raw/app/.env")).toBe(true);
    expect(isIgnoredCodePath("raw/app/src/.generated/types.ts")).toBe(true);
  });
  it("leaves ordinary source paths alone", () => {
    expect(isIgnoredCodePath("raw/app/src/main.ts")).toBe(false);
  });
});

describe("fileLooksLikeCode", () => {
  it("detects by extension and manifest name", () => {
    expect(fileLooksLikeCode("raw/app/main.rs")).toBe(true);
    expect(fileLooksLikeCode("raw/app/package.json")).toBe(true);
    expect(fileLooksLikeCode("raw/app/Dockerfile")).toBe(true);
  });
  it("detects test/spec paths even with prose extensions", () => {
    expect(fileLooksLikeCode("raw/app/__tests__/foo.txt")).toBe(true);
  });
  it("returns false for prose and ignored paths", () => {
    expect(fileLooksLikeCode("raw/articles/essay.md")).toBe(false);
    expect(fileLooksLikeCode("raw/app/node_modules/lib.js")).toBe(false);
  });
});

describe("fileLooksLikeRuntimeEvidence", () => {
  it("flags logs, stack traces, and crash/CI artifacts", () => {
    expect(fileLooksLikeRuntimeEvidence("raw/run/server.log")).toBe(true);
    expect(fileLooksLikeRuntimeEvidence("raw/run/stacktrace.txt")).toBe(true);
    expect(fileLooksLikeRuntimeEvidence("raw/ci/output.txt")).toBe(true);
  });
  it("ignores plain prose", () => {
    expect(fileLooksLikeRuntimeEvidence("raw/notes/idea.md")).toBe(false);
  });
});

describe("classifyLeafFromFiles", () => {
  it("returns ignore when every file is in an ignored dir", () => {
    expect(classifyLeafFromFiles(["raw/app/node_modules/a.js"])).toBe("ignore");
  });
  it("returns ignore when every file is under a dot-prefixed path", () => {
    expect(classifyLeafFromFiles(["raw/.obsidian/workspace.json"])).toBe(
      "ignore",
    );
  });
  it("returns prose when no file looks like code", () => {
    expect(classifyLeafFromFiles(["raw/a.md", "raw/b.md"])).toBe("prose");
  });
  it("returns code when every actionable file is code", () => {
    expect(classifyLeafFromFiles(["raw/a.ts", "raw/b.rs"])).toBe("code");
  });
  it("returns mixed when code and prose coexist", () => {
    expect(classifyLeafFromFiles(["raw/a.ts", "raw/readme.md"])).toBe("mixed");
  });
  it("ignores vendored files when judging the rest of the leaf", () => {
    expect(
      classifyLeafFromFiles(["raw/a.ts", "raw/node_modules/dep.js"]),
    ).toBe("code");
  });
  it("returns prose for an empty leaf", () => {
    expect(classifyLeafFromFiles([])).toBe("prose");
  });
});

describe("collectLeafFiles", () => {
  it("merges the leaf's files and each sub-chunk's files, normalizing slashes", () => {
    const files = collectLeafFiles("raw/x", {
      files: ["raw/x/a.ts"],
      sub_chunks: [{ files: ["raw\\x\\b.ts"] }, { files: ["raw/x/a.ts"] }],
    });
    expect(files.sort()).toEqual(["raw/x/a.ts", "raw/x/b.ts"]);
  });
  it("falls back to the leaf path when no files are recorded", () => {
    expect(collectLeafFiles("raw/x", {})).toEqual(["raw/x"]);
  });
});

describe("inferLeafKind", () => {
  it("honors an explicit kind field", () => {
    expect(inferLeafKind("raw/x", { kind: "mixed", files: ["a.md"] })).toBe(
      "mixed",
    );
  });
  it("classifies from files when kind is absent", () => {
    expect(inferLeafKind("raw/x", { files: ["raw/x/main.ts"] })).toBe("code");
    expect(inferLeafKind("raw/x", { files: ["raw/x/notes.md"] })).toBe("prose");
  });
});
