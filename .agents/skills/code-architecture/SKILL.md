---
name: code-architecture
description: Create Code Wiki architecture pages from repository evidence. Use when wiki-ingest detects a software project, service boundaries, package structure, data flow, APIs, queues, storage, or architecture decisions. Writes wiki/code/<project>/architecture.md with cited evidence.
allowed-cli: [codex, claude, gemini, cline]
---

# code-architecture

## LLM Wiki Pattern Reference

Code architecture pages extend the persistent-wiki idea in
[`llm-wiki.md`](../../../llm-wiki.md) to software structure. They should compile
evidence from source summaries and raw code into maintained `wiki/code/`
architecture knowledge, with uncertainties marked instead of inferred.

## Purpose

Explain how a codebase is structured and why it behaves that way. This is not a
speculation exercise; every claim should be grounded in files, manifests, code
pages, or source summaries.

## Inputs

- `wiki/code/<project>/overview.md`
- Mirrored directory indexes such as `wiki/code/<project>/src/index.md`
- Mirrored file pages such as `wiki/code/<project>/src/server.ts.md`
- `wiki/sources/...` pages
- Read-only `raw/...` files only when needed

## Workflow

1. Identify the project boundary and runtime entry points.
2. Map major components/packages/modules.
3. Trace the main data/control flows.
4. Record cross-cutting concerns: auth, persistence, caching, background jobs,
   external APIs, CLI boundaries, build/deploy mechanisms.
5. Capture architecture decisions only when supported by evidence. If intent is
   unclear, write "의도는 소스만으로 확인되지 않음".
6. Add risks or coupling points that matter for future maintainers.

## Output Page

Write or update `wiki/code/<project>/architecture.md`:

```markdown
---
title: <Project> Architecture
type: architecture
tags: [code, architecture, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <Project> Architecture

## 요약
## 시스템 경계
## 주요 구성 요소
## 데이터/제어 흐름
## 외부 의존성
## 설계 결정
## 확장/변경 시 주의점
## 관련 페이지
```

## Linking

Use wikilinks to connect architecture nodes to implementation pages:

- `[[Project Overview]]`
- `[[Module Name]]`
- `[[API Name]]`
- LLM Wiki concepts such as `[[Retrieval]]` or `[[Agent Workflow]]` when the
  code implements them.

## Prohibited

- Do not invent cloud topology, deployment targets, or external services.
- Do not draw conclusions from filenames alone when code contradicts them.
- Do not write ADRs as accepted decisions unless the repository contains
  evidence that the decision is accepted.
