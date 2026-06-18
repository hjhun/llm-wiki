import { describe, expect, it } from "vitest";
import {
  resolveAgentForKind,
  resolveAgentForRole,
  roleForKind,
} from "./agent-roles";
import type { Config } from "./config";

function makeConfig(agent: Partial<Config["agent"]>): Config {
  return {
    agent: {
      default: null,
      safeMode: false,
      paths: {},
      roles: { maintenance: null, query: null },
      ...agent,
    },
  } as unknown as Config;
}

describe("roleForKind", () => {
  it("maps maintenance kinds to the maintenance role", () => {
    expect(roleForKind("ingest")).toBe("maintenance");
    expect(roleForKind("ingest-loop")).toBe("maintenance");
    expect(roleForKind("lint")).toBe("maintenance");
    expect(roleForKind("preprocess")).toBe("maintenance");
    expect(roleForKind("graph")).toBe("maintenance");
  });
  it("maps query to the query role", () => {
    expect(roleForKind("query")).toBe("query");
  });
  it("leaves plain chat unspecialized", () => {
    expect(roleForKind("chat")).toBeNull();
  });
});

describe("resolveAgentForRole", () => {
  it("falls back to agent.default when the role override is null", () => {
    const cfg = makeConfig({ default: "codex" });
    expect(resolveAgentForRole(cfg, "maintenance")).toBe("codex");
    expect(resolveAgentForRole(cfg, "query")).toBe("codex");
  });
  it("uses the role override when set", () => {
    const cfg = makeConfig({
      default: "codex",
      roles: { maintenance: "claude", query: "agy" },
    });
    expect(resolveAgentForRole(cfg, "maintenance")).toBe("claude");
    expect(resolveAgentForRole(cfg, "query")).toBe("agy");
  });
});

describe("resolveAgentForKind", () => {
  it("routes maintenance and query kinds to their role overrides", () => {
    const cfg = makeConfig({
      default: "codex",
      roles: { maintenance: "claude", query: "agy" },
    });
    expect(resolveAgentForKind(cfg, "ingest")).toBe("claude");
    expect(resolveAgentForKind(cfg, "lint")).toBe("claude");
    expect(resolveAgentForKind(cfg, "query")).toBe("agy");
  });
  it("uses agent.default for unspecialized chat", () => {
    const cfg = makeConfig({
      default: "codex",
      roles: { maintenance: "claude", query: "agy" },
    });
    expect(resolveAgentForKind(cfg, "chat")).toBe("codex");
  });
  it("preserves single-agent behavior when no overrides are set", () => {
    const cfg = makeConfig({ default: "cline" });
    expect(resolveAgentForKind(cfg, "ingest")).toBe("cline");
    expect(resolveAgentForKind(cfg, "query")).toBe("cline");
    expect(resolveAgentForKind(cfg, "chat")).toBe("cline");
  });
});
