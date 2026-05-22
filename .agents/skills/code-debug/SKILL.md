---
name: code-debug
description: Analyze error logs, stack traces, failing tests, crash reports, and reproduction notes inside raw/ and turn them into Code Wiki debug notes. Use when wiki-ingest sees runtime failures or when the user asks to debug code evidence without mutating raw/.
allowed-cli: [codex, claude, gemini, cline]
---

# code-debug

## Purpose

Preserve debugging knowledge in the Code Wiki: what failed, where the evidence
points, which modules are involved, and how a maintainer should verify a fix.

This skill may analyze code and logs, but it does not patch source files unless
the user separately asks for implementation work.

## Inputs

- Stack traces, CI logs, browser console output, server logs, issue notes, or
  failing test output under `raw/...`.
- Code pages and source summaries produced by `wiki-ingest`.
- Read-only code files under `raw/...` when needed.

## Workflow

1. Reconstruct expected vs actual behavior from the evidence.
2. Identify the failing boundary: UI, API, CLI, data layer, build, test,
   dependency, environment, or configuration.
3. Trace stack frames or log markers to code pages/modules.
4. List hypotheses and mark each as supported, weak, or ruled out.
5. Write the most likely cause only when evidence supports it.
6. Recommend verification steps and regression tests.

## Output Page

Write or update `wiki/code/<project>/debug-notes.md`:

```markdown
---
title: <Project> Debug Notes
type: analysis
tags: [code, debug, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <Project> Debug Notes

## 증상
## 영향 범위
## 관련 파일/모듈
## 근거
## 가능한 원인
## 검증 방법
## 권장 후속 조치
## 관련 페이지
```

For multiple unrelated failures, append dated subsections instead of blending
them into one root cause.

## Safety

- Mask credentials and personal data in logs.
- Do not modify `raw/`.
- Do not claim a fix was tested unless a test/build command actually ran.
- If evidence is insufficient, say what evidence is missing.
