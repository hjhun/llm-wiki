# CLIO 개선 수정 계획서

> 작성일: 2026-06-01
> 선행 문서: [`CLIO_ANALYSIS_2026-06-01.md`](./CLIO_ANALYSIS_2026-06-01.md) (오늘 오전 진단)
> 범위: 선행 진단 이후 반영 사항을 반영한 **현재 상태(post-fix + Telegram 봇)** 재분석과 다음 작업 계획
> 언어: 본 계획서는 한글, 코드/식별자/경로는 영문 유지

---

## 0. 선행 진단 대비 현재 상태 (무엇이 이미 끝났나)

오늘 오전 `CLIO_ANALYSIS_2026-06-01.md`에서 제기한 항목은 git 로그상 **대부분 이미 반영**되었습니다. 본 계획서는 남은/새 항목에 집중합니다.

| 선행 항목 | 상태 | 근거 커밋 |
|---|---|---|
| A-1 source 경로 문서 표류 | ✅ 반영 | `45bf3bf` Fix stale source path docs to raw-mirror scheme |
| A-2 단일 글로벌 락 vs 병렬 | ✅ 반영 | `0cb97cb` Replace global ingest lock with per-leaf locks and disjoint scopes |
| B-1 query 환류 1-click | ✅ 반영 | `3677f1d` Add 1-click save button for query answers |
| C-1 sources/index 결정적 생성 | ✅ 반영 | `0e94f40` Generate wiki/sources/index.md from a deterministic script |
| C-2 post-merge mini-lint | ✅ 반영 | `19af73b` Add deterministic post-merge mini-lint gate |
| C-3 mini-wiki 예제 | ✅ 반영 | `c6d9a1e` Add hand-curated mini-wiki example |
| B-3 이미지 처리(`wiki-images`) | ❌ 미해결 | 본 계획 P2-1 로 이월 |

그 사이 **Telegram 봇**이 신규 추가되었습니다(`webapp/lib/telegram/` 13개 모듈, `a00a85b`~`0513f09` 7개 커밋). 새 표면이 늘었으므로 검증·보안 항목이 본 계획의 중심입니다.

---

## 1. 현재 코드베이스 요약

- **스킬 계층** (`.agents/skills/`): ingest / query / lint / preprocess / graphify / browser-capture / code-* / skill-maintenance / marp / search-qmd. 스키마(`CLAUDE.md` ↔ `AGENTS.md`)는 바이트 동기화 유지.
- **webapp** (Next.js 15 / React 19): Chat·Explorer·Graph·Settings·Automations + 40여 개 API 라우트 + `webapp/lib/` 백엔드 로직.
- **cli-rs** (Rust `clio`): server/http/raw 서브커맨드, 통합 테스트 3종(`tests/*.rs`) + CI(`cli.yml`)에서 fmt/clippy/build/test 검증.
- **scripts/**: 결정적 헬퍼(`build-sources-index.mjs`, `mini-lint.mjs`, `merge-graph-parts.mjs`, `organize-sources.mjs`, `preprocess-raw.mjs` 등) + `smoke-test.sh`.

### 규모 신호 (유지보수/altitude)

```
webapp/lib/ingest-loop.ts   2105 LOC   ← god module
webapp/lib/multi-agent.ts   1041 LOC
webapp/lib/secret-scan.ts    142 LOC   (보안 게이트, 테스트 0)
webapp/lib/telegram/*.ts    ~1500 LOC  (신규, 테스트 0)
```

---

## 2. 신규/잔여 문제점 (현재 기준)

### 🔴 P0. webapp 자동 검증 부재 (가장 시급)

**증상**
- `webapp/`에 `*.test.ts`가 **하나도 없음**. `package.json`에 테스트 러너(vitest/jest) 미설치, `test` 스크립트 없음.
- CI `.github/workflows/cli.yml`은 **Rust만** 검증. webapp은 `tsc --noEmit`·`next lint`·`smoke-test.sh`조차 CI에서 실행되지 않음.

**왜 위험한가**
- `secret-scan.ts`는 **fail-closed 보안 게이트**(wiki/answers에 자격증명이 새지 않도록 막는 마지막 코드 방어선)인데 회귀 테스트가 없다. 정규식 1개만 깨져도 조용히 누설된다.
- `telegram/router.ts`·`handlers.ts`의 **allowlist 게이트**, `throttle.ts` 레이트리밋, `splitter.ts` 메시지 분할은 보안·정합성 핵심인데 검증이 없다.
- `build-sources-index.mjs`·`mini-lint.mjs` 같은 결정적 스크립트는 "결정성"이 가치인데 골든 테스트가 없어 표류를 못 잡는다.

**조치**
1. `webapp`에 **vitest** 추가(`devDependencies`), `"test": "vitest run"`·`"test:watch"` 스크립트 추가.
2. 우선순위 순으로 단위 테스트 작성:
   - `secret-scan.test.ts` — 10개 rule별 양성/음성 케이스, 이미 마스킹된 placeholder 재매칭 안 됨, `summarizeFindings` 카운트.
   - `telegram/router.test.ts` + `handlers.test.ts` — allowlist 비포함 chat 무시, 그룹은 멘션/슬래시만 통과, pending 페어링이 메시지로 승인되지 않음.
   - `telegram/throttle.test.ts`, `splitter.test.ts` — 윈도 경계, 4096자 분할/코드펜스 보존.
   - `scripts/build-sources-index.mjs`, `scripts/mini-lint.mjs` — 골든 입력→출력 스냅샷.
3. CI에 **webapp job 추가**(`cli.yml`에 병렬 job 또는 신규 `webapp.yml`): `npm ci` → `tsc --noEmit` → `next lint` → `vitest run` → `bash scripts/smoke-test.sh`.

**수용 기준**: `npm test`가 로컬·CI에서 통과하고, secret-scan/telegram allowlist의 핵심 경로가 테스트로 커버됨. PR 시 webapp 검증이 자동 게이트.

---

### 🔴 P1. 비밀정보 마스킹이 영속 경계 일부에만 적용됨

**증상**
- `redactSecrets`는 현재 `telegram/save-answer.ts`(질문+답변을 `wiki/answers/`에 쓰기 직전)에서만 호출된다.
- `telegram/session-log.ts:94`는 수신 메시지/답변을 **원문 JSON 그대로** `sessions/`에 append한다(마스킹 없음). 채팅 히스토리(`history.ts`)도 동일 가능성.

**왜 문제인가**
- 사용자가 Telegram으로 토큰을 붙여넣으면 `wiki/answers/`에는 마스킹되지만 `sessions/` 로그에는 평문으로 남는다. `CLAUDE.md §9`("자격증명/개인정보를 평문으로 남기지 말 것")의 의도와 어긋난다. `sessions/`는 append-only라 사후 정정도 어렵다.

**조치**
- secret-scan을 **영속 경계 공통 유틸**로 끌어올려, `session-log`·chat history 저장 직전에도 `redactSecrets`를 통과시킨다(저장본만 마스킹, 처리용 메모리 값은 유지).
- 마스킹 정책을 한 곳(`secret-scan.ts` 또는 얇은 `persist-guard.ts`)으로 모아 "쓰기 전에 무조건 거른다"를 단일 규칙화.
- P0의 테스트에 "session-log 저장 시 비밀정보 마스킹" 케이스 포함.

**수용 기준**: Telegram 경로에서 비밀정보가 들어오면 `wiki/answers/`·`sessions/` 어느 곳에도 평문으로 남지 않음(테스트로 보장).

---

### 🟡 P2. 이전 진단 B-3 이월: 이미지/멀티모달 공백

**증상**
- `wiki-ingest/SKILL.md:467`이 `wiki-images`를 optional로 참조하지만 `.agents/skills/`에 **해당 스킬이 없다**(dangling reference).
- 스캔 PDF·스크린샷 등 멀티모달 source의 처리 흐름이 명시되어 있지 않다(`llm-wiki.md` 원안 Tips는 이미지 로컬화 후 텍스트→이미지 순 열람을 권장).

**조치(택1, 단계적)**
- **P2-1a (최소)**: dangling reference 제거 또는 "미구현, 향후"로 명확히 표기해 표류 제거.
- **P2-1b (권장)**: 경량 `wiki-images` 스킬 신설 — 이미지/스캔을 `wiki/sources/`에 caption·OCR 요약·alt-text로 기록하고 원본은 `raw/` 불변 유지, 그래프 노드로 브리지. 호스트 CLI 멀티모달 가능 여부에 따라 동작 분기.

**수용 기준**: 스킬 참조가 실제 파일과 일치하고, 이미지 source 인입 시 행동이 문서화됨.

---

### 🟡 P3. `ingest-loop.ts` 2105줄 god module

**증상**
- 단일 파일에 leaf 열거·청크 분할·락·워커 프롬프트·머지·진행상태·로그가 혼재. 변경 영향 범위 추적과 테스트가 어렵다(P0 테스트 작성의 직접적 장애).

**조치**
- 동작 변경 없이 책임 단위로 분해: `leaf-planner.ts`(leaf/pseudo-leaf 열거·서브청크), `lock.ts`(per-leaf 락 — 이미 일부 존재 시 통합), `worker-prompt.ts`(프롬프트 빌드), `merge.ts`(merge pass), `progress.ts`(state/log). `ingest-loop.ts`는 오케스트레이션만.
- 분해와 동시에 각 추출 단위에 단위 테스트를 붙여 P0과 합류.

**수용 기준**: 외부 동작 동일(스모크·기존 흐름 회귀 없음), 각 파일 ≤ ~400 LOC, 순수 함수 단위 테스트 가능.

---

### 🟢 P4. 방향성 개선 (여유 시)

- **P4-1 Telegram 운영 가시성**: `getMe` 신원 캐시(`bot-identity.ts`)·webhook 폴백(`polling.ts`)·레이트리밋 hit를 Settings 상태 패널/로그에 노출해 운영자가 봇 상태를 진단 가능하게.
- **P4-2 결정적 스크립트 단일 진입점**: `scripts/`의 mjs 헬퍼들을 `npm run wiki:index` / `wiki:lint` 등으로 묶고 README/GUIDE에 노출(현재는 스킬 내부에서만 호출).
- **P4-3 examples 확장**: 현재 mini-wiki 예제(`c6d9a1e`)에 **이미지·코드 혼합 source** 케이스를 1개 추가해 Code Wiki + 멀티모달 산출물 형태를 실증(P2와 연계).
- **P4-4 README "Current State" 갱신**: Telegram 봇 추가 사실을 기능 표/스크린샷에 반영(GUIDE에는 이미 문서화됨 `f217af2`, README 동기화 확인).

---

## 2.5. 진행 현황 (2026-06-01 업데이트)

1차 스프린트(P0 + P1)를 구현했습니다. 브랜치: `feat/webapp-tests-and-secret-masking`.

- **P0 완료**
  - `webapp`에 vitest 도입(`vitest.config.ts`, `test`/`test:watch` 스크립트, `server-only` 테스트 스텁).
  - 단위 테스트 43개 추가: `secret-scan.test.ts`(rule별 양성/음성·idempotent·summary), `telegram/router.test.ts`(allowlist·그룹 게이팅·`--save` 권한·미지원 명령), `telegram/throttle.test.ts`(슬라이딩 윈도), `telegram/splitter.test.ts`(4096 분할·content 보존), `telegram/session-log.test.ts`(P1 마스킹).
  - CI에 `.github/workflows/webapp.yml` 추가(`npm ci` → `npm test` → `smoke-test.sh`). `next lint`은 본 저장소에 ESLint 설정이 없어(인터랙티브) CI에서 제외.
  - `scripts/smoke-test.sh`에 `npm test` 단계 추가 → 단일 스모크 엔트리포인트가 typecheck + 단위테스트 + 빌드를 모두 커버.
- **P1 완료**
  - `secret-scan`의 `redactSecrets`를 Telegram 세션 로그 저장 경계로 확장. `telegram/session-log.ts`에서 순수 함수 `buildTelegramSessionEntry`를 추출해 `rawMessage`·`question`·`answer`·`error` 영속 필드를 저장 직전 마스킹(테스트로 보장). 이제 비밀정보가 `wiki/answers/`·`sessions/` 어디에도 평문으로 남지 않음.

- **P3 완료**
  - `ingest-loop.ts`(2105줄)에서 순수·부작용 없는 클러스터를 동작 보존을 전제로 추출: `lib/ingest/scope.ts`(경로/스코프 헬퍼), `lib/ingest/leaf-classify.ts`(code/prose 분류), `lib/ingest/loop-decision.ts`(halt 판정·진행 감지·연속 프롬프트·요약), `lib/ingest/types.ts`(StateSummary·ProgressSnapshot·EMPTY_SNAPSHOT).
  - 이동한 공개 심볼은 `ingest-loop.ts`에서 그대로 re-export하여 `@/lib/ingest-loop` 외부 임포트 호환성 유지(공개 API 무변경).
  - `ingest-loop.ts` 2105 → 1757줄(−348), 추출 모듈에 단위 테스트 38개 추가(scope 7 / leaf-classify 13 / loop-decision 18).
  - 상태 보존(fs/락/CLI/graphify) 로직은 통합 테스트가 없어 이번 패스에서 이동하지 않음 — 후속 작업으로 분리 가능.

- **P2 완료** (권장안 P2-1b)
  - 경량 `wiki-images` 스킬 신설: `.agents/skills/wiki-images/SKILL.md`. 이미지/스캔/스크린샷/멀티모달 PDF 리프를 ingest 안에서 **텍스트 우선 → 이미지 보조** 순으로 처리하고, `wiki/sources/<raw-mirror>.md`에 caption·alt-text·연결을 기록. `raw/` 원본은 불변. 호스트 CLI 비전 가능 여부에 따라 `status: summarized | needs_review`로 분기(없는 텍스트를 지어내지 않음).
  - dangling 참조 정리: `wiki-ingest/SKILL.md`의 bare `wiki-images`를 실제 스킬 링크로 교체.
  - 라우팅 노출: `CLAUDE.md`·`AGENTS.md` §6 스킬 라우팅 표에 wiki-images 행 추가(두 파일 바이트 동기화 유지).

- **P4 부분 완료** (방향성 항목)
  - **P4-1 운영 가시성**: Telegram 레이트리밋 hit를 generic skip과 분리해 별도 `throttled` 카운터로 추적(`runtime-state.ts`+`handlers.ts`), `/api/telegram/status`에 자동 노출, Settings `TelegramPanel`에 Stat 추가, i18n(ko/en) 라벨 추가, 단위 테스트 추가.
  - **P4-2 결정적 스크립트 진입점**: `webapp/package.json`에 `wiki:sources-index[:check]`·`wiki:mini-lint[:check]` npm 스크립트 추가(각 `--root ..`). `:check`는 비변경 게이트.
  - **P4-4 문서 동기화**: GUIDE/GUIDE_ko에 "결정적 헬퍼 스크립트" 절 추가. README의 Telegram 봇 언급은 이미 반영됨(`f217af2`) 확인.
  - **P4-3 examples 확장(이미지+코드 혼합)**: 콘텐츠 작업 비중이 커서 이번엔 보류 — 후속.

검증: `npm test` 84 passed, `tsc --noEmit` 통과, `next build` 성공, `scripts/smoke-test.sh` 통과. CLAUDE.md ↔ AGENTS.md 동일성 확인.

남은 항목(P4-3 예제 확장, ingest-loop의 상태 보존 클러스터 추가 분해)은 후속 작업.

---

## 3. 우선순위 및 실행 순서

| 순위 | 항목 | 근거 | 규모 |
|---|---|---|---|
| 1 | **P0** webapp 테스트 러너 + secret-scan/telegram/스크립트 테스트 + CI job | 보안 게이트·신규 봇 회귀 무방비 | 중 |
| 2 | **P1** 비밀정보 마스킹을 모든 영속 경계로 확장 | 실제 평문 누설 경로 존재 | 소~중 |
| 3 | **P3** `ingest-loop.ts` 분해 | P0 테스트 작성의 선결 조건 성격 | 중 |
| 4 | **P2** `wiki-images` dangling 정리/스킬 신설 | 표류 제거 + 원안 충실 | 소(a)/중(b) |
| 5 | **P4** 운영 가시성·examples·문서 동기화 | 점진 개선 | 소 |

**권장 1차 스프린트**: P0 + P1 (검증 인프라와 보안 누설 차단을 먼저 닫고, 이후 P3 리팩터를 테스트 보호망 위에서 진행).

---

## 4. 리스크 및 주의

- **P3 리팩터는 동작 보존이 절대 조건** — 먼저 P0로 회귀 테스트/스모크를 깔고, 그 위에서만 분해한다(반대 순서 금지).
- **P1 마스킹은 저장본에만 적용** — 처리 파이프라인 중간값까지 마스킹하면 답변 품질이 떨어질 수 있으므로 "persist 직전"으로 경계를 좁힌다.
- `raw/`·`sessions/`·`config/local.json`·`.env*`는 `CLAUDE.md §9` 하드룰에 따라 본 작업 중에도 직접 수정 금지(테스트는 임시 fixture/tmp 디렉터리 사용).
- 스키마 변경이 필요하면 `CLAUDE.md`↔`AGENTS.md` 바이트 동기화 유지(§12 override order).

---

## 5. 근거 파일 인덱스

- 테스트 부재: `webapp/package.json`(test 스크립트/러너 없음), `find webapp -name '*.test.ts'` → 0건
- CI 범위: `.github/workflows/cli.yml`(Rust 전용), `scripts/smoke-test.sh`
- 보안 게이트: `webapp/lib/secret-scan.ts`, 호출부 `webapp/lib/telegram/save-answer.ts:144`
- 마스킹 누락 경계: `webapp/lib/telegram/session-log.ts:94`, `webapp/lib/telegram/history.ts`
- Telegram allowlist/throttle: `webapp/lib/telegram/router.ts:45`, `handlers.ts:35,171`, `throttle.ts`, `splitter.ts`
- god module: `webapp/lib/ingest-loop.ts`(2105 LOC), `webapp/lib/multi-agent.ts`(1041 LOC)
- dangling 스킬 참조: `.agents/skills/wiki-ingest/SKILL.md:467`(`wiki-images`)
- 결정적 스크립트: `scripts/build-sources-index.mjs`, `scripts/mini-lint.mjs`
