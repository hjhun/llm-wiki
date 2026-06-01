# CLIO ↔ Telegram Bot 연동 계획서

> 작성일: 2026-06-01
> 목적: CLIO Chat 기능을 텔레그램 봇을 통해 외부에서 질문/응답 받을 수 있도록 연동
> 산출물 목표: Bot Token을 Settings > Telegram 탭에서 관리, 허용된 chat에서 보낸 메시지를 webapp의 wiki-query 파이프라인에 흘려 보내고 답을 회신

---

## 1. 한 줄 요약

CLIO webapp에 백엔드 텔레그램 polling worker를 추가해서, 허용된 chat에서 들어오는 메시지를 기존 `runPublicQuery()` 파이프라인 (또는 인증된 사용자 chat용 별도 파이프라인)으로 라우팅한 뒤 답을 텔레그램으로 회신합니다. Bot Token, allowlist, 동작 모드 등은 Settings > Telegram 새 탭에서 관리합니다.

---

## 2. 사용 시나리오

1. 관리자가 BotFather에서 봇을 만들어 Bot Token을 얻는다.
2. CLIO webapp의 Settings > Telegram 탭에서 토큰을 붙여넣고 Enable 토글.
3. webapp이 백그라운드에서 텔레그램 getUpdates를 long-polling.
4. 외부 사용자가 텔레그램에서 봇과 1:1 대화 또는 그룹에서 멘션.
5. 첫 메시지는 "pending approval" 상태로 Settings에 알림이 뜨고, 관리자가 chat 단위로 승인.
6. 승인된 chat에서 보낸 메시지는 자동으로 `/query <message>`로 해석되어 처리되고, CLIO 답변이 텔레그램에 회신된다.
7. 모든 처리 기록은 `sessions/<YYYY-MM-DD>/<HHMMSS>_telegram_<chat_id>.md`에 남는다.

---

## 3. 의존성 + 기존 자산 활용

| 자산 | 사용 방식 |
|---|---|
| `webapp/lib/public-query.ts` | 외부 입구 → /query 파이프라인. wiki-only 모드. 텔레그램 기본 모드와 동일한 안전 모델. |
| `webapp/lib/public-session-log.ts` | 외부 호출 로깅 패턴. 텔레그램용으로 새 kind 추가. |
| `webapp/lib/auto-ingest/manager.ts`, `webapp/lib/auto-lint/runtime-state.ts` | 장기 백그라운드 워커 + state.json 패턴. 텔레그램 polling worker도 같은 구조 차용. |
| `webapp/lib/config.ts` (zod schema) | `auth`, `publicQuery` 옆에 `telegram` 섹션 추가. |
| `webapp/components/settings/Settings.tsx` (`SettingsTabId`) | "telegram" 탭 추가, AutoIngest/AutoLint 패널과 같은 패턴. |
| `webapp/instrumentation-node.ts` | Next.js 서버 시작 시 telegram manager start hook. |

새 의존성 없음. 텔레그램 Bot API는 fetch로 직접 호출 (현재 표준 `fetch`만으로 충분).

---

## 4. 설정 스키마 (`webapp/lib/config.ts`)

```ts
telegram: z
  .object({
    enabled: z.boolean().default(false),
    botToken: z.string().nullable().default(null),
    mode: z.enum(["polling", "webhook"]).default("polling"),
    /** webhook 모드일 때 외부에서 호출 가능한 공개 URL. */
    webhookPublicUrl: z.string().nullable().default(null),
    /** 텔레그램이 우리에게 webhook을 보낼 때 secret_token 헤더 값. */
    webhookSecret: z.string().nullable().default(null),
    allowlist: z
      .array(
        z.object({
          chatId: z.number(),
          kind: z.enum(["private", "group", "channel"]),
          label: z.string().default(""),
          /** "query": 읽기 전용 /query만 허용. "trusted": /lint, /preprocess --dry-run 까지. */
          permission: z.enum(["query", "trusted"]).default("query"),
          approvedAt: z.string(),
        }),
      )
      .default([]),
    /** 첫 접촉 시 자동으로 추가되어 관리자 승인을 기다리는 목록. */
    pending: z
      .array(
        z.object({
          chatId: z.number(),
          kind: z.enum(["private", "group", "channel"]),
          label: z.string().default(""),
          firstSeenAt: z.string(),
          lastMessagePreview: z.string().default(""),
        }),
      )
      .default([]),
    /** chat당 기억하는 최근 메시지 페어 수. */
    historyTurns: z.number().int().min(0).max(50).default(6),
    /** 응답 한 번에 보낼 수 있는 최대 문자 수. 4096 이하. */
    replyMaxChars: z.number().int().min(200).max(4096).default(3500),
    /** 모르는 chat에서 첫 메시지를 받았을 때 회신할 안내문. */
    rejectionMessage: z
      .string()
      .default(
        "이 봇은 승인된 chat에만 응답합니다. 관리자에게 chat ID 승인 요청을 보내주세요.",
      ),
  })
  .default({
    enabled: false,
    botToken: null,
    mode: "polling",
    webhookPublicUrl: null,
    webhookSecret: null,
    allowlist: [],
    pending: [],
    historyTurns: 6,
    replyMaxChars: 3500,
    rejectionMessage:
      "이 봇은 승인된 chat에만 응답합니다. 관리자에게 chat ID 승인 요청을 보내주세요.",
  }),
```

`botToken`은 `config/local.json`에만 저장 (절대 git tracked 파일에 들어가지 않게 `loadConfig` 머지 우선순위 그대로).

---

## 5. 백엔드 컴포넌트

### 5.1 `webapp/lib/telegram/types.ts`
- 텔레그램 Bot API 응답 타입 (`Update`, `Message`, `Chat`, `User` 등)
- 내부 도메인 타입: `TelegramIncoming`, `TelegramReply`

### 5.2 `webapp/lib/telegram/api.ts`
- `getUpdates(offset, timeout)`: long-polling 호출.
- `sendMessage(chatId, text, opts)`: 답변 송신, MarkdownV2 escape 처리.
- `setWebhook(url, secretToken)`, `deleteWebhook()`: webhook 모드 진입/이탈.
- 각 호출은 `fetch` + zod validation.

### 5.3 `webapp/lib/telegram/manager.ts`
- 싱글톤 manager (auto-ingest manager 패턴 참고).
- `start(config)`: enable + token 있으면 polling loop 시작.
- `stop()`: loop 정지.
- `reload(config)`: 토큰/모드 변경 시 깔끔히 stop 후 start.
- 내부 상태: 마지막 `update_id`, 진행 중 호출 수, 마지막 에러.
- 동시 처리 제한: chat당 in-flight 1개, 전역 동시 처리는 `agent.orchestration.maxConcurrentAgents`와 분리한 별도 cap (기본 2).

### 5.4 `webapp/lib/telegram/router.ts`
- 들어온 메시지를 해석:
  - bot mention / private chat → 정상 라우팅
  - `/start`, `/help` 같은 텔레그램 내장 명령 → 정적 응답
  - allowlist 미등록 chat → 거절 + pending 큐에 추가
  - 텍스트 본문 → `runPublicQuery` 입력으로 변환
  - 슬래시 명령 `/lint`, `/preprocess` 등은 permission=trusted일 때만 별도 분기

### 5.5 `webapp/lib/telegram/runtime-state.ts`
- `wiki/.progress/telegram/state.json`에 `lastUpdateId`, 통계 (총 처리 수, 마지막 에러 시각) 영속.
- LRU per-chat history는 메모리 상주 + 충돌 처리.

### 5.6 `webapp/lib/telegram/handlers.ts`
- `dispatchIncoming(msg)`:
  - 새 chat이면 pending에 추가하고 거절 회신.
  - 승인된 chat이면 `runPublicQuery(text, history)`에 위임.
  - 답변을 `splitForTelegram` (4096자/줄/코드블록 우호적 분할)로 자르고 순차 송신.
  - 모든 시도를 `appendPublicSessionLog`의 텔레그램 변형에 기록.

### 5.7 `webapp/instrumentation-node.ts` 수정
- 서버 부팅 시 `telegramManager.start(await loadConfig())` 호출.
- `loadConfig` watcher가 있다면 reload 트리거 연결.

---

## 6. API 라우트

| Method | Path | 권한 | 용도 |
|---|---|---|---|
| `GET` | `/api/telegram/status` | session 또는 cliToken | 워커 상태, pending, 마지막 처리 시각 |
| `POST` | `/api/telegram/test` | session | 토큰 유효성 검증 (getMe 호출 결과 반환) |
| `POST` | `/api/telegram/approve` | session | `{ chatId, permission }` → pending → allowlist |
| `POST` | `/api/telegram/revoke` | session | allowlist에서 제거 |
| `POST` | `/api/telegram/webhook` | secret_token header | webhook 모드에서 텔레그램이 호출 |
| `POST` | `/api/telegram/reload` | session | manager 재기동 |

webhook 모드에서는 `/api/telegram/webhook` 라우트가 `dispatchIncoming`을 직접 호출.

---

## 7. UI: Settings > Telegram 탭

### 7.1 탭 추가
- `SettingsTabId` 유니온에 `"telegram"` 추가.
- `settingsTabs` 메모에 객체 추가: `{ id: "telegram", label: t.settings.settingsTabTelegram, description: ... }`.
- 라벨 i18n 키 추가: `settingsTabTelegram`, `settingsTabTelegramDesc` (ko/en).

### 7.2 컴포넌트 `TelegramPanel.tsx`
구역:

1. **Enable / Token**
   - Bot Token 입력 (`type="password"`, 좌측 토글로 마스킹 해제)
   - "토큰 검증" 버튼 → `/api/telegram/test`로 getMe, 봇 username/이름 보여줌
   - Enable 토글 (저장 시 manager 재기동)

2. **Mode**
   - Radio: Polling (기본) / Webhook
   - Webhook 선택 시 Public URL, secret 입력 + "텔레그램에 setWebhook" 버튼

3. **Allowlist**
   - 표: chatId, kind, label, permission, approvedAt, 액션(Revoke)
   - 라벨 인라인 편집

4. **Pending Approvals**
   - 표: chatId, kind, lastMessagePreview, firstSeenAt
   - 각 행에 "Approve as query" / "Approve as trusted" / "Reject" 버튼
   - 승인 시 `/api/telegram/approve` 호출

5. **응답 정책**
   - `historyTurns`, `replyMaxChars`, `rejectionMessage` 슬라이더/입력
   - "리셋된 컨텍스트" 버튼 (옵션)

6. **상태 모니터**
   - 현재 last update_id, 마지막 처리 메시지 시각, 마지막 에러
   - "지금 한 번 polling" 디버그 버튼

### 7.3 i18n
ko/en 각각 키 약 12개 추가. 기존 i18n 패턴 (AutoIngestPanel 참고).

---

## 8. 보안 모델

1. **첫 접촉 = 자동 거부**: allowlist에 없으면 즉시 거절 회신 + pending에 1회만 등록 (중복 등록 차단).
2. **승인 권한 단위**: chat ID 별. private chat은 user id와 같지만 group/channel은 음수. UI에서 kind를 함께 표시해 혼동 방지.
3. **permission 단계**:
   - `query`: `runPublicQuery` 경로만. wiki 읽기 + 외부 lookup은 `publicQuery.allowExternalLookup` 그대로 따른다.
   - `trusted`: 추가로 `/lint`, `/preprocess --dry-run`, `/query --save` 허용 가능. 단 `/ingest`, `/lint --fix`, `/preprocess --apply` 같은 mutation은 절대 허용하지 않는다.
4. **봇 토큰 노출 방지**: API 응답에 토큰 절대 포함하지 않음. UI는 마스킹된 상태로 표시, "지금 토큰 보기"는 별도 권한 확인 1회만.
5. **rate limit**: chat당 60초 내 5건 초과 시 throttle. 전역적으로 동시 처리는 manager의 in-flight cap.
6. **세션 격리**: 텔레그램 chat마다 독립된 conversationId. wiki에는 영향을 주지 않는 `runPublicQuery` 기본 동작 그대로 (writes 없음).
7. **로그 위치**: `sessions/<YYYY-MM-DD>/<HHMMSS>_telegram_<chatId>.md` 마크다운으로 남김. 기존 `appendPublicSessionLog`와 동일한 구조.

---

## 9. 메시지 형식 매핑

| 들어온 형태 | 처리 |
|---|---|
| 평문 텍스트 | `/query <text>` 로 라우팅 |
| `/start` | 정적 안내 (이 봇이 누구인지, 승인 절차) |
| `/help` | 사용 가능한 명령 목록 |
| `/whoami` | 발신자 chatId 표시 (승인 신청용) |
| `/reset` | per-chat history 초기화 |
| `/lint`, `/preprocess --dry-run`, `/query --save` (permission=trusted만) | 내부 처리 후 결과 반환 |
| 그 외 슬래시 | "지원되지 않습니다" |
| 사진/파일 첨부 | 1단계에서는 무시 + 안내 ("텍스트만 지원"). 2단계에서 첨부 처리 추가. |

답신 분할: 4096자 한계를 고려해 줄/코드블록 경계에서 자르고 `(1/3) ...` 페이지네이션 마커 추가. MarkdownV2를 기본으로 하되 escape 실패 시 plain text로 폴백.

---

## 10. 구현 단계 (마일스톤)

### M1 — 스키마 + Settings UI 기반
- config.ts에 `telegram` 섹션 추가, defaults 머지.
- Settings tab 라벨, 빈 패널 컴포넌트, i18n 키.
- `/api/telegram/test` 라우트 (getMe)와 Settings의 토큰 검증 버튼.
- 출구: 사용자가 토큰을 저장하고 검증할 수 있다. 봇은 아직 메시지를 받지 않는다.

### M2 — Polling worker + 라우팅 코어
- `telegram/manager.ts` polling loop, `runtime-state.ts`, `router.ts`, `handlers.ts`.
- `instrumentation-node.ts`에서 start.
- `dispatchIncoming`이 allowlist 검사 → 거절 또는 `runPublicQuery` 호출 → `sendMessage`로 회신.
- pending 자동 등록.
- 출구: 관리자 본인 chat에서 메시지를 보내면 ① pending에 등록되고 ② 거절 회신이 온다.

### M3 — Allowlist 관리 UI
- `/api/telegram/{approve,revoke}` 라우트.
- Settings TelegramPanel의 Pending/Allowlist 표.
- 출구: 관리자가 본인을 승인한 뒤 평문 메시지를 보내면 정상 응답이 온다.

### M4 — 응답 정책 + 정밀화
- 응답 분할/MarkdownV2 escape.
- chat별 history 메모리 LRU + `/reset` 명령.
- rate limit, 동시 처리 cap.
- 정적 명령 (`/start`, `/help`, `/whoami`) 응답.
- 출구: 긴 답변이 자연스럽게 페이지네이션되어 도착하고, 빠른 연속 호출이 throttle된다.

### M5 — Webhook 모드 (선택)
- `setWebhook` 자동 처리, `/api/telegram/webhook` 라우트.
- 모드 전환 시 polling 중단/재개 로직.
- 출구: 외부 노출된 공개 URL이 있는 환경에서 webhook으로 전환 가능.

### M6 — Trusted 명령 + 로깅 강화 (선택)
- permission=trusted 분기에서 `/lint`, `/preprocess --dry-run`, `/query --save` 허용.
- 세션 로그 보강, Settings 상태 모니터에 처리량/에러 카운터.
- 출구: 신뢰된 사용자가 텔레그램에서 lint 트리거하고 결과를 받을 수 있다.

각 M마다 type/lint/CI 통과 + 별도 commit.

---

## 11. 테스트 전략

- **유닛**: `router.dispatchIncoming` (allowlist 분기, pending 중복 차단, slash 명령 매핑)
- **유닛**: 응답 분할 (`splitForTelegram`) — 4096 경계, 코드블록 안 자르기, 페이지네이션 마커
- **통합 (mock 텔레그램)**: `manager` polling loop이 fake `getUpdates` 서버에 대해 정상 cursor 진행 + dispatch 호출
- **수동 e2e**: BotFather에서 임시 봇 만들고 M2/M3 검증 (개발자가 별도 wiki 인스턴스에서)
- **회귀**: 새 패널 toggle 후 기존 Settings 페이지 동작 정상 확인

---

## 12. 위험과 완화

| 위험 | 완화 |
|---|---|
| 봇 토큰 유출 → 외부 누구나 봇 사용 | allowlist 강제, 첫 접촉 자동 거부, 봇 username 노출 최소 |
| 텔레그램 polling이 stuck → CLIO chat에 영향 | manager에서 chat 처리와 polling은 독립 스레드, getUpdates timeout 30초, 무한 재시도 backoff |
| 큰 wiki에서 runPublicQuery cold start 수 분 | "받았어요" 메시지 즉시 회신 + 답변 도착 시 update_message |
| 텔레그램 답변 길이 초과로 잘림 | replyMaxChars로 자르되 마지막에 "... (truncated)" 명시 + 원본은 세션 로그에 보관 |
| webhook 모드에서 secret 누락 시 spoofing | `X-Telegram-Bot-Api-Secret-Token` 검증 강제 |
| 다중 webapp 인스턴스에서 polling 중복 | manager가 시작 시 lock 파일 검사 (`wiki/.progress/telegram/.lock`) 후 stale이면 takeover |

---

## 13. 향후 확장 후보

- **인라인 키보드**: 답변 끝에 "Save to wiki/answers/..." 버튼을 인라인 키보드로 제공 → 텔레그램에서 클릭하면 `/query --save` 트리거.
- **그룹 멘션 모드**: 그룹에서 봇 멘션 또는 reply만 처리.
- **첨부 ingest**: 텔레그램으로 보낸 파일/사진을 `raw/chat/<date>/` 외부 캡처로 자동 저장 (browser-capture 스킬 패턴 차용).
- **다중 봇**: 여러 봇 token을 라벨별로 관리해서 워크스페이스별 분리.
- **TeleAdmin 명령**: 봇 owner에게만 노출되는 메타 명령(`/stat`, `/pending` 등).

---

## 14. 코드 진입점 요약 (구현 시 참고)

```
webapp/
├── lib/
│   ├── config.ts                      # telegram 섹션 추가
│   ├── telegram/                      # 신규 디렉터리
│   │   ├── api.ts                     # getUpdates/sendMessage fetch wrapper
│   │   ├── handlers.ts                # dispatchIncoming, runPublicQuery 위임
│   │   ├── manager.ts                 # singleton polling/webhook worker
│   │   ├── router.ts                  # 메시지 → 명령/text 분류
│   │   ├── runtime-state.ts           # lastUpdateId 영속
│   │   ├── splitter.ts                # 응답 분할
│   │   └── types.ts
│   └── public-session-log.ts          # 텔레그램 kind 추가
├── instrumentation-node.ts            # manager.start() 훅
├── app/
│   └── api/telegram/
│       ├── status/route.ts
│       ├── test/route.ts
│       ├── approve/route.ts
│       ├── revoke/route.ts
│       ├── reload/route.ts
│       └── webhook/route.ts           # webhook 모드용
└── components/settings/
    ├── Settings.tsx                   # tab 추가
    └── TelegramPanel.tsx              # 신규
```

---

## 15. 결정 필요 항목 (착수 전 확인)

1. **기본 응답 파이프라인**: `runPublicQuery` (간단, wiki-only) vs 새 `runChatQuery` (인증된 chat용, history/save 가능)?
   - 추천: M1~M3은 `runPublicQuery` 기반. M6에서 trusted permission용 새 파이프라인 추가.
2. **history 저장 위치**: 메모리 only vs `wiki/.progress/telegram/history/<chatId>.json` 영속?
   - 추천: 메모리 + LRU. 재기동 시 손실 허용. 보관 가치가 없는 단발 질의가 대부분.
3. **chat 승인 절차**: pending → 관리자 UI 클릭 only vs `/whoami` 명령으로 chat ID 받아 관리자가 텔레그램에서 자기 봇에게 명령으로 승인?
   - 추천: M3에서 UI만. M6에서 텔레그램 관리자 명령 추가.
4. **여러 webapp 인스턴스 (LAN 공유)**: 동시 polling 처리?
   - 추천: lock 파일 + 단일 leader 선출. 다른 인스턴스는 standby.
5. **외부 lookup 정책**: `publicQuery.allowExternalLookup`을 그대로 따를지 텔레그램용 별도 토글?
   - 추천: 별도 토글 (`telegram.allowExternalLookup`) — 텔레그램 사용자에게 외부 쿼리를 열어주는 결정은 publicQuery보다 더 보수적이어야 함.

---

## 16. 이 계획서가 답하지 못한 것

- 텔레그램 Bot API의 specific rate limit 회피 정책 (전역 30 msg/s, chat당 1 msg/s). 구현 시 구체적인 큐 정책 결정 필요.
- 다국어 사용자 (텔레그램 영어/한국어 혼합) 응답 언어 결정 (config 고정 vs 메시지 자동 감지).
- 인라인 키보드/메뉴는 별도 디자인 작업 필요.

---

작성 끝. 검토 후 진행할 마일스톤 / 결정 항목 답을 알려주시면 구현에 들어가겠습니다.
