---
name: wiki-images
description: During ingest, handle image, scan, screenshot, and image-heavy PDF sources — read accompanying text first, then the images for supplemental context, and record a source page with captions/alt-text. Original bytes in raw/ stay immutable.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-images

## LLM Wiki Pattern Reference

This skill implements the image workaround from Karpathy's
[`llm-wiki.md`](../../../llm-wiki.md): for sources that carry images, read the
text first and then open the images separately for supplemental context, rather
than trying to consume a multimodal blob in one pass. It is an **optional
helper used inside [`/ingest`](../wiki-ingest/SKILL.md)** — there is no separate
user-facing command.

## Purpose

When an ingest leaf contains visual material — `.png`/`.jpg`/`.webp`/`.gif`
images, scanned or screenshot PDFs, diagrams, or photos — produce the same
`wiki/sources/<raw-relative-path>.md` evidence card the prose path produces,
enriched with what the image actually shows: a caption, visible text (alt-text
/ light OCR), and how the image relates to the source's text.

The `raw/` original is **immutable evidence**. This skill only reads it (or a
user-approved symlink under `raw/`) and writes under `wiki/`.

## When It Applies

Inside the wiki-ingest leaf loop, route a file here when:

- its extension is an image type (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`,
  `.bmp`, `.tiff`, `.svg`), or
- it is a PDF whose pages are scans/screenshots with little extractable text, or
- a Markdown/HTML source embeds local images that carry meaning the text alone
  does not.

Pure-text sources stay on the normal wiki-ingest path.

## Read Order (text-first)

1. Read all accompanying text in the leaf first (the article body, PDF text
   layer, captions, surrounding Markdown). Build the textual summary as usual.
2. Then open each image **separately** for supplemental context. Treat images
   as evidence that augments the text, not as the primary channel.
3. Tie each image back to the claim or section it supports.

## Host Vision Capability

The host coding-agent CLI may or may not be able to view images.

- **Vision available** (the CLI can read the image, e.g. via the Read tool):
  describe what is visible, transcribe legible text, and note diagram structure.
  Set `status: summarized`.
- **Vision unavailable**: do **not** invent content. Record metadata only —
  filename, `raw_path`, file type, any caption/alt-text/filename hints, and the
  surrounding textual context — and set `status: needs_review` so a later pass
  (or a vision-capable CLI) can complete it. Note the limitation in the page
  body.

Never guess at text or content you cannot actually see in the image.

## Output

A source page mirroring the raw path, e.g. `raw/papers/scan.pdf` ->
`wiki/sources/papers/scan.md`, `raw/shots/ui.png` ->
`wiki/sources/shots/ui.md`. Group multiple images of one logical source under
`wiki/sources/<raw-relative-dir>/index.md`.

Frontmatter (see CLAUDE.md §4.2):

```yaml
---
title: <page title>
type: source
source_kind: image            # or paper/web_capture when the image is embedded
raw_path: raw/<logical-source-path>
tags: [image, ...]
topics: [...]
entities: [...]
concepts: [...]
status: summarized | needs_review
updated: YYYY-MM-DD
source_date: YYYY-MM           # when knowable
---
```

Body sections:

1. **요약** — the text-first summary of the source.
2. **이미지** — one entry per image: a caption, transcribed/visible text
   (alt-text), and the claim/section it supports. Reference the original by its
   `raw/...` path; do not copy the binary into `wiki/`.
3. **연결** — wikilinks to the entity/concept pages the visuals support.

## Merge Pass and Graph

- Fold image-derived entities/concepts into parent and synthesis pages during
  the normal wiki-ingest merge pass; refresh `wiki/sources/index.md`.
- After ingest progress completes, the separate
  [`wiki-graphify`](../wiki-graphify/SKILL.md) update bridges image source nodes
  to the concepts/entities they illustrate, like any other source page.

## Prohibited

- Do not modify, move, or copy the original under `raw/`.
- Do not fabricate text or content not actually visible in an image; when in
  doubt mark `status: needs_review`.
- Do not embed large binaries or base64 image data into `wiki/` pages; cite the
  `raw/...` path instead.
- Do not leave credentials or personal data visible in a screenshot unmasked in
  the summary — mask and report under `wiki/lint/` per CLAUDE.md §9.

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — the parent loop that delegates image
  leaves here and owns chunking, state, and the merge pass.
- [wiki-graphify](../wiki-graphify/SKILL.md) — bridges image source pages into
  the graph after the merge pass.
- [browser-capture](../browser-capture/SKILL.md) — produces screenshot/web
  captures under `raw/` that this skill later turns into source pages.
