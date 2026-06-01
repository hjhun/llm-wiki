---
title: Raw Immutability
type: concept
tags: [design-constraint, provenance]
sources: [wiki/sources/articles/raw-immutability]
updated: 2026-05-30
---

## Definition
A design constraint under which the `raw/` directory is treated as read-only
by all agents. The generated wiki under `wiki/` is the only writable surface
where synthesis, summaries, and indexes live
([[wiki/sources/articles/raw-immutability]]).

## Why It Exists
Without this split, an LLM can silently "improve" source text, breaking
provenance and destroying evidence. With it, every claim in the wiki is
traceable to a stable source path, and contradictions between sources can be
surfaced as first-class artifacts rather than hidden by a "helpful" rewrite.

## Consequences
- Provenance is always recoverable: every wiki claim cites a `raw/` path.
- Contradictions surface explicitly via block-quoted warnings on affected
  wiki pages, both sources stay verbatim.
- The merge pass of [[wiki/concepts/leaf-first-merge-pass]] can safely
  re-read per-leaf summaries because the underlying raw files have not moved
  or changed.

## The One Sanctioned Mutation Path
`/preprocess` may quarantine noisy files into `raw/.trash/<ISO-ts>_<basename>`
or rewrite content after backing up the original to the trash. It runs as a
dry-run first; the user must explicitly invoke `/preprocess --apply` to
commit changes.
