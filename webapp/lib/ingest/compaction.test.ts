import { describe, it, expect } from "vitest";
import {
  decideCompaction,
  compactionWindowFor,
  compactionEnabledFor,
} from "./compaction";
import type { Config } from "../config";

const cfg = {
  cli: {
    ingestLoop: {
      compaction: {
        enabled: true,
        ratio: 0.9,
        contextWindowTokens: { claude: 200000, codex: 272000, cline: 200000, agy: 0 },
      },
    },
  },
} as unknown as Config;

describe("decideCompaction", () => {
  it("compacts at/above the threshold", () => {
    expect(decideCompaction({ contextTokens: 180000, windowTokens: 200000, ratio: 0.9, enabled: true }).compact).toBe(true);
    expect(decideCompaction({ contextTokens: 190000, windowTokens: 200000, ratio: 0.9, enabled: true }).compact).toBe(true);
  });
  it("does not compact below the threshold", () => {
    expect(decideCompaction({ contextTokens: 179999, windowTokens: 200000, ratio: 0.9, enabled: true }).compact).toBe(false);
  });
  it("never compacts when contextTokens is null", () => {
    expect(decideCompaction({ contextTokens: null, windowTokens: 200000, ratio: 0.9, enabled: true }).compact).toBe(false);
  });
  it("never compacts when window is 0 or disabled", () => {
    expect(decideCompaction({ contextTokens: 999999, windowTokens: 0, ratio: 0.9, enabled: true }).compact).toBe(false);
    expect(decideCompaction({ contextTokens: 999999, windowTokens: 200000, ratio: 0.9, enabled: false }).compact).toBe(false);
  });
});

describe("config helpers", () => {
  it("reads per-CLI window and enabled flag", () => {
    expect(compactionWindowFor(cfg, "claude")).toBe(200000);
    expect(compactionWindowFor(cfg, "agy")).toBe(0);
    expect(compactionEnabledFor(cfg, "codex")).toBe(true);
    expect(compactionEnabledFor(cfg, "agy")).toBe(false); // window 0 → off
  });
});
