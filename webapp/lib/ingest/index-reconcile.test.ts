import { describe, expect, it } from "vitest";
import {
  categoryForType,
  deriveSummary,
  reconcileIndexContent,
  splitFrontmatter,
  type IndexPage,
} from "./index-reconcile";

const INDEX = `---
title: LLM Wiki — Index
type: index
updated: 2026-05-24
---

# Index

Rule: each item is one line in the format \`- [[Page Name]] — One-line summary\`.

## Entities

(empty for now)

## Concepts

- [[wiki/concepts/river-crossings]] — Hand-written summary that must be kept

## Sources

- [[wiki/sources/index]] — Source catalog organized by source metadata facets

## Graph

- \`wiki/graph/GRAPH_REPORT.md\` — Knowledge graph report
`;

const page = (over: Partial<IndexPage>): IndexPage => ({
  relNoExt: "wiki/entities/lyon",
  title: "Lyon",
  category: "Entities",
  summary: "A city entity.",
  ...over,
});

describe("categoryForType", () => {
  it("maps known synthesis types and ignores nav/source types", () => {
    expect(categoryForType("entity")).toBe("Entities");
    expect(categoryForType("Concept")).toBe("Concepts");
    expect(categoryForType("architecture")).toBe("Code");
    expect(categoryForType("analysis")).toBe("Comparisons");
    expect(categoryForType("source")).toBeNull();
    expect(categoryForType("index")).toBeNull();
    expect(categoryForType(null)).toBeNull();
  });
});

describe("deriveSummary", () => {
  it("takes the first prose sentence, skipping headings and lists", () => {
    const body = "# Lyon\n\n- a bullet\n\nLyon sits on the Rhône. More text.\n";
    expect(deriveSummary(body, "Lyon")).toBe("Lyon sits on the Rhône.");
  });
  it("flattens wikilinks and falls back to the title", () => {
    expect(deriveSummary("See [[River Crossings]] here.", "X")).toBe(
      "See River Crossings here.",
    );
    expect(deriveSummary("# Only a heading\n", "Fallback Title")).toBe(
      "Fallback Title",
    );
  });
});

describe("splitFrontmatter", () => {
  it("reads scalars and returns the body", () => {
    const { scalar, body } = splitFrontmatter(
      "---\ntype: entity\ntitle: Lyon\n---\nBody here.\n",
    );
    expect(scalar("type")).toBe("entity");
    expect(scalar("title")).toBe("Lyon");
    expect(body.trim()).toBe("Body here.");
  });
});

describe("reconcileIndexContent", () => {
  it("adds a missing entity into its section", () => {
    const { content, added } = reconcileIndexContent(INDEX, [page({})]);
    expect(added.map((p) => p.relNoExt)).toEqual(["wiki/entities/lyon"]);
    expect(content).toContain("- [[wiki/entities/lyon]] — A city entity.");
    // placeholder replaced
    expect(content).toMatch(/## Entities\n\n- \[\[wiki\/entities\/lyon\]\]/);
    expect(content).not.toMatch(/## Entities\n\n\(empty for now\)/);
    // updated bumped
    expect(content).not.toContain("updated: 2026-05-24");
  });

  it("preserves an existing hand-written summary verbatim", () => {
    const { content } = reconcileIndexContent(INDEX, [
      page({
        relNoExt: "wiki/concepts/river-crossings",
        category: "Concepts",
        summary: "MECHANICAL should not overwrite",
      }),
    ]);
    expect(content).toContain(
      "- [[wiki/concepts/river-crossings]] — Hand-written summary that must be kept",
    );
    expect(content).not.toContain("MECHANICAL should not overwrite");
  });

  it("is a byte-for-byte no-op when nothing is missing", () => {
    const { content, added } = reconcileIndexContent(INDEX, [
      page({
        relNoExt: "wiki/concepts/river-crossings",
        category: "Concepts",
        summary: "anything",
      }),
    ]);
    expect(added).toEqual([]);
    expect(content).toBe(INDEX);
  });

  it("is idempotent: a second run adds nothing", () => {
    const first = reconcileIndexContent(INDEX, [page({})]).content;
    const second = reconcileIndexContent(first, [page({})]);
    expect(second.added).toEqual([]);
    expect(second.content).toBe(first);
  });

  it("creates a missing managed section in canonical order", () => {
    const { content } = reconcileIndexContent(INDEX, [
      page({
        relNoExt: "wiki/code/clio",
        title: "clio",
        category: "Code",
        summary: "The CLIO webapp.",
      }),
    ]);
    expect(content).toContain("## Code");
    // Code is inserted after Concepts and before Sources.
    expect(content.indexOf("## Code")).toBeGreaterThan(
      content.indexOf("## Concepts"),
    );
    expect(content.indexOf("## Code")).toBeLessThan(content.indexOf("## Sources"));
  });

  it("ignores unmanaged (source) pages and leaves Sources/Graph untouched", () => {
    const { content, added } = reconcileIndexContent(INDEX, [
      page({ relNoExt: "wiki/sources/_probe/note1", category: "Sources" }),
    ]);
    expect(added).toEqual([]);
    expect(content).toBe(INDEX);
  });
});
