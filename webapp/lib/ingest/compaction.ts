import type { Config } from "../config";
import type { CliName } from "../cli";

export type CompactionDecisionInput = {
  contextTokens: number | null;
  windowTokens: number;
  ratio: number;
  enabled: boolean;
};

export type CompactionDecision = {
  compact: boolean;
  usedTokens: number | null;
  limitTokens: number;
};

/**
 * Pure threshold check. Compacts only when measurement is enabled, a window is
 * configured, and the measured context reached `windowTokens * ratio`.
 */
export function decideCompaction(
  input: CompactionDecisionInput,
): CompactionDecision {
  const limitTokens = Math.floor(input.windowTokens * input.ratio);
  const compact =
    input.enabled &&
    input.windowTokens > 0 &&
    input.contextTokens != null &&
    input.contextTokens >= limitTokens;
  return { compact, usedTokens: input.contextTokens, limitTokens };
}

/** Configured token window for a CLI (0 = compaction disabled for it). */
export function compactionWindowFor(cfg: Config, cli: CliName): number {
  const w = cfg.cli.ingestLoop.compaction.contextWindowTokens;
  return (w as Record<string, number>)[cli] ?? 0;
}

/** True when compaction is enabled AND a positive window exists for the CLI. */
export function compactionEnabledFor(cfg: Config, cli: CliName): boolean {
  return (
    cfg.cli.ingestLoop.compaction.enabled && compactionWindowFor(cfg, cli) > 0
  );
}
