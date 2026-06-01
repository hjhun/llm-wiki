---
title: Throttle Module (code + diagram)
type: source
source_kind: code
raw_path: raw/code/throttle/
language: ts
topics: [rate-limiting, code-wiki]
concepts: [Sliding-Window Rate Limit]
projects: [throttle-demo]
status: summarized
sources: [raw/code/throttle/throttle.ts, raw/code/throttle/sliding-window.svg]
updated: 2026-06-01
source_date: 2026-06-01
tags: [code, image]
---

## Gist
A mixed leaf: one TypeScript module that implements a per-key sliding-window
rate limiter, plus an SVG diagram of the window. This page shows the Code Wiki
+ `wiki-images` output shape — code is summarized from evidence, and the image
is read **text-first then described**, not embedded as a binary.

## Code Summary
`raw/code/throttle/throttle.ts` exposes `consume(key, now?)` and `reset(key)`:

- **`consume`** returns `{ allowed: true }` or
  `{ allowed: false, retryAfterMs }`. On each call it drops timestamps older
  than `WINDOW_MS` (60s) from the key's bucket, then allows the call only if
  fewer than `MAX_PER_WINDOW` (5) remain.
- **Memory bound**: a bucket never holds more than `MAX_PER_WINDOW` timestamps,
  so storage per key is constant.
- **Testability**: `now` is an injectable parameter, so the window can be
  exercised without real timers.

## Images
Per [wiki-images](../../../../../../.agents/skills/wiki-images/SKILL.md), the
diagram is recorded as a caption + alt-text, citing the raw path rather than
copying the binary.

- `raw/code/throttle/sliding-window.svg` — **Caption**: a 60-second window on a
  time axis holding five accepted call markers; a sixth call arriving while the
  window is full is rejected until the oldest timestamp ages out.
  **Alt-text**: "window = 60s" box over a time axis from `t - 60s` to `now`,
  five green dots inside, one red dot labelled "6th: rejected".
  The diagram illustrates the `bucket.length >= MAX_PER_WINDOW` branch in
  `throttle.ts`.

## Wiki Connections
- Concept: [[wiki/concepts/sliding-window-rate-limit]]
- The diagram and code describe the same mechanism from two angles
  (visual window vs. the `consume` implementation).

## Provenance
- Source: `raw/code/throttle/` (synthetic example, 2026-06-01) — one `.ts`
  module and one `.svg` diagram.
