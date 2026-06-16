# Automation 스케줄 빌더 UI 개선 — 설계 (Spec)

- 날짜: 2026-06-16
- 대상: CLIO 웹앱 Automations 탭의 Schedule 패널
- 상태: 설계 승인됨 (구현 계획 전 단계)

## 1. 배경 / 문제

현재 Automations 탭의 Schedule 패널(`webapp/components/automation/Automations.tsx`,
약 869–966행)은 6개 필드(Mode·Preset·Time·Cron·Weekday·Day of month)를 **모드와
무관하게 한꺼번에** 평평하게 나열한다. 결과적으로:

- `Time`·`Weekday`·`Day of month`가 선택한 preset과 무관하게 항상 활성이라, 예컨대
  `hourly`인데 Weekday가 켜져 있어 무시되는 값이 보여 혼란을 준다.
- cron 모드는 **검증·해석·예시 없는 raw 5-필드 입력**이다. `cron.ts`에
  `validateCronExpression`이 있으나 UI에 연결되어 있지 않다.
- 설정 기준 **다음 실행 시각 미리보기**가 없다.
- 분단위(`*/10`)·복수 요일 같은 흔한 패턴을 쉽게 만들 방법이 없다(요일은 단일
  선택만 가능).

### 목표

- 쉽게 사용 가능한 "주기 타입" 기반 빌더로 교체.
- **분단위 / 매시간 / 매일 / 매주(복수 요일) / 매월** 을 모두 친절하게 지원.
- cron 자동 생성 + 인라인 검증 + 사람이 읽는 요약 + 다음 실행 미리보기.
- 숙련 사용자를 위한 "고급(raw cron)" 탈출구 유지.

### 비목표 (YAGNI / 별도 이슈)

- `schedule.timezone`은 현재 fire 계산에 사용되지 않는다(호스트 로컬 시간 사용,
  `cron.ts`의 `computeNextAutomationFire` 참조). **이번 작업에서 고치지 않는다.**
  별도 이슈로 기록만 한다.
- run 히스토리, 분단위 preset(고급 cron으로 충분), 알림/로그 변경 등은 범위 밖.

## 2. 사용자 결정 사항 (브레인스토밍에서 확정)

- 레이아웃: **A형 — 주기 칩 + 컨텍스트 필드** (문장형 B안은 기각).
- 분단위 비약수(예 7분): 60의 약수(5·10·12·15·20·30)만 기본 칩으로 제공.
  직접입력 시 비약수는 **경고만 표시하고 허용**(시간 경계에서 간격이 깨짐을 안내).
- 매월 일자: **1–28일로 제한**(모든 달에 존재해 안전). 말일 실행이 필요하면 고급
  cron을 쓰도록 안내.

## 3. 아키텍처 — compile-to-cron

친절한 빌더는 **순수 cron 생성기/파서**다. 모든 주기 타입은 5-필드 cron 문자열로
컴파일되어 `schedule.mode = "cron"` + `schedule.cron`으로 저장된다.

- 기존 `webapp/lib/automation/cron.ts`(`computeNextAutomationFire`,
  `computeNextCronFire`, `parseCronExpression`, `validateCronExpression`)를 그대로
  재사용한다 — 새 스케줄링 로직을 추가하지 않는다.
- `cron.ts`는 node 의존성이 없는 순수 모듈(타입 import만 존재)이라 **클라이언트
  컴포넌트에서 직접 import** 가능하다 → 라이브 검증·미리보기를 API 왕복 없이 처리.
- 복수 요일은 cron 문자열(`1,4`)로 표현하므로 **스키마(`schema.ts` /
  `config.ts`) 변경이 필요 없다**.
- 하위호환: 기존 `mode="preset"` 작업은 백엔드(`manager`/`cron.ts`)에서 계속
  동작한다. 새 UI는 불러올 때 cron/preset을 친절한 타입으로 역매핑하고, 저장 시
  cron으로 기록한다. (preset 작업을 편집·저장하면 동등한 cron으로 마이그레이션됨.)

## 4. 새 순수 모듈: `webapp/lib/automation/schedule-format.ts`

UI와 분리된, 단위 테스트 가능한 매핑/포맷 계층. React·I/O 없음.

```ts
export type FriendlyKind =
  | "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "advanced";

export type FriendlySchedule = {
  kind: FriendlyKind;
  intervalMinutes?: number; // minutes:   1–59
  intervalHours?: number;   // hourly:    24의 약수 (1,2,3,4,6,8,12)
  minute?: number;          // hourly/daily/weekly/monthly: 0–59
  hour?: number;            // daily/weekly/monthly:        0–23
  weekdays?: number[];      // weekly:    0(일)–6(토), 최소 1개
  dayOfMonth?: number;      // monthly:   1–28
  cron?: string;            // advanced:  raw 5-field
};

export function friendlyToCron(f: FriendlySchedule): string;
export function cronToFriendly(cron: string): FriendlySchedule;   // 미매칭 → { kind:"advanced", cron }
export function describeCron(cron: string): string;                // "매주 월·목 09:00"
export function isDivisorOf(n: number, base: number): boolean;     // 분/시간 균등 간격 경고용

// 검증은 차단(error)과 경고(warning)를 분리한다. error≠null이면 저장 비활성,
// warning≠null이면 표시만 하고 저장은 허용.
export type FriendlyValidation = { error: string | null; warning: string | null };
export function validateFriendly(f: FriendlySchedule): FriendlyValidation;
```

### `friendlyToCron` 매핑 규칙

| kind | 필드 | cron |
|---|---|---|
| minutes | intervalMinutes=N | `*/N * * * *` |
| hourly | intervalHours=N, minute=M | `M */N * * *` |
| daily | hour=H, minute=M | `M H * * *` |
| weekly | hour=H, minute=M, weekdays=[d…] | `M H * * d1,d2,…` |
| monthly | hour=H, minute=M, dayOfMonth=D | `M H D * *` |
| advanced | cron | (그대로) |

### `cronToFriendly` 역매핑

위 표의 패턴과 정확히 일치하면 해당 kind로 복원한다. 일치하지 않으면
`{ kind: "advanced", cron }`을 반환한다. 라운드트립(friendly→cron→friendly)은
안정적이어야 한다(테스트로 보장).

### 검증 규칙 (`validateFriendly`)

차단(`error`)은 잘못된 cron을 만들 수 있는 경우, 경고(`warning`)는 동작하지만
사용자가 알아야 하는 경우다.

- minutes: `1 ≤ intervalMinutes ≤ 59`(범위 밖 → error). 60의 약수가 아니면
  **warning**(시간 경계서 간격이 깨짐) — 동작은 허용.
- hourly: `intervalHours ∈ {1,2,3,4,6,8,12}`, `0 ≤ minute ≤ 59` (아니면 error).
- weekly: `weekdays.length ≥ 1`(0개 → error), 각 값 0–6.
- monthly: `1 ≤ dayOfMonth ≤ 28`(아니면 error).
- advanced: `validateCronExpression(cron)` 위임(메시지 있으면 error).

## 5. `cron.ts` 보강 (미리보기 헬퍼)

미리보기를 위해 다음 한 개 헬퍼만 추가한다(기존 `computeNextCronFire` 재사용):

```ts
export function nextCronFires(cron: string, count: number, from?: Date): Date[];
```

`count`회 만큼 다음 발화 시각을 반환. 잘못된 cron이면 빈 배열. 클라이언트
미리보기와 단위 테스트 양쪽에서 사용한다.

## 6. UI 컴포넌트: `webapp/components/automation/ScheduleBuilder.tsx`

`Automations.tsx`가 1,300줄+이므로 Schedule 패널을 **별도 컴포넌트로 추출**한다.

- Props:
  ```ts
  type Props = {
    schedule: AutomationJob["schedule"];          // 현재 저장 형태
    onChange: (next: AutomationJob["schedule"]) => void;
  };
  ```
- 내부 동작:
  1. 마운트/props 변경 시 `schedule`을 `FriendlySchedule`로 해석
     (`mode==="cron"` → `cronToFriendly(cron)`, `mode==="preset"` → preset→friendly
     매핑).
  2. 주기 칩 행(분마다·시간마다·매일·매주·매월·고급) 렌더.
  3. 선택된 kind에 따른 컨텍스트 필드만 렌더(switch).
  4. 변경 시 `friendlyToCron`으로 cron 생성 → `onChange`로 부모에 전달.
     부모는 `mode="cron"`, `cron=<생성값>`으로 `updateSchedule` 한다(나머지
     time/dayOfWeek/dayOfMonth 필드는 스키마 기본/기존값 유지 — `mode="cron"`일 때
     매니저가 무시함).
  5. 하단에 요약(`describeCron`) + 다음 실행 미리보기(`nextCronFires(cron, 3)`) +
     cron pill + 인라인 검증/경고 표시.
- "고급" 선택 또는 미매칭 cron 로드 시 raw cron 입력칸 노출 + 실시간
  `validateCronExpression` / `describeCron` 피드백.

### 컴포넌트 경계

- `ScheduleBuilder`: 표현 + 친절한 입력. 로직은 `schedule-format.ts`/`cron.ts`에
  위임하여 얇게 유지.
- `schedule-format.ts`: 순수 변환/검증. UI·서버 어디서나 사용 가능.
- `cron.ts`: 스케줄 계산(단일 진실 원천). 변경은 `nextCronFires` 추가뿐.

## 7. 데이터 흐름

```
사용자 입력(칩/필드)
  → FriendlySchedule (컴포넌트 로컬 상태)
  → friendlyToCron() → cron 문자열
  → onChange → 부모 updateSchedule(mode="cron", cron)
  → 저장(PUT /api/automation/jobs/:id) → config.local.json
  → 매니저 armJob → computeNextAutomationFire(cron) → setTimeout
미리보기: cron 문자열 → nextCronFires/ describeCron (클라이언트, 동기)
편집 로드: schedule → cronToFriendly/preset매핑 → FriendlySchedule
```

## 8. 에러 / 엣지 케이스 (확정)

- 빈/잘못된 cron(고급): 인라인 에러 표시 + **"Save job" 버튼 비활성**
  (`validateFriendly(...).error ≠ null`이면 저장 차단). 백엔드
  `AutomationJobBody`가 `cron.min(1)`만 보장하므로 UI 검증이 1차 방어선이다.
- weekly에서 마지막 요일 해제 시도: **마지막 1개는 해제 불가**(항상 ≥1 유지). 별도
  에러 메시지 없이 토글을 무시한다.
- minutes 비약수(예 7): **warning만** 표시하고 저장 허용.
- monthly: 입력은 1–28로 클램프(29–31 불가).
- 미매칭 cron 로드: "고급"으로 자동 전환되어 raw 표시.

저장 차단 조건 요약: `validateFriendly().error`가 non-null인 동안 "Save job"
비활성. warning은 저장을 막지 않는다.

## 9. 테스트

- `webapp/lib/automation/schedule-format.test.ts`:
  - `friendlyToCron`: 각 kind(복수 요일·분단위 포함) 정확한 cron 생성.
  - `cronToFriendly`: 대표 cron 역매핑 + 라운드트립 안정성 + 미매칭 advanced 폴백.
  - `describeCron`: 대표 패턴 사람이 읽는 문자열.
  - `validateFriendly`: error/warning 분리 검증(분 60 약수→warning vs 비약수,
    범위 밖→error, 매월 28 경계, 요일 0개→error, 잘못된 advanced cron→error).
- `webapp/lib/automation/cron.test.ts`(없으면 신설): `nextCronFires` 다음 발화
  계산.
- 게이트: `npx tsc --noEmit` + `npx vitest run lib/automation`.
- UI는 로직을 순수 모듈에 위임하므로 컴포넌트 단위 테스트는 선택(스모크 수준).

## 10. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `webapp/lib/automation/schedule-format.ts` | 신규 — 순수 매핑/검증/포맷 |
| `webapp/lib/automation/cron.ts` | `nextCronFires` 헬퍼 추가 |
| `webapp/components/automation/ScheduleBuilder.tsx` | 신규 — A형 빌더 UI |
| `webapp/components/automation/Automations.tsx` | Schedule 패널을 `ScheduleBuilder`로 교체, 변환 와이어링 |
| `webapp/lib/automation/schedule-format.test.ts` | 신규 — 단위 테스트 |
| `webapp/lib/automation/cron.test.ts` | 신규/보강 — `nextCronFires` 테스트 |

스키마(`schema.ts`/`config.ts`)·매니저·API 라우트는 변경 없음.
