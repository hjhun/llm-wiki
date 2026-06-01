# Operation Log

This is an append-only log. Older entries are never edited; corrections are
appended as new entries.

## [2026-05-30 10:14] ingest | raw/articles/leaf-first-merge.md | sub-chunk 1
- Changed files: `wiki/sources/articles/leaf-first-merge.md`,
  `wiki/concepts/leaf-first-merge-pass.md`
- Notes: 1/1 files in leaf; single-file leaf processed in one sub-chunk.

## [2026-05-30 10:18] ingest | raw/articles/raw-immutability.md | sub-chunk 1
- Changed files: `wiki/sources/articles/raw-immutability.md`,
  `wiki/concepts/raw-immutability.md`
- Notes: 1/1 files in leaf; cross-linked with leaf-first-merge-pass concept.

## [2026-05-30 10:22] ingest | merge pass | raw/articles/
- Integrated pages: `wiki/concepts/leaf-first-merge-pass.md`,
  `wiki/concepts/raw-immutability.md`
- Notes: merge_pass.pending_parents drained for `raw/articles/`; reordered
  `wiki/index.md` Concepts and Sources categories.

## [2026-05-30 10:22] ingest | sources index regen
- Changed files: `wiki/sources/index.md`
- Notes: ran `node scripts/build-sources-index.mjs`; 2 sources catalogued.

## [2026-06-01 14:00] ingest | raw/code/throttle/ | sub-chunk 1
- Changed files: `wiki/sources/code/throttle/index.md`,
  `wiki/concepts/sliding-window-rate-limit.md`
- Notes: mixed code+image leaf (1 `.ts` + 1 `.svg`); image read text-first
  and recorded as caption/alt-text per the wiki-images skill, raw bytes left
  immutable.

## [2026-06-01 14:02] ingest | merge pass | raw/code/
- Integrated pages: `wiki/concepts/sliding-window-rate-limit.md`
- Notes: added Code category to `wiki/index.md`; cross-linked the throttle
  source page to its concept.

## [2026-06-01 14:02] ingest | sources index regen
- Changed files: `wiki/sources/index.md`
- Notes: ran `node scripts/build-sources-index.mjs`; 3 sources catalogued.
