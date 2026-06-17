import { describe, expect, it } from "vitest";
import { resolveWikilink } from "./wikilink";

describe("resolveWikilink", () => {
  it("links a path-style target into the Explorer, appending .md", () => {
    expect(resolveWikilink("wiki/sources/articles/foo")).toEqual({
      label: "wiki/sources/articles/foo",
      href: "/explorer?ws=wiki&path=sources%2Farticles%2Ffoo.md",
    });
  });

  it("keeps an existing extension", () => {
    const r = resolveWikilink("raw/notes/log.txt");
    expect(r?.href).toBe("/explorer?ws=raw&path=notes%2Flog.txt");
  });

  it("links progress paths into the progress workspace", () => {
    const r = resolveWikilink("progress/automation/artifacts/job/run/summary.md");
    expect(r?.href).toBe(
      "/explorer?ws=progress&path=automation%2Fartifacts%2Fjob%2Frun%2Fsummary.md",
    );
  });

  it("defaults to the wiki workspace when no known prefix is present", () => {
    const r = resolveWikilink("concepts/pattern");
    expect(r?.href).toBe("/explorer?ws=wiki&path=concepts%2Fpattern.md");
  });

  it("supports an explicit display label", () => {
    expect(resolveWikilink("wiki/sources/foo|Foo Source")).toEqual({
      label: "Foo Source",
      href: "/explorer?ws=wiki&path=sources%2Ffoo.md",
    });
  });

  it("renders a title-only target as a non-navigating chip", () => {
    expect(resolveWikilink("Some Concept")).toEqual({
      label: "Some Concept",
      href: null,
    });
  });

  it("returns null for empty inner text", () => {
    expect(resolveWikilink("")).toBeNull();
    expect(resolveWikilink("   ")).toBeNull();
  });
});
