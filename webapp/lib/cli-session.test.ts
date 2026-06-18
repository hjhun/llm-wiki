import { describe, expect, it } from "vitest";
import {
  cliSupportsResume,
  planSession,
  publicSandboxReadOnlyHomePathsForCli,
} from "./cli";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("cliSupportsResume", () => {
  it("reports claude, codex and cline as resume-capable", () => {
    expect(cliSupportsResume("claude")).toBe(true);
    expect(cliSupportsResume("codex")).toBe(true);
    expect(cliSupportsResume("cline")).toBe(true);
  });
  it("reports agy as not resume-capable", () => {
    expect(cliSupportsResume("agy")).toBe(false);
  });
});

const NOOP = { args: [], resumeId: null, sessionId: null, capture: false };

describe("planSession", () => {
  it("returns a no-op plan when no session is requested", () => {
    expect(planSession("claude")).toEqual(NOOP);
  });

  it("assigns a fresh UUID session id for a new claude run", () => {
    const plan = planSession("claude", {});
    expect(plan.sessionId).toMatch(UUID_RE);
    expect(plan.args).toEqual(["--session-id", plan.sessionId]);
    expect(plan.resumeId).toBeNull();
    expect(plan.capture).toBe(false);
  });

  it("honors a caller-provided id for a new claude session", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(planSession("claude", { id })).toEqual({
      args: ["--session-id", id],
      resumeId: null,
      sessionId: id,
      capture: false,
    });
  });

  it("resumes a claude session by id with --resume", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(planSession("claude", { id, resume: true })).toEqual({
      args: ["--resume", id],
      resumeId: null,
      sessionId: id,
      capture: false,
    });
  });

  it("falls back to fresh-process behavior for resume on a new claude session without an id", () => {
    const plan = planSession("claude", { resume: true });
    // No id to resume — start a fresh assigned session instead of an invalid resume.
    expect(plan.sessionId).toMatch(UUID_RE);
    expect(plan.args).toEqual(["--session-id", plan.sessionId]);
  });

  it("requests --json capture for a fresh codex run", () => {
    expect(planSession("codex", {})).toEqual({
      args: ["--json"],
      resumeId: null,
      sessionId: null,
      capture: true,
    });
  });

  it("resumes codex by id via the resume subcommand without capture", () => {
    const id = "019ed3ec-90eb-7a00-ad00-8db2745dec9b";
    expect(planSession("codex", { id, resume: true })).toEqual({
      args: [],
      resumeId: id,
      sessionId: id,
      capture: false,
    });
  });

  it("requests capture for a fresh cline run", () => {
    expect(planSession("cline", {})).toEqual({
      args: [],
      resumeId: null,
      sessionId: null,
      capture: true,
    });
  });

  it("resumes cline by task id with -T and no capture", () => {
    const id = "task-12345";
    expect(planSession("cline", { id, resume: true })).toEqual({
      args: ["-T", id],
      resumeId: null,
      sessionId: id,
      capture: false,
    });
  });

  it("returns a no-op plan for CLIs without resume-by-id support", () => {
    for (const cli of ["agy"] as const) {
      expect(planSession(cli, { id: "x", resume: true })).toEqual(NOOP);
    }
  });
});

describe("publicSandboxReadOnlyHomePathsForCli", () => {
  it("narrows Codex binds to credential/config files and writable runtime dirs", () => {
    expect(
      publicSandboxReadOnlyHomePathsForCli("codex", "/home/test", [
        ".codex",
        ".local/share/codex",
        "/home/test/.cache/codex",
        ".agents",
      ]),
    ).toEqual([
      ".agents",
      ".codex.json",
      ".codex/AGENTS.md",
      ".codex/auth.json",
      ".codex/config.toml",
      ".codex/rules",
    ]);
  });

  it("leaves non-Codex sandbox paths unchanged", () => {
    const paths = [".codex", ".claude", ".local/share/claude"];
    expect(
      publicSandboxReadOnlyHomePathsForCli("claude", "/home/test", paths),
    ).toBe(paths);
  });
});
