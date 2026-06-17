import { describe, expect, it } from "vitest";
import { resolveEntry, isLikelyText } from "./files";
import { WORKSPACE_ROOTS } from "./paths";

/**
 * resolveEntry is the Explorer/Chat file-access gate: it rejects unknown
 * workspaces, sensitive files (.env, .git, keys, credentials), and any path
 * that escapes the workspace root (via resolveSafe). isLikelyText decides
 * whether a file is served as text.
 */

describe("resolveEntry", () => {
  it("resolves a normal path inside its workspace", () => {
    const out = resolveEntry("wiki", "concepts/foo.md");
    expect(out.startsWith(WORKSPACE_ROOTS.wiki)).toBe(true);
  });

  it("resolves progress artifacts inside the progress workspace", () => {
    const out = resolveEntry("progress", "automation/artifacts/job/run/summary.md");
    expect(out.startsWith(WORKSPACE_ROOTS.progress)).toBe(true);
  });

  it("strips a leading slash before resolving", () => {
    expect(resolveEntry("wiki", "/index.md")).toBe(
      resolveEntry("wiki", "index.md"),
    );
  });

  it("rejects an unknown workspace", () => {
    // @ts-expect-error testing a runtime guard with a bad workspace key
    expect(() => resolveEntry("secrets", "x")).toThrow(/unknown workspace/);
  });

  it("blocks sensitive files", () => {
    expect(() => resolveEntry("wiki", ".env")).toThrow(/sensitive/);
    expect(() => resolveEntry("raw", "sub/.env.local")).toThrow(/sensitive/);
    expect(() => resolveEntry("wiki", "deploy/server.key")).toThrow(
      /sensitive/,
    );
    expect(() => resolveEntry("wiki", "tls/cert.pem")).toThrow(/sensitive/);
    expect(() => resolveEntry("raw", "app/.git/config")).toThrow(/sensitive/);
    expect(() => resolveEntry("wiki", "credentials.json")).toThrow(
      /sensitive/,
    );
    expect(() => resolveEntry("progress", "automation/.env")).toThrow(/sensitive/);
  });

  it("rejects directory traversal escapes", () => {
    expect(() => resolveEntry("wiki", "../raw/x")).toThrow(/escapes/);
  });
});

describe("isLikelyText", () => {
  it("treats common text/code extensions as text", () => {
    for (const f of ["a.md", "b.ts", "c.json", "d.txt", "e.yaml"]) {
      expect(isLikelyText(f)).toBe(true);
    }
  });
  it("treats binaries as non-text", () => {
    for (const f of ["a.png", "b.pdf", "c.zip"]) {
      expect(isLikelyText(f)).toBe(false);
    }
  });
});
