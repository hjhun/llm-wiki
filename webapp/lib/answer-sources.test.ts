import { describe, expect, it } from "vitest";
import { extractAnswerSources, sourceHref } from "./answer-sources";

describe("extractAnswerSources", () => {
  it("collects bare, wikilink, and markdown-link source references", () => {
    const md = [
      "근거는 [[wiki/sources/articles/foo]] 입니다.",
      "또한 `wiki/sources/books/bar/ch1.md` 를 보세요.",
      "[링크](/explorer?ws=wiki&path=sources/notes/baz.md) 참고: wiki/sources/notes/baz.md",
    ].join("\n");
    const sources = extractAnswerSources(md);
    expect(sources.map((s) => s.label)).toEqual([
      "articles/foo",
      "books/bar/ch1",
      "notes/baz",
    ]);
  });

  it("appends .md when the reference has no extension", () => {
    const sources = extractAnswerSources("see wiki/sources/articles/foo");
    expect(sources[0].path).toBe("wiki/sources/articles/foo.md");
  });

  it("dedupes repeated references", () => {
    const md = "wiki/sources/a.md and again wiki/sources/a.md";
    expect(extractAnswerSources(md)).toHaveLength(1);
  });

  it("strips trailing punctuation", () => {
    const sources = extractAnswerSources("끝: wiki/sources/articles/foo.md.");
    expect(sources[0].path).toBe("wiki/sources/articles/foo.md");
  });

  it("returns empty when there are no source references", () => {
    expect(extractAnswerSources("no sources here")).toEqual([]);
    expect(extractAnswerSources("")).toEqual([]);
  });
});

describe("sourceHref", () => {
  it("builds an Explorer href relative to the wiki root", () => {
    expect(sourceHref("wiki/sources/articles/foo.md")).toBe(
      "/explorer?ws=wiki&path=sources%2Farticles%2Ffoo.md",
    );
  });
});
