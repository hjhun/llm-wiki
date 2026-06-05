import { describe, expect, it } from "vitest";
import {
  leafMatchesScope,
  parseStateJsonActionable,
  stateLeafBelongsToSession,
  summarizeIngestState,
} from "./state";

const stateJson = (leaves: Record<string, unknown>) =>
  JSON.stringify({ leaves });

describe("summarizeIngestState", () => {
  it("returns null for unparseable or shapeless input", () => {
    expect(summarizeIngestState("{not json")).toBeNull();
    expect(summarizeIngestState("{}")).toBeNull();
    expect(summarizeIngestState(JSON.stringify({ leaves: null }))).toBeNull();
  });

  it("counts leaves by status and excludes stale", () => {
    const s = summarizeIngestState(
      stateJson({
        "raw/a": { status: "done" },
        "raw/b": { status: "pending" },
        "raw/c": { status: "in_progress" },
        "raw/d": { status: "partial" },
        "raw/e": { status: "error" },
        "raw/f": { status: "stale" }, // excluded entirely
      }),
    );
    expect(s).toMatchObject({
      total: 5,
      done: 1,
      pending: 1,
      in_progress: 1,
      partial: 1,
      error: 1,
    });
  });

  it("surfaces the first in_progress sub-chunk as the active leaf", () => {
    const s = summarizeIngestState(
      stateJson({
        "raw/a": {
          status: "in_progress",
          sub_chunks: [
            { id: "c1", status: "done" },
            { id: "c2", status: "in_progress" },
          ],
        },
      }),
    );
    expect(s?.active_leaf).toBe("raw/a");
    expect(s?.active_subchunk).toEqual({ id: "c2", status: "in_progress" });
  });

  it("filters by session and returns null when nothing matches", () => {
    const raw = stateJson({
      "raw/a": { status: "done", last_session: "2026-06-01/x_ingest.md" },
      "raw/b": { status: "pending", last_session: "other.md" },
    });
    const mine = summarizeIngestState(raw, {
      sessionPath: "2026-06-01/x_ingest.md",
    });
    expect(mine?.total).toBe(1);
    expect(summarizeIngestState(raw, { sessionPath: "nope.md" })).toBeNull();
  });

  it("filters by raw scope", () => {
    const raw = stateJson({
      "raw/articles/a": { status: "pending" },
      "raw/books/b": { status: "pending" },
    });
    const s = summarizeIngestState(raw, { rawScope: "raw/articles" });
    expect(s?.total).toBe(1);
  });
});

describe("parseStateJsonActionable", () => {
  it("returns sorted leaves that are not done/stale/error", () => {
    const list = parseStateJsonActionable(
      stateJson({
        "raw/c": { status: "pending" },
        "raw/a": { status: "in_progress" },
        "raw/b": { status: "done" },
        "raw/d": { status: "error" },
        "raw/e": { status: "partial" },
      }),
      null,
    );
    expect(list).toEqual(["raw/a", "raw/c", "raw/e"]);
  });

  it("returns null for empty leaves (bootstrap signal)", () => {
    expect(parseStateJsonActionable(stateJson({}), null)).toBeNull();
  });

  it("returns null when a scope matches no enumerated leaf (bootstrap signal)", () => {
    // Leaves exist for other subtrees but none fall inside the requested scope,
    // so the scope was never enumerated. Must bootstrap, not hand every worker
    // an empty assignment.
    expect(
      parseStateJsonActionable(
        stateJson({
          "raw/articles/a": { status: "pending" },
          "raw/books/b": { status: "done" },
        }),
        "raw/tizen/alarm",
      ),
    ).toBeNull();
  });

  it("returns null when all leaves are terminal (bootstrap re-scan signal)", () => {
    expect(
      parseStateJsonActionable(
        stateJson({
          "raw/a": { status: "done" },
          "raw/b": { status: "stale" },
        }),
        null,
      ),
    ).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseStateJsonActionable("nope", null)).toBeNull();
  });

  it("respects raw scope", () => {
    const list = parseStateJsonActionable(
      stateJson({
        "raw/articles/a": { status: "pending" },
        "raw/books/b": { status: "pending" },
      }),
      "raw/articles",
    );
    expect(list).toEqual(["raw/articles/a"]);
  });
});

describe("leafMatchesScope", () => {
  it("matches everything without a scope", () => {
    expect(leafMatchesScope("raw/x", {}, null)).toBe(true);
  });
  it("matches by leaf path within scope", () => {
    expect(leafMatchesScope("raw/articles/a", {}, "raw/articles")).toBe(true);
    expect(leafMatchesScope("raw/books/b", {}, "raw/articles")).toBe(false);
  });
  it("matches when a recorded file falls inside the scope", () => {
    const leaf = { files: ["raw/articles/deep.md"] };
    expect(leafMatchesScope("raw/other", leaf, "raw/articles")).toBe(true);
  });
});

describe("stateLeafBelongsToSession", () => {
  it("matches with and without the sessions/ prefix", () => {
    expect(stateLeafBelongsToSession({ last_session: "x.md" }, "x.md")).toBe(true);
    expect(
      stateLeafBelongsToSession({ last_session: "sessions/x.md" }, "x.md"),
    ).toBe(true);
    expect(stateLeafBelongsToSession({ last_session: "y.md" }, "x.md")).toBe(false);
    expect(stateLeafBelongsToSession({}, "x.md")).toBe(false);
  });
});
