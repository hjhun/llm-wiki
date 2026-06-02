import { describe, expect, it } from "vitest";
import { extractHeadings, slugify } from "./markdown-headings";

describe("slugify", () => {
  it("lowercases ASCII and hyphenates separators", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  Multiple   spaces  ")).toBe("multiple-spaces");
  });

  it("keeps Korean characters", () => {
    expect(slugify("지식 그래프")).toBe("지식-그래프");
  });
});

describe("extractHeadings", () => {
  it("extracts ATX headings with depth, text, and slug", () => {
    const md = "# Title\n\n## 섹션 하나\n\ntext\n\n### Sub Part\n";
    expect(extractHeadings(md)).toEqual([
      { depth: 1, text: "Title", slug: "title" },
      { depth: 2, text: "섹션 하나", slug: "섹션-하나" },
      { depth: 3, text: "Sub Part", slug: "sub-part" },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = "# Real\n\n```\n# not a heading\n```\n\n## Also real\n";
    expect(extractHeadings(md).map((h) => h.text)).toEqual([
      "Real",
      "Also real",
    ]);
  });

  it("strips trailing closing hashes", () => {
    expect(extractHeadings("## Heading ##")[0].text).toBe("Heading");
  });

  it("returns empty for content without headings", () => {
    expect(extractHeadings("just text")).toEqual([]);
    expect(extractHeadings("")).toEqual([]);
  });
});
