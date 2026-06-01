---
title: Leaf-First Merge Pass
type: concept
tags: [pattern, ingest]
sources: [wiki/sources/articles/leaf-first-merge]
updated: 2026-05-30
---

## Definition
A two-phase ingest pattern that processes input trees by their leaf
directories first (and direct-file pseudo-leaves), persists per-leaf
summaries, and only later runs a *merge pass* that integrates those summaries
into parent pages and indexes. Designed for LLM pipelines bounded by a context
window.

## Why It Exists
A single-pass summary of a large tree fails both ways: the corpus may exceed
the context window, and even when it fits, model attention is wasted on
cross-referencing rather than synthesis ([[wiki/sources/articles/leaf-first-merge]]).

## Properties
- **Resumability** — every per-leaf result is persisted before the next leaf
  is opened, so an interrupted run continues from the next pending leaf.
- **Bounded sub-chunks** — each leaf is processed in one bounded sub-chunk
  whose file count and byte total are capped by configuration
  (`chunking.maxFilesPerInvocation`, `chunking.maxBytes`).
- **Separate merge phase** — parent pages, source catalogs, and indexes are
  rebuilt by a dedicated pass that reads per-leaf summaries, not raw
  files. This keeps the synthesis layer cheap and idempotent.
- **Disjoint parallelism** — multiple workers can be assigned non-overlapping
  leaf scopes; the merge pass is the only synchronization point.

## Related
- Paired with [[wiki/concepts/raw-immutability]]: the merge pass can re-read
  per-leaf summaries instead of original files precisely because those
  originals will not have changed underneath it.
