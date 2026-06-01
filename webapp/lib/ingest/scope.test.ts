import { describe, expect, it } from "vitest";
import {
  normalizePosixPath,
  normalizeRawScope,
  pathMatchesScope,
  pathSegments,
} from "./scope";

describe("normalizePosixPath", () => {
  it("converts backslashes and trims leading/trailing slashes", () => {
    expect(normalizePosixPath("\\raw\\articles\\")).toBe("raw/articles");
    expect(normalizePosixPath("/raw/foo/")).toBe("raw/foo");
    expect(normalizePosixPath("raw/foo")).toBe("raw/foo");
  });
});

describe("normalizeRawScope", () => {
  it("accepts raw and raw/ subpaths", () => {
    expect(normalizeRawScope("raw")).toBe("raw");
    expect(normalizeRawScope("raw/articles")).toBe("raw/articles");
    expect(normalizeRawScope("  raw/books/ch1  ")).toBe("raw/books/ch1");
  });

  it("rejects null, empty, and paths outside raw/", () => {
    expect(normalizeRawScope(null)).toBeNull();
    expect(normalizeRawScope("")).toBeNull();
    expect(normalizeRawScope("   ")).toBeNull();
    expect(normalizeRawScope("wiki/foo")).toBeNull();
    expect(normalizeRawScope("rawish/foo")).toBeNull();
  });
});

describe("pathMatchesScope", () => {
  it("matches everything when no scope is set", () => {
    expect(pathMatchesScope("raw/anything", null)).toBe(true);
    expect(pathMatchesScope("raw/anything", "")).toBe(true);
  });

  it("matches exact, descendant, and ancestor paths of the scope", () => {
    expect(pathMatchesScope("raw/articles", "raw/articles")).toBe(true);
    expect(pathMatchesScope("raw/articles/foo.md", "raw/articles")).toBe(true);
    // ancestor of the scope is kept so the merge parent stays in range
    expect(pathMatchesScope("raw", "raw/articles")).toBe(true);
  });

  it("rejects siblings and unrelated paths", () => {
    expect(pathMatchesScope("raw/books", "raw/articles")).toBe(false);
    expect(pathMatchesScope("raw/articles2", "raw/articles")).toBe(false);
  });
});

describe("pathSegments", () => {
  it("splits on both separators and drops empties", () => {
    expect(pathSegments("raw\\a/b/")).toEqual(["raw", "a", "b"]);
    expect(pathSegments("/x//y/")).toEqual(["x", "y"]);
  });
});
