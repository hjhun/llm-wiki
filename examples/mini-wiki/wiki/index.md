---
title: Wiki Index (Mini Example)
type: index
tags: [index]
updated: 2026-05-30
---

# Wiki Index

This is the deterministic catalog of pages in the mini-wiki example. See
[wiki/sources/index.md](sources/index.md) for the source-page catalog generated
by `scripts/build-sources-index.mjs`.

## Concepts
- [[wiki/concepts/leaf-first-merge-pass]] — Two-phase ingest pattern that
  processes leaf directories first and integrates results in a separate
  merge pass.
- [[wiki/concepts/raw-immutability]] — Design constraint that keeps `raw/`
  read-only so the wiki layer can synthesize freely without destroying
  evidence.

## Sources
- [[wiki/sources/articles/leaf-first-merge]] — *Why the Leaf-First Merge
  Pass Matters* (synthetic article, 2026-05-12).
- [[wiki/sources/articles/raw-immutability]] — *Raw Immutability as a
  Design Constraint* (synthetic article, 2026-05-18).

## Logs
- [Operation Log](log.md) — Append-only `ingest`/`merge`/`graph` entries.
