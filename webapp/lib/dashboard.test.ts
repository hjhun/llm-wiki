import { describe, expect, it } from "vitest";
import {
  countUnprocessedRaw,
  expectedSourcePath,
  parseRecentLog,
} from "./dashboard";

describe("expectedSourcePath", () => {
  it("maps a raw path to its source page path, switching the extension", () => {
    expect(expectedSourcePath("articles/foo.pdf")).toBe("articles/foo.md");
    expect(expectedSourcePath("notes/bar.md")).toBe("notes/bar.md");
    expect(expectedSourcePath("top.txt")).toBe("top.md");
  });

  it("leaves extensionless paths untouched (adds .md)", () => {
    expect(expectedSourcePath("readme")).toBe("readme.md");
  });
});

describe("countUnprocessedRaw", () => {
  it("counts raw files that have no matching source page", () => {
    const raw = ["articles/foo.md", "articles/bar.md"];
    const sources = ["articles/foo.md"];
    expect(countUnprocessedRaw(raw, sources)).toBe(1);
  });

  it("treats a directory-level index.md summary as processed", () => {
    const raw = ["logs/run/stdout.log", "logs/run/stderr.log"];
    const sources = ["logs/run/index.md"];
    expect(countUnprocessedRaw(raw, sources)).toBe(0);
  });

  it("ignores trash and dotfiles", () => {
    const raw = [".trash/old.md", ".gitkeep", "x/.hidden", "x/keep.md"];
    expect(countUnprocessedRaw(raw, [])).toBe(1);
  });

  it("returns zero when everything is processed", () => {
    const raw = ["a.md", "b/c.md"];
    const sources = ["a.md", "b/c.md"];
    expect(countUnprocessedRaw(raw, sources)).toBe(0);
  });
});

describe("parseRecentLog", () => {
  const log = `# Activity Log

## [2026-05-16 00:00] init | Wiki initialization
- Created: x

## [2026-05-17 10:00] ingest | First source
- Notes: ok

## [2026-05-18 12:30] lint | Health check
- Notes: clean
`;

  it("parses headings into timestamp/op/title and returns most-recent first", () => {
    const entries = parseRecentLog(log, 6);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      timestamp: "2026-05-18 12:30",
      op: "lint",
      title: "Health check",
    });
    expect(entries[2].op).toBe("init");
  });

  it("respects the limit, keeping the newest entries", () => {
    const entries = parseRecentLog(log, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("lint");
  });

  it("handles titles containing pipe characters", () => {
    const entries = parseRecentLog(
      "## [2026-05-20 09:00] query | a | b | c\n",
    );
    expect(entries[0].title).toBe("a | b | c");
  });

  it("returns an empty array when there are no headings", () => {
    expect(parseRecentLog("just text\nno headings")).toEqual([]);
  });
});
