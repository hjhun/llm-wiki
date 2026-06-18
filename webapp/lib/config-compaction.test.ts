import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./config";

// Minimal valid object that ConfigSchema.parse accepts (mirrors DEFAULT_CONFIG pattern)
const MINIMAL_VALID = {
  server: {},
  agent: {},
  chunking: {},
  graph: {},
  search: {},
  chat: {},
  cli: {},
  ui: {},
  auth: {},
  publicQuery: {},
  telegram: {},
  automation: {},
};

describe("cli.ingestLoop.compaction config", () => {
  it("applies compaction defaults when omitted", () => {
    const cfg = ConfigSchema.parse(MINIMAL_VALID);
    const c = cfg.cli.ingestLoop.compaction;
    expect(c.enabled).toBe(true);
    expect(c.ratio).toBeCloseTo(0.9);
    expect(c.contextWindowTokens.claude).toBe(200000);
    expect(c.contextWindowTokens.codex).toBe(272000);
    // cline defaults to 0 (compaction + `-v` measurement disabled) because the
    // `-v` summary line corrupts cline's non-interactive output over long loops.
    expect(c.contextWindowTokens.cline).toBe(0);
    expect(c.contextWindowTokens.agy).toBe(0);
  });

  it("rejects a ratio outside (0,1]", () => {
    expect(() =>
      ConfigSchema.parse({
        ...MINIMAL_VALID,
        cli: { ingestLoop: { compaction: { ratio: 1.5 } } },
      }),
    ).toThrow();
  });
});
