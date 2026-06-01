import { describe, expect, it } from "vitest";
import {
  classifyLeafFromFiles,
  fileLooksLikeCode,
  fileLooksLikeRuntimeEvidence,
  isIgnoredCodePath,
} from "./leaf-classify";

describe("isIgnoredCodePath", () => {
  it("flags vendor/build/git directories anywhere in the path", () => {
    expect(isIgnoredCodePath("raw/app/node_modules/x.js")).toBe(true);
    expect(isIgnoredCodePath("raw/.git/config")).toBe(true);
    expect(isIgnoredCodePath("raw/target/debug/bin")).toBe(true);
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
