# Ingest-Loop Context-Window Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a host CLI's measured context usage reaches a configurable ratio (default 0.9) of its token window, `runIngestLoop` performs a lossless "compaction" (session rotation for claude/codex, native `--compaction` for cline) so the next iteration starts from a smaller context.

**Architecture:** Four cooperating, independently-testable units — (A) per-CLI context-token measurement folded into the existing output parsers and surfaced on `RunResult.contextTokens`; (B) a `cli.ingestLoop.compaction` config block; (C) a pure `decideCompaction` decision function; (D) `runIngestLoop` wiring that, on over-threshold, drops the resume `sessionId` (claude/codex) or flags `--compaction` (cline). agy is excluded (no token telemetry, window 0).

**Tech Stack:** Next.js webapp, TypeScript, Node `child_process.spawn`, Vitest, zod config schema. All work under `webapp/`. Spec: `docs/superpowers/specs/2026-06-18-ingest-context-compaction-design.md`.

---

## File Structure

Files created or modified, by responsibility:

- `config/default.json` — add `cli.ingestLoop.compaction` defaults.
- `webapp/lib/config.ts` — zod schema for the `compaction` block.
- `webapp/lib/cli-stream-json.ts` — **claude** parser: retain terminal/last `usage`, expose `contextTokens()`.
- `webapp/lib/cli-codex-json.ts` — **codex** parser: retain `turn.completed.usage`, expose `contextTokens()`.
- `webapp/lib/cli-cline-task.ts` — **cline** parser: also parse the `-v` summary line, expose `contextTokens()`.
- `webapp/lib/ingest/compaction.ts` — **new**: pure `decideCompaction` + `compactionWindowFor` / `compactionEnabledFor` config helpers.
- `webapp/lib/cli.ts` — `RunResult.contextTokens`, `runCli` opt `compact`, measurement plumbing (force claude stream-json / codex resume `--json` / cline `-v`), and `--compaction` arg for cline.
- `webapp/lib/ingest/cli-retry.ts` — forward `compact` into the injected `runCli` call.
- `webapp/lib/ingest-loop.ts` — capture `contextTokens`, call `decideCompaction`, rotate session or flag compaction, log it.
- Test files alongside each unit (`*.test.ts`).

Branch: create `feat/ingest-context-compaction` off `main` before Task 1 (we are on `main`).

---

## Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/hjhun/samba/workspace/llm-wiki
git checkout -b feat/ingest-context-compaction
```

- [ ] **Step 2: Commit the already-written spec**

```bash
git add docs/superpowers/specs/2026-06-18-ingest-context-compaction-design.md docs/superpowers/plans/2026-06-18-ingest-context-compaction.md
git commit -m "docs: spec + plan for ingest context-window compaction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Compaction config block

**Files:**
- Modify: `config/default.json` (cli.ingestLoop)
- Modify: `webapp/lib/config.ts:327-379` (ingestLoop schema)
- Test: `webapp/lib/config.test.ts` (if present; else add a focused test file `webapp/lib/config-compaction.test.ts`)

- [ ] **Step 1: Write the failing test**

Check whether `webapp/lib/config.test.ts` exists (`ls webapp/lib/config*.test.ts`). If it does, add this case there; otherwise create `webapp/lib/config-compaction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./config";

describe("cli.ingestLoop.compaction config", () => {
  it("applies compaction defaults when omitted", () => {
    const cfg = ConfigSchema.parse({});
    const c = cfg.cli.ingestLoop.compaction;
    expect(c.enabled).toBe(true);
    expect(c.ratio).toBeCloseTo(0.9);
    expect(c.contextWindowTokens.claude).toBe(200000);
    expect(c.contextWindowTokens.codex).toBe(272000);
    expect(c.contextWindowTokens.cline).toBe(200000);
    expect(c.contextWindowTokens.agy).toBe(0);
  });

  it("rejects a ratio outside (0,1]", () => {
    expect(() =>
      ConfigSchema.parse({
        cli: { ingestLoop: { compaction: { ratio: 1.5 } } },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/config-compaction.test.ts`
Expected: FAIL — `compaction` is `undefined` (property access throws / assertions fail).

- [ ] **Step 3: Add the schema**

In `webapp/lib/config.ts`, inside the `ingestLoop` `z.object({ ... })` (after the `resumeSessions` field, before the closing `})`), add:

```ts
        /**
         * Context-window compaction. When a host CLI's measured context usage
         * (RunResult.contextTokens) reaches `ratio` of its
         * `contextWindowTokens[cli]`, the ingest loop compacts: claude/codex
         * drop the resume session id so the next iteration starts a fresh
         * session re-reading disk state; cline runs the next iteration with its
         * native `--compaction` flag. A window of 0 (e.g. agy, which has no
         * token telemetry) disables compaction for that CLI.
         */
        compaction: z
          .object({
            enabled: z.boolean().default(true),
            ratio: z.number().gt(0).lte(1).default(0.9),
            contextWindowTokens: z
              .object({
                claude: z.number().int().min(0).default(200000),
                codex: z.number().int().min(0).default(272000),
                cline: z.number().int().min(0).default(200000),
                agy: z.number().int().min(0).default(0),
              })
              .default({
                claude: 200000,
                codex: 272000,
                cline: 200000,
                agy: 0,
              }),
          })
          .default({
            enabled: true,
            ratio: 0.9,
            contextWindowTokens: {
              claude: 200000,
              codex: 272000,
              cline: 200000,
              agy: 0,
            },
          }),
```

Then add the same key to the `ingestLoop` `.default({ ... })` object (the one currently ending with `resumeSessions: true,`):

```ts
        resumeSessions: true,
        compaction: {
          enabled: true,
          ratio: 0.9,
          contextWindowTokens: {
            claude: 200000,
            codex: 272000,
            cline: 200000,
            agy: 0,
          },
        },
```

- [ ] **Step 4: Mirror the default in `config/default.json`**

Edit `config/default.json` so `cli.ingestLoop` includes `compaction` after `resumeSessions`:

```json
      "resumeSessions": true,
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

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/config-compaction.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add webapp/lib/config.ts webapp/lib/config-compaction.test.ts config/default.json
git commit -m "feat(config): add cli.ingestLoop.compaction window/ratio settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: claude context-token measurement

**Files:**
- Modify: `webapp/lib/cli-stream-json.ts`
- Test: `webapp/lib/cli-stream-json.test.ts`

Background: claude `--output-format stream-json` emits `assistant` message events with `message.usage` and a terminal `result` event with top-level `usage`. Usage shape: `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`. Context fullness = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`.

- [ ] **Step 1: Write the failing test**

Append to `webapp/lib/cli-stream-json.test.ts`:

```ts
import { createClaudeStreamParser } from "./cli-stream-json";

describe("claude stream-json contextTokens", () => {
  it("sums usage from the terminal result event", () => {
    const p = createClaudeStreamParser();
    p.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    );
    p.push(
      JSON.stringify({
        type: "result",
        result: "hi",
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 200,
        },
      }) + "\n",
    );
    expect(p.finalText()).toBe("hi");
    expect(p.contextTokens()).toBe(5250);
  });

  it("falls back to the last assistant message usage when no result usage", () => {
    const p = createClaudeStreamParser();
    p.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }) + "\n",
    );
    expect(p.contextTokens()).toBe(110);
  });

  it("returns null when no usage was seen", () => {
    const p = createClaudeStreamParser();
    p.push(JSON.stringify({ type: "result", result: "ok" }) + "\n");
    expect(p.contextTokens()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/cli-stream-json.test.ts`
Expected: FAIL — `p.contextTokens is not a function`.

- [ ] **Step 3: Implement usage capture**

In `webapp/lib/cli-stream-json.ts`:

Add a helper above `createClaudeStreamParser`:

```ts
function usageTokens(u: unknown): number | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  const total =
    n("input_tokens") +
    n("output_tokens") +
    n("cache_read_input_tokens") +
    n("cache_creation_input_tokens");
  return total > 0 ? total : null;
}
```

Extend the parser's public type:

```ts
export type StreamJsonParser = {
  push(chunk: string): string;
  finalText(): string;
  /** Total context tokens of the last/terminal usage, or null if unseen. */
  contextTokens(): number | null;
};
```

Inside `createClaudeStreamParser`, add `let context: number | null = null;` next to the other `let` declarations, and in `consumeLine`, after `JSON.parse` succeeds (use the already-parsed `obj`), capture usage. The simplest place: right after `const parsed = classifyLine(obj);`, add:

```ts
    const o = obj as Record<string, unknown>;
    if (o.type === "result") {
      const u = usageTokens(o.usage);
      if (u !== null) context = u;
    } else if (o.type === "assistant" && o.message && typeof o.message === "object") {
      const u = usageTokens((o.message as Record<string, unknown>).usage);
      if (u !== null) context = u;
    }
```

Then add to the returned object:

```ts
    contextTokens(): number | null {
      return context;
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/cli-stream-json.test.ts`
Expected: PASS (all existing tests in the file still pass too).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/cli-stream-json.ts webapp/lib/cli-stream-json.test.ts
git commit -m "feat(cli): parse claude usage into contextTokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: codex context-token measurement

**Files:**
- Modify: `webapp/lib/cli-codex-json.ts`
- Test: `webapp/lib/cli-codex-json.test.ts`

Background: `codex exec --json` emits `{"type":"turn.completed","usage":{"input_tokens":..,"cached_input_tokens":..,"output_tokens":..,"reasoning_output_tokens":..}}` (verified live 2026-06-18). Context fullness = `input_tokens + output_tokens` (`input_tokens` already counts the full prompt context; `cached_input_tokens` is a subset).

- [ ] **Step 1: Write the failing test**

Append to `webapp/lib/cli-codex-json.test.ts`:

```ts
import { createCodexJsonParser } from "./cli-codex-json";

describe("codex contextTokens", () => {
  it("sums input+output from the latest turn.completed usage", () => {
    const p = createCodexJsonParser();
    p.push(
      JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n",
    );
    p.push(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 17271,
          cached_input_tokens: 4992,
          output_tokens: 17,
          reasoning_output_tokens: 10,
        },
      }) + "\n",
    );
    expect(p.contextTokens()).toBe(17288);
  });

  it("returns null when no turn.completed seen", () => {
    const p = createCodexJsonParser();
    p.push(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n");
    expect(p.contextTokens()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/cli-codex-json.test.ts`
Expected: FAIL — `p.contextTokens is not a function`.

- [ ] **Step 3: Implement usage capture**

In `webapp/lib/cli-codex-json.ts`:

Extend the public type:

```ts
export type CodexJsonParser = {
  push(chunk: string): void;
  threadId(): string | null;
  text(): string;
  /** input+output tokens of the latest turn.completed, or null. */
  contextTokens(): number | null;
};
```

Inside `createCodexJsonParser`, add `let context: number | null = null;` next to `threadId`/`messages`. In `consumeLine`, add a branch (after the existing `item.completed` handling):

```ts
    if (o.type === "turn.completed" && o.usage && typeof o.usage === "object") {
      const u = o.usage as Record<string, unknown>;
      const inTok = typeof u.input_tokens === "number" ? u.input_tokens : 0;
      const outTok = typeof u.output_tokens === "number" ? u.output_tokens : 0;
      const total = inTok + outTok;
      if (total > 0) context = total;
      return;
    }
```

Add to the returned object:

```ts
    contextTokens(): number | null {
      return context;
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/cli-codex-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/cli-codex-json.ts webapp/lib/cli-codex-json.test.ts
git commit -m "feat(cli): parse codex turn.completed usage into contextTokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: cline context-token measurement

**Files:**
- Modify: `webapp/lib/cli-cline-task.ts`
- Test: `webapp/lib/cli-cline-task.test.ts`

Background: with `-v`, cline prints a final summary line shaped like `[12s | 3500 in, 420 out]` (per user spec). Context fullness = `in + out`. cline is not installed on this host, so this is coded to the documented format and verified by unit tests only.

- [ ] **Step 1: Write the failing test**

Append to `webapp/lib/cli-cline-task.test.ts`:

```ts
import { createClineTaskParser } from "./cli-cline-task";

describe("cline contextTokens from -v summary line", () => {
  it("parses `[Ns | IN in, OUT out]` into in+out", () => {
    const p = createClineTaskParser();
    p.push("Task started: abc123\n");
    p.push("...work...\n");
    p.push("[12s | 3500 in, 420 out]\n");
    expect(p.taskId()).toBe("abc123");
    expect(p.contextTokens()).toBe(3920);
  });

  it("parses the summary line even on a resume round with no Task banner", () => {
    const p = createClineTaskParser();
    p.push("[5s | 1000 in, 200 out]\n");
    expect(p.contextTokens()).toBe(1200);
  });

  it("returns null when no summary line is seen", () => {
    const p = createClineTaskParser();
    p.push("Task started: x\n");
    expect(p.contextTokens()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/cli-cline-task.test.ts`
Expected: FAIL — `p.contextTokens is not a function`.

- [ ] **Step 3: Implement summary-line parsing**

In `webapp/lib/cli-cline-task.ts`:

Add a module-level regex next to `TASK_RE`:

```ts
// cline -v final summary: `[<sec>s | <in> in, <out> out]` (whitespace-tolerant).
const VERBOSE_RE = /\[\s*\d+s\s*\|\s*(\d+)\s*in,\s*(\d+)\s*out\s*\]/;
```

Extend the public type:

```ts
export type ClineTaskParser = {
  push(chunk: string): void;
  taskId(): string | null;
  /** in+out tokens from the latest `-v` summary line, or null. */
  contextTokens(): number | null;
};
```

The current `push` early-returns once `taskId` is captured, which would skip the summary line (it comes later). Restructure so the summary line is always scanned. Replace the parser body with:

```ts
export function createClineTaskParser(): ClineTaskParser {
  let idBuffer = "";
  let verboseBuffer = "";
  let taskId: string | null = null;
  let context: number | null = null;

  return {
    push(chunk: string): void {
      const clean = chunk.replace(ANSI_RE, "");
      // Task-id sniff: stop buffering once captured.
      if (!taskId) {
        idBuffer += clean;
        const m = TASK_RE.exec(idBuffer);
        if (m) {
          taskId = m[1];
          idBuffer = "";
        } else if (idBuffer.length > 4096) {
          idBuffer = idBuffer.slice(-256);
        }
      }
      // Summary-line sniff: keep scanning to the end of the stream; keep the
      // latest match so a resume round's line wins.
      verboseBuffer += clean;
      const v = VERBOSE_RE.exec(verboseBuffer);
      if (v) {
        context = Number(v[1]) + Number(v[2]);
      }
      if (verboseBuffer.length > 8192) verboseBuffer = verboseBuffer.slice(-512);
    },
    taskId(): string | null {
      return taskId;
    },
    contextTokens(): number | null {
      return context;
    },
  };
}
```

(Keep the existing `ANSI_RE` and `TASK_RE` declarations.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/cli-cline-task.test.ts`
Expected: PASS (existing task-id tests still pass).

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/cli-cline-task.ts webapp/lib/cli-cline-task.test.ts
git commit -m "feat(cli): parse cline -v summary line into contextTokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `decideCompaction` pure module + config helpers

**Files:**
- Create: `webapp/lib/ingest/compaction.ts`
- Test: `webapp/lib/ingest/compaction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `webapp/lib/ingest/compaction.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/ingest/compaction.test.ts`
Expected: FAIL — module `./compaction` not found.

- [ ] **Step 3: Implement the module**

Create `webapp/lib/ingest/compaction.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/ingest/compaction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/ingest/compaction.ts webapp/lib/ingest/compaction.test.ts
git commit -m "feat(ingest): add pure decideCompaction + config helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Surface `contextTokens` on `RunResult` + measurement plumbing in `runCli`

**Files:**
- Modify: `webapp/lib/cli.ts` — `RunResult` type, `planSession`, `buildArgs`, `runCli` opts + parser creation + close handler.
- Test: `webapp/lib/cli-session.test.ts` (planSession arg tests) — extend; add `webapp/lib/cli-measure.test.ts` for the new pure pieces.

This task threads measurement end-to-end but does not yet trigger compaction (that is Task 8). All changes are gated so default behavior for non-loop callers is unchanged: measurement is enabled only when `cli.ingestLoop.compaction.enabled && window>0` for the CLI.

- [ ] **Step 1: Write failing tests for `planSession` codex-resume `--json`**

Append to `webapp/lib/cli-session.test.ts` (it imports `planSession`):

```ts
import { planSession } from "./cli";

describe("planSession codex resume with measurement", () => {
  it("adds --json + capture on codex resume when measuring", () => {
    const p = planSession("codex", { id: "t1", resume: true }, { measureContext: true });
    expect(p.args).toContain("--json");
    expect(p.capture).toBe(true);
    expect(p.resumeId).toBe("t1");
    expect(p.sessionId).toBe("t1");
  });
  it("keeps plain resume (no --json) when not measuring", () => {
    const p = planSession("codex", { id: "t1", resume: true });
    expect(p.args).not.toContain("--json");
    expect(p.capture).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/cli-session.test.ts`
Expected: FAIL — `planSession` takes 2 args / third param ignored, codex resume has no `--json`.

- [ ] **Step 3: Add a `measureContext` option to `planSession`**

In `webapp/lib/cli.ts`, change the `planSession` signature and the codex resume branch:

```ts
export function planSession(
  cli: CliName,
  session?: SessionOption,
  opts?: { measureContext?: boolean },
): SessionPlan {
```

In the `case "codex":` resume sub-branch (currently returns `{ ...noop, resumeId, sessionId }`), replace with:

```ts
      if (session.resume && session.id) {
        // Resume rounds normally run as plain text. When measuring context we
        // re-enable --json so the `turn.completed.usage` event is emitted; the
        // codex parser then both reduces JSONL to plain text and reads usage.
        if (opts?.measureContext) {
          return {
            ...noop,
            args: ["--json"],
            resumeId: session.id,
            sessionId: session.id,
            capture: true,
          };
        }
        return { ...noop, resumeId: session.id, sessionId: session.id };
      }
```

- [ ] **Step 4: Run the planSession test to verify it passes**

Run: `cd webapp && npx vitest run lib/cli-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Splice `sessionArgs` into the codex resume command**

In `buildArgs`, the codex `if (codexResumeId)` branch currently drops `sessionArgs`. Change it to include them so the `--json` flag reaches the resume invocation:

```ts
      if (codexResumeId) {
        // `codex exec resume [OPTIONS] <SESSION_ID> <PROMPT>`; options (incl.
        // --json when measuring) precede the positional id.
        return ["exec", "resume", ...skip, ...bypass, ...sessionArgs, codexResumeId, prompt];
      }
```

- [ ] **Step 6: Extend `buildArgs` for measurement (claude stream-json, cline -v) and `--compaction`**

Replace the `buildArgs` signature's `streamTokens: boolean` usage by adding two params. Update the signature:

```ts
function buildArgs(
  cli: CliName,
  prompt: string,
  safeMode: boolean,
  projectRoot: string,
  skipGitRepoCheck: boolean,
  streamTokens: boolean,
  sessionArgs: string[] = [],
  codexResumeId: string | null = null,
  measureContext: boolean = false,
  compact: boolean = false,
): string[] {
```

In the `case "claude":` branch, force stream-json when measuring (so the `result.usage` is emitted) even if `streamTokens` text-streaming is off:

```ts
    case "claude": {
      const useStream = streamTokens || measureContext;
      const stream = useStream
        ? [
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
          ]
        : [];
      return safeMode
        ? ["-p", prompt, ...sessionArgs, ...stream]
        : ["-p", prompt, "--dangerously-skip-permissions", ...sessionArgs, ...stream];
    }
```

In the `case "cline":` branch, add `-v` when measuring and `--compaction` when requested:

```ts
    case "cline": {
      const base = safeMode ? ["-p", prompt] : ["-y", "-p", prompt];
      const measure = measureContext ? ["-v"] : [];
      const comp = compact ? ["--compaction"] : [];
      return [...base, ...measure, ...comp, ...sessionArgs];
    }
```

- [ ] **Step 7: Add `contextTokens` to `RunResult` and `compact` to `runCli` opts**

In the `RunResult` type, add after `sessionId?: string | null;`:

```ts
  /** Measured host-CLI context usage in tokens, or null when unmeasured. */
  contextTokens?: number | null;
```

In the `runCli` opts object, add after the `session?: SessionOption;` field:

```ts
    /** Request the CLI's native history compaction this run (cline only). */
    compact?: boolean;
```

- [ ] **Step 8: Compute measurement gating and pass through in `runCli`**

In `runCli`, after `const cfg = await loadConfig();`, add:

```ts
  const measureContext = compactionEnabledFor(cfg, cli);
```

Add the import at the top of `cli.ts`:

```ts
import { compactionEnabledFor } from "./ingest/compaction";
```

Replace the existing `const streamTokens = ...` / `planSession` / `buildArgs` wiring:

```ts
  const streamTokens = (cfg.cli.streamTokens ?? false) && cli === "claude";
  const sessionPlan = planSession(cli, opts.session, { measureContext });
  const args = buildArgs(
    cli,
    prompt,
    opts.safeMode ?? false,
    projectRoot,
    opts.skipGitRepoCheck ?? false,
    streamTokens,
    sessionPlan.args,
    sessionPlan.resumeId,
    measureContext,
    opts.compact ?? false,
  );
```

- [ ] **Step 9: Create the parsers when measuring, and read `contextTokens` in the close handler**

The claude stream parser is currently created only when `streamTokens`. Create it whenever the run uses stream-json output:

```ts
    const useClaudeStream =
      cli === "claude" && (streamTokens || measureContext);
    const streamParser = useClaudeStream ? createClaudeStreamParser() : null;
```

(Use `streamParser` everywhere it was previously gated on `streamTokens`; the stdout handler already routes through `streamParser` when non-null, which now also covers the measure-only case — its plain-text reduction keeps `RunResult.stdout` correct.)

Create the codex parser whenever capture is set (capture is now true on measured resume rounds too — unchanged condition works):

```ts
    const codexParser =
      sessionPlan.capture && cli === "codex" ? createCodexJsonParser() : null;
```

Create the cline parser when capturing OR measuring (so resume rounds with `-v` are parsed):

```ts
    const clineParser =
      cli === "cline" && (sessionPlan.capture || measureContext)
        ? createClineTaskParser()
        : null;
```

In the stdout `data` handler, ensure cline output still passes through verbatim while the parser sniffs both id and summary line — the existing block already calls `clineParser.push(chunk)` then `stdoutBuf.push`/`onStdout`; no change needed beyond the broader creation condition.

In the `child.on("close")` resolve object, add `contextTokens`:

```ts
        sessionId: codexParser
          ? codexParser.threadId() ?? sessionPlan.sessionId
          : clineParser
            ? clineParser.taskId() ?? sessionPlan.sessionId
            : sessionPlan.sessionId,
        contextTokens:
          cli === "claude"
            ? streamParser?.contextTokens() ?? null
            : cli === "codex"
              ? codexParser?.contextTokens() ?? null
              : cli === "cline"
                ? clineParser?.contextTokens() ?? null
                : null,
```

- [ ] **Step 10: Typecheck and run the cli tests**

Run: `cd webapp && npm run typecheck && npx vitest run lib/cli-session.test.ts lib/cli-stream-json.test.ts lib/cli-codex-json.test.ts lib/cli-cline-task.test.ts`
Expected: PASS (typecheck clean; all CLI tests green).

- [ ] **Step 11: Commit**

```bash
git add webapp/lib/cli.ts webapp/lib/cli-session.test.ts
git commit -m "feat(cli): measure context tokens + thread compact flag through runCli

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Forward `compact` through the ingest-loop retry wrapper

**Files:**
- Modify: `webapp/lib/ingest/cli-retry.ts` (`CliRetryInput` + the `deps.runCli` call)
- Test: `webapp/lib/ingest/cli-retry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `webapp/lib/ingest/cli-retry.test.ts` (it already constructs a fake `runCli`; mirror that style):

```ts
it("forwards compact:true into runCli opts", async () => {
  let seen: { compact?: boolean } | null = null;
  const runCli = (async (_agent, _prompt, opts) => {
    seen = { compact: opts?.compact };
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      stdoutTruncated: null,
      stderrTruncated: null,
    };
  }) as unknown as typeof import("../cli").runCli;

  await runCliWithIngestLoopRetries(
    {
      agent: "cline",
      prompt: "p",
      cfg: baseCfg, // the test file's existing config fixture
      iteration: 2,
      sessionPath: "/tmp/s",
      compact: true,
    },
    {
      runCli,
      appendMessage: (async () => undefined) as never,
      stopFlagExists: async () => false,
      readIngestStateSummary: async () => null,
      errorMessage: (e) => String(e),
      delay: async () => undefined,
    },
  );
  expect(seen?.compact).toBe(true);
});
```

(If the existing test file names its config fixture differently than `baseCfg`, reuse that name. Import `runCliWithIngestLoopRetries` is already present in the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webapp && npx vitest run lib/ingest/cli-retry.test.ts`
Expected: FAIL — `compact` is not part of `CliRetryInput` (TS error) or `seen.compact` is `undefined`.

- [ ] **Step 3: Add `compact` to `CliRetryInput` and forward it**

In `webapp/lib/ingest/cli-retry.ts`, add to `CliRetryInput` (after `session?: SessionOption;`):

```ts
  /** Request the CLI's native history compaction this iteration (cline). */
  compact?: boolean;
```

In the `deps.runCli(input.agent, input.prompt, { ... })` opts, add after `session: input.session,`:

```ts
        compact: input.compact,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd webapp && npx vitest run lib/ingest/cli-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/lib/ingest/cli-retry.ts webapp/lib/ingest/cli-retry.test.ts
git commit -m "feat(ingest): forward compact flag through cli-retry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Trigger compaction in `runIngestLoop`

**Files:**
- Modify: `webapp/lib/ingest-loop.ts` — the loop body around session threading (the `if (canResume) sessionId = result.sessionId ?? sessionId;` line) and the `compact` flag passed into `runCliWithIngestLoopRetries`.
- Test: extend an existing ingest-loop test if one drives the loop with a fake CLI; otherwise rely on the unit-level coverage from Tasks 5–7 plus a typecheck/build. (The decision + plumbing are already unit-tested; this task is wiring.)

- [ ] **Step 1: Add imports**

At the top of `webapp/lib/ingest-loop.ts`, add to the existing `./cli` import group or near it:

```ts
import {
  decideCompaction,
  compactionWindowFor,
} from "./ingest/compaction";
```

- [ ] **Step 2: Track a pending cline compaction flag**

Near the other loop-scoped `let` declarations (e.g. next to `let sessionId: string | null = null;`), add:

```ts
  let pendingClineCompaction = false;
```

- [ ] **Step 3: Pass the flag into the iteration's CLI call**

In the `runCliWithIngestLoopRetries({ ... })` input object (where `session` is passed), add:

```ts
        compact: pendingClineCompaction,
```

- [ ] **Step 4: Reset the flag once consumed**

Immediately after the `runCliWithIngestLoopRetries` call returns (before handling `attempt.ok`), add:

```ts
    // The --compaction flag is single-shot: it applied to the call just made.
    pendingClineCompaction = false;
```

- [ ] **Step 5: Decide + act on the measured context after a successful iteration**

Find the existing line `if (canResume) sessionId = result.sessionId ?? sessionId;` and replace it with:

```ts
    if (canResume) sessionId = result.sessionId ?? sessionId;

    // Context-window compaction: when the host CLI's measured usage reaches the
    // configured ratio of its token window, compact before the next iteration.
    // claude/codex: drop the resume id so the next iteration starts a fresh
    // session that re-reads disk state (.state.json + source pages) = lossless.
    // cline: keep the task but request its native --compaction next iteration.
    const compaction = decideCompaction({
      contextTokens: result.contextTokens ?? null,
      windowTokens: compactionWindowFor(cfg, agent),
      ratio: cfg.cli.ingestLoop.compaction.ratio,
      enabled: cfg.cli.ingestLoop.compaction.enabled,
    });
    if (compaction.compact) {
      const used = compaction.usedTokens ?? 0;
      const note =
        agent === "cline"
          ? `[compaction] 컨텍스트 ${used}/${compaction.limitTokens} 토큰 도달 → 다음 라운드 --compaction`
          : `[compaction] 컨텍스트 ${used}/${compaction.limitTokens} 토큰 도달 → 새 세션으로 리셋`;
      onChunk?.(`\n${note}\n`);
      await appendMessage(sessionPath, "system", note).catch(() => undefined);
      if (agent === "cline") {
        pendingClineCompaction = true;
      } else {
        sessionId = null;
      }
    }
```

- [ ] **Step 6: Typecheck**

Run: `cd webapp && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `cd webapp && npx vitest run`
Expected: PASS (all existing tests + the new ones).

- [ ] **Step 8: Build**

Run: `cd webapp && npm run build`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add webapp/lib/ingest-loop.ts
git commit -m "feat(ingest): compact host-CLI context at the configured threshold

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Manual live smoke (claude / codex)

**Files:** none (verification only).

Both claude and codex are installed; cline and agy are not (cline excluded, agy has no telemetry).

- [ ] **Step 1: Sanity-check claude usage emission**

Run a trivial measured-style invocation to confirm `result.usage` is present in stream-json:

```bash
claude -p "Say only OK" --output-format stream-json --verbose --include-partial-messages 2>&1 | grep -o '"usage":[^}]*}' | tail -1
```
Expected: a `"usage":{...}` object with `input_tokens` / `output_tokens`.

- [ ] **Step 2: Sanity-check codex usage emission**

```bash
cd /tmp && rm -rf cxprobe && mkdir cxprobe && cd cxprobe && git init -q
codex exec --json --skip-git-repo-check -s read-only "Say only OK" 2>&1 | grep '"turn.completed"'
```
Expected: a `turn.completed` line containing `"usage":{"input_tokens":...,"output_tokens":...}`.

- [ ] **Step 3: Record findings**

Note the observed usage shapes in the PR description / commit body if they differ from the parser assumptions (Tasks 2–3). If a field name differs, fix the corresponding parser and its test before finishing.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Unit A (measurement) → Tasks 2 (claude), 3 (codex), 4 (cline), 6 (RunResult + gating). ✓
- Unit B (config) → Task 1. ✓
- Unit C (decideCompaction) → Task 5. ✓
- Unit D (loop wiring) → Tasks 7 (retry forward) + 8 (trigger). ✓
- claude output-mode forcing → Task 6 Step 6/9. ✓
- codex resume `--json` → Task 6 Steps 3/5. ✓
- agy excluded (window 0) → enforced by `compactionEnabledFor` (Task 5) and config default (Task 1). ✓
- Error/edge cases (null usage never compacts, window 0 disables) → Task 5 tests. ✓

**Type consistency:** `contextTokens()` parser method name used identically across Tasks 2/3/4/6. `decideCompaction` input/output shape consistent between Task 5 (def) and Task 8 (use). `compact` opt name consistent across Tasks 6/7/8. `measureContext` param consistent across Tasks 6 planSession/buildArgs. `compactionWindowFor`/`compactionEnabledFor` consistent Tasks 5/6/8.

**Placeholders:** none — every code step shows full code.

**Note for executor:** the existing fixture/import names in `cli-session.test.ts` and `cli-retry.test.ts` may differ slightly; reuse whatever config fixture and imports those files already define rather than introducing new ones.
