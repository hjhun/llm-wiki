---
name: code-documentation
description: Write Code Wiki documentation pages from code evidence gathered by wiki-ingest. Use when /ingest detects code and needs module, API, CLI, runbook, README-style, configuration, data model, or developer workflow pages inside wiki/code/. Always cite wiki/source pages and raw logical paths.
allowed-cli: [codex, claude, gemini, cline]
---

# code-documentation

## Purpose

Produce useful Markdown documentation from code without changing the code.
This skill is usually called by `wiki-ingest` after source files have been
summarized.

## Inputs

- Existing `wiki/sources/...` source summaries.
- Existing `wiki/code/<project>/...` pages, including file-level pages under
  `wiki/code/<project>/files/`.
- Read-only code evidence under `raw/...` when the summaries are insufficient.

## Documentation Types

Choose the smallest useful type:

- **Overview**: project/module purpose, entry points, main flows.
- **File Page**: one code file's role, symbols, dependencies, important
  locations, tests, risks, and related module/API pages.
- **API Reference**: exported functions, routes, CLI commands, schemas.
- **Configuration Guide**: env vars, config files, defaults, operational knobs.
- **Runbook**: recurring operation, setup, build, deploy, or troubleshooting
  procedure described by the code.
- **Developer Guide**: how a maintainer should navigate and extend the code.

## Page Rules

1. Prefer Korean narrative. Keep code identifiers and commands in English.
2. Cite factual statements with `wiki/sources/...` or logical `raw/...` paths.
3. Link internal targets with wikilinks: `[[Module Name]]`, `[[Concept Name]]`.
4. Do not paste long code. Use short snippets only when they clarify an
   interface or invariant.
5. Mark unknowns explicitly instead of guessing.
6. For file-level pages, mention the logical `raw/...` path in the body and
   use `type: code` frontmatter so ingest coverage checks can verify them.

## Templates

### File Documentation

```markdown
---
title: <Project> / <relative file path>
type: code
tags: [code, file, <project>]
sources: [wiki/sources/<YYYY>/<YYYY-MM>/<slug>.md]
updated: YYYY-MM-DD
---

# <relative file path>

## 역할
## 주요 심볼
## 의존성
## 위치
## 테스트/검증
## 리스크
## 관련 페이지

Source: `raw/...`
```

### Module Documentation

```markdown
---
title: <Module>
type: code
tags: [code, module, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <Module>

## 역할
## 주요 파일
## 공개 인터페이스
## 내부 흐름
## 의존성
## 확장 포인트
## 관련 페이지
```

### API Documentation

```markdown
---
title: <API or CLI>
type: code
tags: [code, api, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <API or CLI>

## 목적
## 호출 방식
## 입력
## 출력
## 오류/예외
## 구현 위치
## 예시
## 관련 페이지
```

### Runbook

```markdown
---
title: <Operation Runbook>
type: code
tags: [code, runbook, <project>]
sources: [...]
updated: YYYY-MM-DD
---

# <Operation Runbook>

## 언제 쓰나
## 사전 조건
## 절차
## 검증
## 실패 시 대응
## 관련 페이지
```

## Output

Return the changed `wiki/code/**` pages to `wiki-ingest`, or if invoked
directly, update `wiki/index.md` and append an `ingest | code-docs` entry to
`wiki/log.md`.
