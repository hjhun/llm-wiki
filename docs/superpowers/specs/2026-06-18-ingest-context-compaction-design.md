# Ingest-Loop Context-Window Compaction — Design

> Status: approved (2026-06-18). Next step: writing-plans → implementation.

## Problem

`runIngestLoop` keeps one warm CLI conversation across iterations
(`cli.ingestLoop.resumeSessions=true`, `chunking.unitPerCall=session_batch`).
The resumed conversation history grows monotonically across sub-chunks **and**
across iterations, because the backend threads the same `sessionId` forward
(`ingest-loop.ts` resume branch) even when the agent intends to exit for a
"cleaner fresh session". There is no backend-side measurement of context size
and no hard guard, so a long ingest (especially Code Wiki with many sub-chunks)
can drive the host CLI toward its model context-window limit. The current
mitigations are only: leaf-first chunk byte/file caps, `maxIterations`, and an
in-prompt "exit when context grows large" instruction the agent may ignore.

Note on units: the existing `chunking.maxBytes` (262144 = 256KB) is an **input
byte cap per chunk**, not a model token window. This feature targets the host
CLI's **token** context window (claude ≈ 200K, codex model-dependent, etc.).

## Goal

When a CLI's measured context usage reaches a configurable ratio (default 0.9)
of its configured token window, the backend performs a "compaction" so the next
iteration starts from a smaller context, without losing work (all durable state
lives on disk: `progress/ingest/.state.json` + `wiki/sources/*` pages).

## Approved Decisions

1. **Compaction mechanism**: session rotation for claude/codex (drop the resume
   `sessionId` → next iteration is a fresh session that re-reads disk state =
   lossless compaction). cline uses its native `--compaction` flag. The CLI's
   own internal auto-compaction remains a backstop.
2. **Window limits**: per-CLI `contextWindowTokens` config with model-appropriate
   defaults, plus a single `ratio` (default 0.9).
3. **agy**: best-effort, excluded from measurement (no token telemetry, no warm
   resume — already fresh per round, so little accumulation). `window=0` disables.

## Architecture

Four cooperating units, each independently testable:

### Unit A — Per-CLI context-token measurement

Add `contextTokens?: number | null` to `RunResult` (`webapp/lib/cli.ts`).
Populated by extending the existing per-CLI output parsers. `null` means
"unmeasured / unsupported" and never triggers compaction.

- **claude** (`webapp/lib/cli-stream-json.ts`): the stream-json `assistant`
  message events and the terminal `result` event carry a `usage` object
  (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
  `output_tokens`). Extend the parser to retain the latest/terminal `usage` and
  expose `contextTokens = input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens + output_tokens`. Measuring requires the run to be
  in stream-json mode (see "claude output mode" below).
- **codex** (`webapp/lib/cli-codex-json.ts`): `--json` emits a
  `turn.completed` event with `usage: { input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens }` (verified live, 2026-06-18). Extend
  the parser to retain the latest `turn.completed.usage` and expose
  `contextTokens = input_tokens + output_tokens` (`input_tokens` already counts
  the full prompt context sent; `cached_input_tokens` is a subset of it). Resume
  rounds must also run with `--json` to keep measuring (see plumbing).
- **cline** (`webapp/lib/cli-cline-task.ts`): with `-v`, cline prints a final
  line of the shape `[<sec>s | <in> in, <out> out]`. Extend the task parser to
  also match this line and expose `contextTokens = in + out`. (cline is not
  installed on this host; code to the documented format + unit tests.)
- **agy**: no parser change; `contextTokens` stays `null`.

### Unit B — Compaction config

`config/default.json` + `webapp/lib/config.ts` zod schema, under
`cli.ingestLoop`:

```jsonc
"compaction": {
  "enabled": true,
  "ratio": 0.9,
  "contextWindowTokens": {
    "claude": 200000,
    "codex": 272000,
    "cline": 200000,
    "agy": 0
  }
}
```

`agy: 0` (or any `0`/missing) disables compaction for that CLI. `ratio` is
clamped to `(0, 1]`. Unknown keys tolerated/stripped like other config.

### Unit C — Compaction decision (pure)

`decideCompaction({ contextTokens, windowTokens, ratio, enabled })
  : { compact: boolean; usedTokens: number | null; limitTokens: number }`
in a small module (e.g. `webapp/lib/ingest/compaction.ts`). Returns
`compact=true` only when `enabled && contextTokens != null && windowTokens > 0
&& contextTokens >= windowTokens * ratio`. Pure and unit-tested.

### Unit D — Loop wiring

In `runIngestLoop` (`webapp/lib/ingest-loop.ts`), after each successful
iteration captures `result.contextTokens`, call `decideCompaction`. When
`compact`:

- **cline**: set a `pendingCompaction` flag so the next iteration's run carries
  `--compaction` (keep the resumed task id; cline compacts its own history).
- **claude / codex**: set `sessionId = null` so the next iteration's `resuming`
  guard is false → it starts a fresh session with the full continuation prompt
  = compaction via disk state.
- Emit one `onChunk` banner and one `appendMessage` system line:
  `[compaction] 컨텍스트 <used>/<limit> 토큰 (≥<ratio>) → <세션 리셋|--compaction>`.

Plumbing:
- `cli.ts` run options gain `compact?: boolean`; the cline branch of arg
  construction appends `--compaction` and always appends `-v` when compaction
  measurement is enabled for cline.
- `planSession` codex resume branch adds `--json` + `capture` so resume rounds
  still emit `turn.completed.usage` (parser already tolerates the known id).
- claude output mode: when `compaction.enabled` and agent is claude, force the
  stream-json output path (reuse the existing `streamTokens` machinery) so
  `usage` is available regardless of the `streamTokens` text-streaming setting.
  `RunResult.stdout` stays plain text (parser reduces it), so no UX change.
- `runCliWithIngestLoopRetries` forwards `compact` and the `SessionOption`
  unchanged (it already forwards `session`).

## Data Flow

```
iteration N: runCli(agent, prompt, session, compact?) 
   └─ parser captures usage → RunResult.contextTokens
        └─ decideCompaction(contextTokens, window[agent], ratio)
             ├─ compact=false → thread sessionId forward as today
             └─ compact=true:
                  cline   → pendingCompaction=true (next run gets --compaction)
                  claude  → sessionId=null (next run = fresh session)
                  codex   → sessionId=null (next run = fresh session)
iteration N+1: starts smaller; disk state (.state.json + sources) drives resume
```

## Error Handling / Edge Cases

- Missing/unparseable usage → `contextTokens=null` → never compacts (safe).
- `window=0` or `enabled=false` → feature off for that CLI.
- codex capture miss on resume (no `turn.completed`) → `contextTokens` stays
  from last known or null; no spurious compaction.
- A compaction that drops `sessionId` does not lose progress because the next
  iteration re-reads `.state.json`; `idleRounds`/stagnation logic is unaffected
  (progress is measured from disk snapshots, not session continuity).
- cline `--compaction` is additive; if cline rejects it on an old version the
  run still proceeds (best-effort; logged).

## Testing

- Unit: `cli-stream-json` usage extraction; `cli-codex-json`
  `turn.completed.usage` extraction; `cli-cline-task` `-v` summary-line parse;
  `decideCompaction` truth table (null, below, at, above threshold; disabled;
  window=0).
- Loop-level: claude over-threshold drops `sessionId`; cline over-threshold sets
  the `--compaction` arg next round; codex resume round still requests `--json`;
  agy never compacts. Extend existing `ingest-loop` / `loop-decision` tests.
- Full suite + typecheck + build must stay green.

## Out of Scope

- Changing the default worker CLI, chunk caps, or `maxIterations`.
- Any native interactive `/compact` injection into `claude -p` / `codex exec`
  (not available; session rotation replaces it).
- Token measurement for agy.
- Touching `raw/` or `wiki/` content.
