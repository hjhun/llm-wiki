import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveSafe, WORKSPACE_ROOTS } from "./paths";

/**
 * resolveSafe is the directory-traversal guard behind every Explorer/Chat
 * file read and write: a relative path is resolved inside a fixed workspace
 * root, and anything that escapes the root must throw. These tests pin that
 * boundary so a future change can't silently allow `../` escapes.
 */

describe("resolveSafe", () => {
  it("resolves an in-workspace path under the root", () => {
    const out = resolveSafe("wiki", "concepts/foo.md");
    expect(out).toBe(path.join(WORKSPACE_ROOTS.wiki, "concepts/foo.md"));
    expect(out.startsWith(WORKSPACE_ROOTS.wiki)).toBe(true);
  });

  it("resolves the root itself for an empty relative path", () => {
    expect(resolveSafe("raw", "")).toBe(path.resolve(WORKSPACE_ROOTS.raw));
  });

  it("rejects a parent-traversal escape", () => {
    expect(() => resolveSafe("wiki", "../raw/secret.md")).toThrow(/escapes/);
    expect(() => resolveSafe("raw", "../../etc/passwd")).toThrow(/escapes/);
  });

  it("rejects a deep traversal that climbs out and back to a sibling", () => {
    expect(() => resolveSafe("wiki", "a/b/../../../sessions/x")).toThrow(
      /escapes/,
    );
  });

  it("keeps a traversal that stays within the workspace", () => {
    const out = resolveSafe("wiki", "a/b/../c.md");
    expect(out).toBe(path.join(WORKSPACE_ROOTS.wiki, "a/c.md"));
  });

  it("does not treat a sibling root with a shared prefix as inside", () => {
    // e.g. a hypothetical 'wiki-extra' sibling must not pass the wiki guard
    expect(() => resolveSafe("wiki", "../wiki-extra/x")).toThrow(/escapes/);
  });
});
