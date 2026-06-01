# CLIO 구현 분석: `llm-wiki.md` 패턴 대비 진단

> 작성일: 2026-06-01
> 대상: `llm-wiki.md` 원안 vs. CLIO 현재 구현(스킬 / webapp / cli-rs / 문서)
> 목적: 부족·오류·표류 지점 식별 및 개선 제안

---

## 1. 전체 구조 파악

CLIO는 Karpathy의 `llm-wiki.md` 3계층(immutable `raw/` → LLM이 유지하는 `wiki/` → 스키마 `CLAUDE.md`/`AGENTS.md`)을 충실히 인스턴스화하고, 거기에 다음을 특화로 얹었습니다.

- **resumable 청킹**: leaf-first + merge pass, "1 LLM 호출 = 1 sub-chunk" 계약으로 OOM 회피 (`.agents/skills/wiki-ingest/SKILL.md`)
- **Next.js 풀스택 웹 UI**: Chat / Explorer / Graph / Settings / Automations, 인증·공개 공유(`webapp/app/`, 40+ API 라우트)
- **네이티브 Rust CLI** `clio` (`cli-rs/src/`)
- **Code Wiki + graphify** 그래프 통합 (`.agents/skills/wiki-graphify/SKILL.md`)
- **Auto Ingest / Auto Lint / 멀티에이전트 오케스트레이션** (`webapp/lib/multi-agent.ts`, `webapp/lib/ingest-loop.ts`)

스키마(`CLAUDE.md` ↔ `AGENTS.md`)는 **바이트 단위로 완전히 동기화**되어 있고, `config/default.json`의 knob(`maxFilesPerInvocation: 4` 등)도 스킬 기본값과 일치합니다. 설계 문서로서의 일관성은 매우 높습니다.

> 참고: 현재 `raw/`에는 automation 로그뿐이고 `wiki/`는 init 로그만 있는 **스캐폴드 상태**입니다(실제 콘텐츠 없음). 즉 평가 대상은 "축적된 위키"가 아니라 "인프라/스킬 구현"입니다.

---

## 2. 핵심 아이디어 충실도 — 잘 지킨 부분

| 원안 원칙 | CLIO 구현 | 평가 |
|---|---|---|
| raw immutable | `/preprocess` 외 모든 `raw/` 변경 금지, 심링크는 read-only | ✅ 강하게 강제 |
| 누적되는 영속 위키 | `wiki/sources/` provenance + entity/concept 합성 계층 분리 | ✅ 원안보다 정교 |
| index.md/log.md | content catalog + append-only log, `grep "^## \["` 호환 | ✅ 원안 의도 그대로 |
| query 답변 환류 | `wiki/answers/<slug>.md` 피드백 | ✅ 스킬에 명시 |
| lint 건강검진 | 모순/orphan/stale/누락 페이지 검사 | ✅ |

---

## 3. 발견된 문제점

### 🔴 A. 잘못/불일치 (수정 필요)

#### A-1. 문서가 폐기된 날짜 기반 source 경로를 아직 안내함 (가장 명확한 버그)

스키마는 source 페이지를 **raw 경로 미러링**(`wiki/sources/<raw-relative-path>.md`)으로 확정했고, lint 스킬은 구 스킴을 신 스킴으로 마이그레이션하는 fix 규칙까지 가지고 있습니다(`.agents/skills/wiki-lint/SKILL.md:158`). 그런데 사용자 대면 문서는 여전히 폐기된 날짜 폴더 스킴을 안내합니다:

- `README.md:51`, `README.md:163` → `wiki/sources/YYYY/YYYY-MM/`
- `docs/GUIDE.md:66,461,767`, `docs/GUIDE_ko.md:63,457,762`

신규 사용자가 README의 "First Wiki in Five Minutes"를 따라 하면 실제 산출물 경로와 안내가 어긋납니다. **README/GUIDE의 5곳을 raw-mirror 스킴으로 교정**해야 합니다.

#### A-2. 멀티에이전트 "병렬"과 단일 글로벌 락의 모순

`webapp/lib/multi-agent.ts:377`의 `runWorkerBatch`는 한 라운드에서 워커들을 `Promise.all`로 **동시 실행**합니다(`maxConcurrentAgents: 2`). 반면 wiki-ingest는 단일 글로벌 락 `wiki/.progress/ingest/.lock`을 쓰고, 워커 프롬프트는 "락이 잡혀 있으면 standing by 후 정상 종료"로 지시합니다(`webapp/lib/multi-agent.ts:287`).

결과적으로 **한 라운드에 N개를 띄워도 락을 잡은 1개만 실제 작업하고 나머지는 no-op 종료**합니다. 즉 병렬 인입의 실효가 거의 없는데, `CLAUDE.md`/스킬은 "parallel workers each see only part of the input"(중복 페이지 방지 근거)라고 진짜 분업 병렬을 전제로 서술합니다(`.agents/skills/wiki-ingest/SKILL.md:227`).

→ 둘 중 하나를 택해야 합니다:
- (a) 코디네이터가 워커별로 **서로소 leaf 스코프**를 배정하고 **leaf 단위(per-leaf) 락**으로 바꿔 진짜 병렬화
- (b) 동시 실행을 라운드당 1워커로 줄이고 문서의 "병렬" 표현을 정정

현재는 비용(여러 CLI 동시 기동)만 들고 이득은 없는 중간 상태입니다.

### 🟡 B. 부족한 부분

#### B-1. query "save 토글"이 실제 인터랙티브 UI가 아님
`.agents/skills/wiki-query/SKILL.md:125,170`은 답변 끝에 `[ ] wiki/answers/...` 토글을 "클릭하면 환류"라고 묘사하지만, 이는 채팅 마크다운의 체크박스 텍스트일 뿐 클릭 가능한 위젯이 없습니다(환류는 결국 `--save`를 다시 타이핑하거나 재요청해야 동작). 원안이 강조한 "좋은 답변을 위키로 compounding"의 마찰 지점입니다. **버튼/후속 액션으로 실제 환류를 1-click 처리**하면 가치가 큽니다.

#### B-2. 원안의 "대화하며 takeaway 합의" 루프가 자동화에 밀림
원안은 "LLM이 핵심 takeaway를 사용자와 **논의한 뒤** 요약을 쓴다"는 human-in-the-loop를 강조합니다. CLIO는 OOM 회피를 위해 `one_subchunk` + 백엔드 루프 + auto-ingest로 강하게 자동화했는데, 그 과정에서 **인입 중 대화/확인 단계가 사실상 사라졌습니다**. 합리적 트레이드오프지만, "한 sub-chunk 처리 후 takeaway를 채팅에 요약하고 사용자 강조점을 받는" 경량 체크인을 옵션으로 두면 원안 철학에 더 부합합니다.

#### B-3. 이미지 처리 미흡
원안의 Tips는 이미지 로컬 다운로드 후 LLM이 텍스트→이미지 순으로 보는 워크플로우를 권합니다. 스킬에는 `wiki-images`가 "optional"로 언급만 되고(`.agents/skills/wiki-ingest/SKILL.md:460`) 실제 스킬 디렉터리에 없습니다. 멀티모달 source(스캔 PDF, 스크린샷)가 들어오면 공백이 생깁니다.

### 🟢 C. 개선 제안 (방향성)

- **C-1. `wiki/sources/index.md` 생성을 LLM 손맛에서 결정적 코드로**: 현재 소스 카탈로그는 merge pass에서 LLM이 frontmatter를 보고 재생성합니다. 규모가 커지면 누락/표류 위험이 큽니다. frontmatter를 파싱해 카탈로그를 만드는 **결정적 스크립트**(Dataview식)를 두고 LLM은 보강만 하게 하면 일관성이 올라갑니다.
- **C-2. lint의 자동 회귀 게이트화**: lint는 강력하지만 수동/스케줄 트리거입니다. 멀티에이전트 병렬 인입이 만든 near-duplicate/orphan을 merge pass 직후 자동으로 빠르게 점검하는 "post-merge mini-lint"를 두면 그래프 노드 중복(분리된 노드)이 줄어듭니다.
- **C-3. README "Current State"의 실증 보강**: README는 풍부한 기능을 주장하지만 저장소에 실제 ingest 산출물 예시가 없습니다. `examples/`에 **완성된 mini-wiki 스냅샷**(소스 1~2개를 끝까지 ingest한 결과)을 넣으면 신규 사용자가 산출물 형태를 즉시 검증할 수 있고 A-1 같은 문서 표류도 조기에 잡힙니다.

---

## 4. 우선순위 권고

1. **A-1 문서 경로 정정** — 즉시, 저비용, 사용자 혼란 직결
2. **A-2 락/병렬 모델 정리** — 설계 일관성과 비용 효율 모두 영향
3. **B-1 query 환류 1-click** — 원안 핵심 가치("explorations compound") 직결
4. **C-1 / C-3** — 규모 확장 시 안정성

---

## 5. 근거 파일 인덱스

- 스키마: `CLAUDE.md`, `AGENTS.md` (동기화 확인됨)
- 인입 계약: `.agents/skills/wiki-ingest/SKILL.md`
- 질의/환류: `.agents/skills/wiki-query/SKILL.md`
- 린트/마이그레이션: `.agents/skills/wiki-lint/SKILL.md:158`
- 멀티에이전트 동시성: `webapp/lib/multi-agent.ts:287,377`
- 설정 기본값: `config/default.json`
- 표류 문서: `README.md:51,163`, `docs/GUIDE.md`, `docs/GUIDE_ko.md`
