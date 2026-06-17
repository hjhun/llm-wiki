---
name: browser-capture
description: Capture website or webapp evidence into CLIO raw/chat for later wiki/code ingest, and store automation QA run records under progress/automation/artifacts. Use when the user asks to open a website, scrape a page, take screenshots, test the CLIO web UI, QA a webapp, or collect browser/search findings as source material.
allowed-cli: [codex, claude, gemini, cline]
---

# browser-capture

## LLM Wiki Pattern Reference

This skill feeds the raw-source layer described by
[`llm-wiki.md`](../../../llm-wiki.md). Browser captures are source candidates,
not finished synthesis: save source evidence under `raw/chat/`, then let
`/ingest` integrate it into the persistent wiki. Automation QA run records and
per-agent logs belong under `progress/automation/artifacts/`.

## Purpose

Use browser automation as a source-capture step for the LLM Wiki and Code Wiki.
The captured source artifact belongs in `raw/chat/<YYYY-MM-DD>/`, then
`/ingest` turns it into wiki pages. Autonomous tab progress belongs under
`progress/automation/artifacts/<slug>/`.

This skill adapts the global `agent-browser` workflow to CLIO's path rules.

## Execution Path

1. Prefer `agent-browser` from `PATH`.
2. If missing, tell the user to run `./setup.sh --with-agent-browser` or install
   it globally.
3. Load current instructions from the tool before use:

```bash
agent-browser skills get core
```

Use specialized `agent-browser` skills only when needed, such as `dogfood` for
QA or `electron` for desktop apps.

## Capture Rules

- Ask the user before logging into private sites or collecting account data.
- Save only source candidates the user wants to keep.
- Do not rewrite or delete existing `raw/chat/` captures.
- For web evidence, include:
  - URL
  - access date/time
  - short description of what was captured
  - extracted text or concise notes
  - screenshot path if screenshots are saved
- For CLIO UI QA, capture the route, viewport, steps, result, and any console
  errors.

## Output Layout

Preferred manual capture:

```text
raw/chat/YYYY-MM-DD/<slug>.md
raw/chat/YYYY-MM-DD/<slug>-screenshot.png
```

Preferred automation capture:

```text
progress/automation/artifacts/<job-slug>/
  capture.md
  screenshots/
```

## Markdown Capture Template

```markdown
---
title: <Capture title>
type: browser-capture
captured_at: YYYY-MM-DDTHH:MM:SS+09:00
source_url: <URL or source unknown>
---

# <Capture title>

## 목적
## 절차
## 관찰 내용
## 추출 텍스트
## 스크린샷
## 후속 ingest 제안
```

## Hand-Off

- For ordinary research captures, recommend `/ingest raw/chat/YYYY-MM-DD/<slug>.md`.
- For webapp/code QA captures, recommend `/ingest raw/chat/YYYY-MM-DD/<slug>.md`;
  wiki-ingest will detect code/log evidence and update Code Wiki debug/testing
  pages when appropriate.

## Prohibited

- Do not store passwords, cookies, API keys, or session tokens in raw captures.
- Do not bypass access controls.
- Do not scrape sites against explicit user or site restrictions.
