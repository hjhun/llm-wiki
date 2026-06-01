# Why the Leaf-First Merge Pass Matters

Author: synthetic example, 2026-05-12

Most naive LLM ingest pipelines try to summarize an entire corpus in a single
pass. They hit two walls almost immediately. First, the corpus does not fit in
the context window. Second, even when it does, the model spends most of its
attention budget on bookkeeping — figuring out which paragraph belongs to which
section — instead of producing useful synthesis.

The *leaf-first merge pass* pattern solves both. It splits the input tree into
**leaf directories** (and direct-file pseudo-leaves), processes each leaf in a
small, bounded sub-chunk, and persists per-leaf summaries to disk before the
model ever sees the next leaf. The merge pass is a separate step that integrates
finished leaf summaries into parent pages and indexes.

The crucial property is **resumability**. Because each leaf is processed in
isolation and its result is persisted before the next leaf starts, an
interrupted run can pick up at the next pending leaf. Long ingest jobs become
checkpointed work, not all-or-nothing dice rolls.

A subtle benefit shows up under parallelism. Two workers can claim disjoint
leaf scopes and process them independently without coordinating on shared
context. The merge pass acts as the only place where their results need to
agree — and that pass touches parent pages, not raw sources.
