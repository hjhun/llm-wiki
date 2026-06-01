---
title: Why the Leaf-First Merge Pass Matters
type: source
source_kind: article
source_date: 2026-05-12
raw_path: raw/articles/leaf-first-merge.md
language: en
topics: [llm-wiki, ingest-pipeline]
concepts: [Leaf-First Merge Pass, Resumability]
status: summarized
sources: [raw/articles/leaf-first-merge.md]
updated: 2026-05-30
ingested_at: 2026-05-30T10:14:00
tags: [ingest, pattern]
---

## Gist
Naive single-pass LLM ingest fails both on context limits and on attention
budget. Splitting input into leaf directories with bounded sub-chunks and a
separate merge pass restores resumability and enables disjoint parallel
workers.

## Key Points
- **Two failure modes of single-pass ingest**: corpus exceeds context window;
  even when it fits, the model wastes attention on cross-referencing.
- **Leaf as the unit of work**: a leaf directory (or direct-file pseudo-leaf)
  is processed in one bounded sub-chunk and the result is persisted before the
  next leaf is opened.
- **Resumability is the load-bearing property**: per-leaf persistence turns
  long runs into checkpointed work; interrupted jobs continue from the next
  pending leaf.
- **Merge pass is a separate step**: integrates per-leaf summaries into
  parent pages and indexes; never re-reads raw sources.
- **Disjoint parallelism**: multiple workers can claim non-overlapping leaf
  scopes; the merge pass is the only synchronization point.

## Quotes
> "An interrupted run can pick up at the next pending leaf. Long ingest jobs
> become checkpointed work, not all-or-nothing dice rolls."

## Wiki Connections
- Concept: [[wiki/concepts/leaf-first-merge-pass]]
- Related: [[wiki/sources/articles/raw-immutability]] (paired design
  constraint — raw immutability lets a merge pass safely re-read summaries
  instead of original files)

## Provenance
- Source: `raw/articles/leaf-first-merge.md` (synthetic example, 2026-05-12)
