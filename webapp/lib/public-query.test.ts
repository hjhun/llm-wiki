import { describe, expect, it } from "vitest";
import {
  normalizePublicQuestion,
  sourceIsMentioned,
  visibleSourcesForAnswer,
  summarizeAgentStderr,
  type PublicQuerySource,
} from "./public-query";

const src = (over: Partial<PublicQuerySource> = {}): PublicQuerySource => ({
  path: "wiki/sources/articles/foo",
  title: "Foo Article",
  excerpt: "…",
  score: 1,
  ...over,
});

describe("normalizePublicQuestion", () => {
  it("returns trimmed plain text unchanged", () => {
    expect(normalizePublicQuestion("  what is CLIO?  ")).toBe("what is CLIO?");
  });
  it("strips a leading /query command", () => {
    expect(normalizePublicQuestion("/query what is CLIO?")).toBe(
      "what is CLIO?",
    );
  });
  it("strips an arbitrary leading slash command, keeping the rest", () => {
    expect(normalizePublicQuestion("/ask how does ingest work")).toBe(
      "how does ingest work",
    );
  });
  it("falls back to the first line for a bare slash command", () => {
    expect(normalizePublicQuestion("/help")).toBe("/help");
  });
  it("unwraps a wiki-graphify prefix", () => {
    expect(normalizePublicQuestion("wiki-graphify how are nodes linked")).toBe(
      "how are nodes linked",
    );
  });
  it("returns empty for blank input", () => {
    expect(normalizePublicQuestion("   ")).toBe("");
  });
});

describe("sourceIsMentioned", () => {
  it("matches when the answer contains the source path", () => {
    const answer = "See [[wiki/sources/articles/foo]] for details.";
    expect(sourceIsMentioned(answer, src())).toBe(true);
  });
  it("matches when the answer contains the title (case-insensitive)", () => {
    expect(sourceIsMentioned("the foo article explains it", src())).toBe(true);
  });
  it("does not match an unrelated answer", () => {
    expect(sourceIsMentioned("something entirely different", src())).toBe(
      false,
    );
  });
});

describe("visibleSourcesForAnswer", () => {
  it("keeps only cited sources and drops the excerpt field", () => {
    const sources = [
      src({ path: "wiki/sources/a", title: "Alpha" }),
      src({ path: "wiki/sources/b", title: "Beta" }),
    ];
    const answer = "Per wiki/sources/a, the answer is yes.";
    const visible = visibleSourcesForAnswer(answer, sources);
    expect(visible).toEqual([
      { path: "wiki/sources/a", title: "Alpha", score: 1 },
    ]);
    expect(visible[0]).not.toHaveProperty("excerpt");
  });

  it("returns nothing when no source is referenced", () => {
    expect(visibleSourcesForAnswer("no citations here", [src()])).toEqual([]);
  });
});

describe("summarizeAgentStderr", () => {
  it("prefers important lines (errors/warnings)", () => {
    const stderr = [
      "info: starting",
      "ERROR: something broke",
      "debug: noise",
      "WARN: heads up",
    ].join("\n");
    const out = summarizeAgentStderr(stderr);
    expect(out).toContain("ERROR: something broke");
    expect(out).toContain("WARN: heads up");
    expect(out).not.toContain("debug: noise");
  });

  it("falls back to the first lines when nothing looks important", () => {
    const stderr = ["line one", "line two"].join("\n");
    expect(summarizeAgentStderr(stderr)).toContain("line one");
  });
});
