---
title: Sliding-Window Rate Limit
type: concept
tags: [pattern, rate-limiting, code-wiki]
sources: [wiki/sources/code/throttle/index]
updated: 2026-06-01
---

## Definition
A rate-limiting strategy that admits at most *N* events per rolling time
window. Each key keeps the timestamps of recent admitted events; a new event
is admitted only if fewer than *N* timestamps fall within the last *W*
milliseconds. Unlike a fixed-window counter, the window slides continuously, so
there is no burst-at-the-boundary artifact.

## How It Works
On each call, timestamps older than the window are discarded, then the
remaining count is compared against the limit
([[wiki/sources/code/throttle/index]]). If the bucket is full, the caller is
told how long until the oldest timestamp ages out (`retryAfterMs`).

## Properties
- **Constant memory per key** — a bucket never exceeds the limit *N*.
- **No boundary burst** — because the window slides, a client cannot send
  `2N` events across a fixed-window edge.
- **Deterministic + testable** — passing the clock in as a parameter makes the
  window behavior unit-testable without timers.

## Evidence
- Code: `raw/code/throttle/throttle.ts` (`consume` / `reset`).
- Diagram: `raw/code/throttle/sliding-window.svg` — the full-window rejection
  case, summarized in [[wiki/sources/code/throttle/index]].
