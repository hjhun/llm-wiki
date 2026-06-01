---
title: Raw Immutability as a Design Constraint
type: source
source_kind: article
source_date: 2026-05-18
raw_path: raw/articles/raw-immutability.md
language: en
topics: [llm-wiki, provenance]
concepts: [Raw Immutability, Preprocess Trash Path]
status: summarized
sources: [raw/articles/raw-immutability.md]
updated: 2026-05-30
ingested_at: 2026-05-30T10:18:00
tags: [provenance, design-constraint]
---

## Gist
CLIO enforces a strict ownership split between immutable `raw/` source
material and the LLM-maintained `wiki/`. The only sanctioned mutation path is
`/preprocess`, which quarantines noisy files into `raw/.trash/`.

## Key Points
- **Ownership split is the core invariant**: `raw/` is read-only to agents;
  `wiki/` is freely maintained by the LLM.
- **Three consequences**: provenance traceability, no silent corruption of
  source text, contradictions become first-class artifacts.
- **`/preprocess` is the only sanctioned mutation path**: dry-run plan first,
  then explicit `--apply`; moved files are timestamped under `raw/.trash/`
  and remain recoverable.

## Quotes
> "Contradictions become first-class: when two sources disagree, both stay
> verbatim under `raw/` and the wiki page records the conflict with a block
> quote."

## Wiki Connections
- Concept: [[wiki/concepts/raw-immutability]]
- Related: [[wiki/sources/articles/leaf-first-merge]] (the leaf-first pattern
  relies on raw immutability so per-leaf summaries remain a faithful
  representation of source content across re-runs)

## Provenance
- Source: `raw/articles/raw-immutability.md` (synthetic example, 2026-05-18)
