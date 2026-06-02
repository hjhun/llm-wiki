# CLIO 웹앱 UI/UX/CX 개선 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 문서는 진행 상황을 추적하는 대시보드 역할도 겸한다 — 각 단계를 완료할 때마다 체크박스를 갱신한다.

**Goal:** CLIO 웹앱의 정보 가시성(현황 대시보드)과 답변 가독성(Markdown 렌더링)을 중심으로 UI/UX/CX를 단계적으로 끌어올린다.

**Architecture:** 기존 Next.js App Router + 토큰 기반 디자인 시스템(globals.css CSS 변수, Tailwind)을 그대로 활용한다. 새 기능은 (1) 서버 집계 API + 클라이언트 탭 컴포넌트, (2) `MarkdownContent` 렌더 파이프라인 확장 두 축으로 추가한다. 새 라이브러리는 최소화하고(`rehype-highlight`만 추가), 시각 토큰은 재사용한다.

**Tech Stack:** Next.js (App Router, RSC), React 18, TypeScript, Tailwind, react-markdown v10 + remark-gfm, lucide-react, vitest.

**검증 명령:** `cd webapp && npm run typecheck && npm run lint && npm run test`

---

## 진행 현황 (대시보드)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 홈 대시보드 탭 | ✅ 완료 (df5a530) |
| 1 | 답변 렌더링 — 신택스 하이라이팅 + 콜아웃 | ✅ 완료 |
| 2 | 답변 렌더링 — 위키링크/표/스트리밍 커서 (+렌더러 통합) | ✅ 완료 (출처 푸터는 보류) |
| 3 | 비주얼 시스템 정돈 | ✅ 완료 (토큰 통합은 의도적 보류) |
| 4 | 모션 · 마이크로 인터랙션 | ⬜ 예정 |

각 Phase 완료 시 이 표와 해당 Task 체크박스를 갱신한다. Phase 단위로 커밋한다.

---

## File Structure

**Phase 0 (대시보드)**
- Create `webapp/app/api/dashboard/route.ts` — 현황 집계 GET API (서버 전용 fs 접근).
- Create `webapp/lib/dashboard.ts` — 집계 로직 (테스트 대상). 책임: raw 미처리 수, wiki 페이지 카운트, 최신 lint, graph 상태, 최근 log 항목, automation 상태를 한 객체로 묶는다.
- Create `webapp/lib/dashboard.test.ts` — 순수 파싱 함수 단위 테스트.
- Create `webapp/app/(protected)/dashboard/page.tsx` — RSC 페이지 (explorer/page.tsx 패턴).
- Create `webapp/components/dashboard/Dashboard.tsx` — 클라이언트 대시보드 UI.
- Modify `webapp/components/Sidebar.tsx` — TAB 항목에 dashboard 추가 (icon `LayoutDashboard`).
- Modify `webapp/components/i18n.tsx` — `sidebar.tabs.dashboard` + `dashboard.*` 문자열 (ko/en).
- Modify `webapp/lib/config.ts` — `ui.defaultTab` enum에 `"dashboard"` 추가.

**Phase 1 (하이라이팅 + 콜아웃)**
- Modify `webapp/package.json` — `rehype-highlight` 의존성 추가.
- Modify `webapp/components/chat/MarkdownContent.tsx` — rehypePlugins 연결, blockquote 콜아웃 컴포넌트.
- Modify `webapp/app/globals.css` — hljs 토큰 색상 매핑, `.md-callout-*` 스타일.
- Create `webapp/components/chat/markdown-callout.ts` — 인용문 → 콜아웃 종류 판별 헬퍼 (테스트 대상).
- Create `webapp/components/chat/markdown-callout.test.ts`.

**Phase 2~4**: 아래 각 Phase 섹션의 File 목록 참조 (착수 시점에 세부 task로 확장).

---

## Phase 0: 홈 대시보드 탭

**목적:** 첫 화면에서 "지금 위키가 어떤 상태인지"를 한눈에 보여준다. raw 미처리 자료, 위키 규모, lint 건강도, 그래프 통계, 최근 활동, 자동화 상태.

### Task 0.1: 집계 라이브러리와 단위 테스트

**Files:**
- Create: `webapp/lib/dashboard.ts`
- Test: `webapp/lib/dashboard.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `parseRecentLog`(log.md 텍스트 → 최근 N개 항목), `countUnprocessedRaw`(raw 파일 목록 + 존재하는 source 경로 → 미처리 수) 같은 순수 함수에 대한 테스트.
- [ ] **Step 2: 테스트 실패 확인** — `npm run test -- dashboard`.
- [ ] **Step 3: 최소 구현** — 순수 파싱 함수 + `collectDashboard()` (fs 집계: `listDir`/`readText`/`readGraphState`/`lintLockExists` 등 기존 lib 재사용).
- [ ] **Step 4: 테스트 통과 확인**.
- [ ] **Step 5: 커밋**.

### Task 0.2: 집계 API 라우트

**Files:**
- Create: `webapp/app/api/dashboard/route.ts`

- [ ] **Step 1:** 인증 가드(기존 라우트 패턴) + `collectDashboard()` 호출 → JSON 반환. `force-dynamic`.
- [ ] **Step 2:** typecheck 통과.
- [ ] **Step 3: 커밋**.

### Task 0.3: 대시보드 UI 컴포넌트 + 라우트

**Files:**
- Create: `webapp/components/dashboard/Dashboard.tsx`
- Create: `webapp/app/(protected)/dashboard/page.tsx`

- [ ] **Step 1:** 카드 그리드 UI — 미처리 raw(강조 배지), 위키 페이지 수, lint 최신 리포트, graph 노드/엣지/커뮤니티, 최근 log 타임라인, automation 상태. 토큰/`ui.tsx` 컴포넌트 재사용. 빈 상태 처리.
- [ ] **Step 2:** `/api/dashboard` fetch + 로딩/에러 상태. 각 카드에서 관련 탭으로 이동 링크.
- [ ] **Step 3:** typecheck/lint 통과.
- [ ] **Step 4: 커밋**.

### Task 0.4: 사이드바 · i18n · config 연결

**Files:**
- Modify: `webapp/components/Sidebar.tsx`
- Modify: `webapp/components/i18n.tsx`
- Modify: `webapp/lib/config.ts`

- [ ] **Step 1:** `TABS`에 dashboard를 chat 위에 추가, `LayoutDashboard` 아이콘. `Tab.key` 유니온에 `"dashboard"`.
- [ ] **Step 2:** i18n ko/en에 `sidebar.tabs.dashboard`와 `dashboard.*` 문자열.
- [ ] **Step 3:** `ui.defaultTab` z.enum에 `"dashboard"` 추가 (기본값은 기존 유지 — 사용자 선택).
- [ ] **Step 4:** typecheck/lint/test 통과 → 커밋. 진행 현황 표 갱신.

---

## Phase 1: 답변 렌더링 — 신택스 하이라이팅 + 콜아웃

**목적:** 가장 자주 보는 답변 본문의 가독성을 즉시 끌어올린다.

### Task 1.1: 코드 신택스 하이라이팅

**Files:**
- Modify: `webapp/package.json` (`rehype-highlight`)
- Modify: `webapp/components/chat/MarkdownContent.tsx`
- Modify: `webapp/app/globals.css`

- [ ] **Step 1:** `rehype-highlight` 설치.
- [ ] **Step 2:** `ReactMarkdown`에 `rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}` 연결. `CopyableCodeBlock`의 `<code>`가 hljs 클래스를 받도록 경로 확인(이미 className 전달됨).
- [ ] **Step 3:** globals.css에 `.hljs-*` → CSS 변수(accent/info/success/warning/ink) 매핑. 라이트/다크 모두 검증.
- [ ] **Step 4:** typecheck/lint, 수동 렌더 확인 → 커밋.

### Task 1.2: 인용문 콜아웃 카드

**Files:**
- Create: `webapp/components/chat/markdown-callout.ts`
- Test: `webapp/components/chat/markdown-callout.test.ts`
- Modify: `webapp/components/chat/MarkdownContent.tsx`
- Modify: `webapp/app/globals.css`

- [ ] **Step 1: 실패 테스트** — `detectCallout(firstLineText)`: `⚠️`/`Conflicts`→warning, `ℹ️`/`Note`→info, `❗`/`위험`→danger, 그 외 null.
- [ ] **Step 2:** 테스트 실패 확인.
- [ ] **Step 3:** 헬퍼 구현 + `blockquote` 컴포넌트 오버라이드(첫 텍스트로 종류 판별, 해당 시 `.md-callout-*` 카드로 렌더, 아니면 기본 인용문).
- [ ] **Step 4:** globals.css `.md-callout-{warning,info,danger}` 스타일(상태 색 토큰 재사용).
- [ ] **Step 5:** 테스트/typecheck/lint 통과 → 커밋. 진행 현황 표 갱신.

---

## Phase 2: 답변 렌더링 — 위키링크 / 출처 / 표 / 스트리밍 커서

**Files (착수 시 세부화):**
- Modify `webapp/components/chat/MarkdownContent.tsx` — `[[Page]]` 텍스트 변환(remark 커스텀 또는 전처리)으로 칩 + 호버 카드, 표(`table/thead/tr/td`) 스타일 오버라이드.
- Modify `webapp/components/chat/MessageList.tsx` — 스트리밍 중 마지막 assistant 메시지에 타이핑 커서.
- Modify `webapp/app/globals.css` — `.md-wikilink`, 표 줄무늬/헤더, `.md-cursor` blink.
- (선택) 답변에 사용된 sources를 하단 "참고한 소스" 카드로 정리.

세부 task는 Phase 1 완료 후 이 섹션을 bite-sized로 확장한다.

## Phase 3: 비주얼 시스템 정돈

**Files (착수 시 세부화):**
- Modify `webapp/app/globals.css` / `tailwind.config.ts` — 타이포 스케일, `default`/`dark` 토큰 중복 통합.
- Modify `webapp/components/chat/MessageList.tsx` — 메시지 본문 가독 폭 cap(`max-w-[70ch]` 류).
- Modify 빈 상태 컴포넌트 — 마스코트(`AgentMascot`/voxel) 재사용.

## Phase 4: 모션 · 마이크로 인터랙션

**Files (착수 시 세부화):**
- Modify `webapp/app/globals.css` — 메시지 진입 애니메이션(`prefers-reduced-motion` 가드), 스크롤 동작.
- Create `webapp/components/ui/Toast.tsx` (또는 기존 패턴) — 복사/작업 완료 토스트 일원화.

---

## Self-Review 메모

- 스펙 커버리지: 1차 제안의 답변 렌더링(하이라이팅/콜아웃/위키링크/출처/표/스트리밍/ToC/이미지)과 시각/모션 항목, 그리고 CX의 대시보드를 Phase 0~4로 매핑. ToC·이미지 라이트박스는 Phase 2 확장 시 포함 검토.
- 라이브러리 추가는 `rehype-highlight` 하나로 제한(YAGNI). Shiki는 번들 비용으로 보류.
- 라이트/다크 테마는 이미 존재 → 신규 스타일은 두 테마 모두에서 검증 필수.
