import { describe, expect, it } from "vitest";
import {
  drainScopedMergeState,
  renderIngestDashboard,
} from "./merge-drain";

describe("drainScopedMergeState", () => {
  const baseState = {
    version: 1,
    leaves: {
      "raw/demo/": {
        status: "done",
        sub_chunks: [
          {
            id: "c1",
            status: "done",
            files: ["raw/demo/note.md"],
            source_pages_written: ["wiki/sources/demo/note.md"],
          },
        ],
      },
    },
    merge_pass: {
      status: "pending",
      last_run_at: null,
      pending_parents: ["raw/other/", "raw/demo/"],
    },
  };

  it("drains exactly one scoped merge parent when all scoped leaves are done", () => {
    const out = drainScopedMergeState({
      state: baseState,
      rawScope: "raw/demo",
      nowIso: "2026-06-17T00:00:00.000Z",
    });

    expect(out?.parent).toBe("raw/demo/");
    expect(out?.state.merge_pass).toMatchObject({
      status: "pending",
      last_run_at: "2026-06-17T00:00:00.000Z",
      pending_parents: ["raw/other/"],
    });
    expect(baseState.merge_pass.pending_parents).toEqual([
      "raw/other/",
      "raw/demo/",
    ]);
  });

  it("marks merge_pass done when no pending parent remains", () => {
    const out = drainScopedMergeState({
      state: {
        ...baseState,
        merge_pass: { status: "pending", pending_parents: ["raw/demo/"] },
      },
      rawScope: "raw/demo",
      nowIso: "2026-06-17T00:00:00.000Z",
    });

    expect(out?.state.merge_pass).toMatchObject({
      status: "done",
      pending_parents: [],
    });
  });

  it("does not drain when scoped leaves are still pending", () => {
    const out = drainScopedMergeState({
      state: {
        ...baseState,
        leaves: {
          "raw/demo/": {
            status: "pending",
            sub_chunks: [{ id: "c1", status: "pending" }],
          },
        },
      },
      rawScope: "raw/demo",
      nowIso: "2026-06-17T00:00:00.000Z",
    });

    expect(out).toBeNull();
  });

  it("does not drain broad scopes with multiple scoped parents", () => {
    const out = drainScopedMergeState({
      state: {
        ...baseState,
        merge_pass: {
          status: "pending",
          pending_parents: ["raw/demo/a/", "raw/demo/b/"],
        },
      },
      rawScope: "raw/demo",
      nowIso: "2026-06-17T00:00:00.000Z",
    });

    expect(out).toBeNull();
  });
});

describe("renderIngestDashboard", () => {
  it("renders counts, table rows, and last activity", () => {
    const md = renderIngestDashboard(
      {
        leaves: {
          "raw/demo/": {
            status: "done",
            sub_chunks: [
              {
                id: "c1",
                status: "done",
                started_at: "2026-06-17T00:00:00.000Z",
                ended_at: "2026-06-17T00:01:00.000Z",
              },
            ],
            last_session: "sessions/demo.md",
          },
        },
      },
      "2026-06-17T00:02:00.000Z",
    );

    expect(md).toContain("Leaves: 1/1 done");
    expect(md).toContain("raw/demo/ — sub-chunk c1 (done)");
    expect(md).toContain("| `raw/demo/` | done | 1/1 |");
  });
});
