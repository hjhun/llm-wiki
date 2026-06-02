import { describe, expect, it } from "vitest";
import {
  formatCancelledReply,
  formatTimedOutReply,
  inferKind,
  initialOperationSummary,
  normalizeKind,
  operationTargetFromMessage,
  querySingleAgentPolicy,
  shorten,
} from "./send-helpers";

describe("inferKind", () => {
  it("maps slash commands to their kind", () => {
    expect(inferKind("/ingest-loop raw/x")).toBe("ingest-loop");
    expect(inferKind("/ingest raw/x")).toBe("ingest");
    expect(inferKind("/preprocess raw/x ads")).toBe("preprocess");
    expect(inferKind("/query what is CLIO")).toBe("query");
    expect(inferKind("/lint")).toBe("lint");
    expect(inferKind("wiki-graphify build it")).toBe("graph");
  });
  it("treats an unknown slash command as chat", () => {
    expect(inferKind("/whoami")).toBe("chat");
  });
  it("defaults plain text to query", () => {
    expect(inferKind("how does ingest work?")).toBe("query");
  });
  it("checks ingest-loop before ingest (prefix order)", () => {
    expect(inferKind("/ingest-loop")).toBe("ingest-loop");
  });
});

describe("normalizeKind", () => {
  it("infers from the message when no kind or 'chat' is requested", () => {
    expect(normalizeKind("/lint")).toBe("lint");
    expect(normalizeKind("/lint", "chat")).toBe("lint");
  });
  it("respects an explicit non-chat requested kind", () => {
    expect(normalizeKind("anything", "ingest")).toBe("ingest");
  });
});

describe("operationTargetFromMessage", () => {
  it("derives the raw target for ingest, defaulting to raw/", () => {
    expect(operationTargetFromMessage("ingest", "/ingest raw/articles")).toBe(
      "raw/articles",
    );
    expect(operationTargetFromMessage("ingest", "/ingest")).toBe("raw/");
    expect(
      operationTargetFromMessage("ingest-loop", "/ingest-loop raw/books"),
    ).toBe("raw/books");
  });
  it("uses fixed targets for lint and graph", () => {
    expect(operationTargetFromMessage("lint", "/lint")).toBe("wiki/");
    expect(operationTargetFromMessage("graph", "wiki-graphify x")).toBe(
      "wiki/graph/",
    );
  });
  it("derives the preprocess target", () => {
    expect(
      operationTargetFromMessage("preprocess", "/preprocess raw/dump ads"),
    ).toBe("raw/dump ads");
  });
});

describe("initialOperationSummary", () => {
  it("produces a kind-specific summary mentioning the target", () => {
    expect(initialOperationSummary("lint", "wiki/")).toContain("lint 준비");
    expect(initialOperationSummary("ingest", "raw/x")).toContain("raw/x");
    expect(initialOperationSummary("query", "wiki/")).toContain("query 준비");
  });
});

describe("shorten", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(shorten("  a   b  ", 10)).toBe("a b");
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("formatCancelledReply / formatTimedOutReply", () => {
  it("includes the kind and metrics", () => {
    const c = formatCancelledReply({ kind: "ingest", exitCode: 1, durationMs: 5 });
    expect(c).toContain("Stop 요청");
    expect(c).toContain("kind: ingest");
    const t = formatTimedOutReply({ kind: "query", durationMs: 9 });
    expect(t).toContain("초과");
    expect(t).toContain("kind: query");
  });
});

describe("querySingleAgentPolicy", () => {
  it("returns the single-agent query policy text", () => {
    const p = querySingleAgentPolicy();
    expect(p).toContain("single-agent /query operation");
    expect(p).toContain("wiki-query");
  });
});
