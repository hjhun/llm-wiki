---
name: code-testing
description: Build Code Wiki testing pages from repository evidence. Use when wiki-ingest finds tests, CI config, coverage reports, or when the user asks how the code is tested. Writes wiki/code/<project>/testing.md with test inventory, gaps, and recommendations.
allowed-cli: [codex, claude, gemini, cline]
---

# code-testing

## Purpose

Document the test posture of a codebase so future agents and humans know what
is covered, what is risky, and how to verify changes.

## Inputs

- Test files and test directories under logical `raw/...` paths.
- CI config, package scripts, Makefiles, task runners, coverage reports.
- Code pages and source summaries from `wiki-ingest`.

## Workflow

1. Inventory test frameworks and commands from manifests/config.
2. Map tests to modules, APIs, and user workflows.
3. Identify test levels: unit, integration, e2e, smoke, visual, accessibility,
   performance, security.
4. Note gaps for critical modules or high-risk flows.
5. Recommend focused additions. Keep them proportional to the codebase.
6. If commands are run, record exact commands and outcomes. If commands cannot
   be run because the code is under `raw/` and read-only, say so.

## Output Page

Write or update `wiki/code/<project>/testing.md`:

```markdown
---
title: <Project> Testing
type: code
tags: [code, testing, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <Project> Testing

## 요약
## 테스트 실행 명령
## 테스트 구조
## 모듈별 커버리지
## 주요 누락
## 권장 테스트
## 검증 기록
## 관련 페이지
```

## Recommendations

Prefer concrete recommendations:

- "Add route-level integration tests for `POST /api/chat/send` cancellation."
- "Add fixture-based parser tests for malformed frontmatter."

Avoid vague recommendations like "increase coverage" unless paired with target
areas and examples.
