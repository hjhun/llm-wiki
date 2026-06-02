import { describe, expect, it } from "vitest";
import { makeSnippet, titleOf } from "./search";

describe("makeSnippet", () => {
  it("centers the snippet on the first match with ellipses", () => {
    const content = "a".repeat(100) + " NEEDLE " + "b".repeat(100);
    const snippet = makeSnippet(content, "needle", 10);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.toLowerCase()).toContain("needle");
  });

  it("collapses whitespace and falls back to the head when no match", () => {
    // No match: returns the first radius*2 chars of the whitespace-collapsed text.
    const snippet = makeSnippet("one   two\n\nthree", "zzz", 5);
    expect(snippet).toBe("one two th");
  });
});

describe("titleOf", () => {
  it("prefers the frontmatter title", () => {
    const md = "---\ntitle: My Page\ntype: answer\n---\n# Heading\nbody";
    expect(titleOf(md, "answers/x.md")).toBe("My Page");
  });

  it("strips quotes from a quoted frontmatter title", () => {
    const md = '---\ntitle: "Quoted"\n---\n';
    expect(titleOf(md, "x.md")).toBe("Quoted");
  });

  it("falls back to the first heading", () => {
    expect(titleOf("# Real Heading\n\ntext", "x.md")).toBe("Real Heading");
  });

  it("falls back to the filename", () => {
    expect(titleOf("no title here", "sources/articles/foo.md")).toBe("foo.md");
  });
});
