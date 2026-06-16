# 주기적 정보 수집 automation job 명세 (fetch → raw → auto-ingest)

> Automations 탭(또는 `POST /api/automation/jobs`)에 그대로 입력하는 job 청사진.
> `config/local.json` 직접 편집은 프로젝트 하드룰(§9)이므로 **UI/API 경로로만** 생성한다.

## 0. 전제 설정 (한 번만)

- Settings → Automation: `automation.enabled = true`, `maxConcurrentJobs`는 동시
  실행 job 수에 맞게(기본 2).
- Settings → Auto Ingest: `autoIngest.enabled = true` — 각 job의
  `autoIngestAfterRun=true`가 성공 시 auto-ingest를 트리거하므로 이게 켜져 있어야
  raw → wiki 합성까지 이어진다.
- fetch 도구: `./setup.sh --with-automation-tools` (agent-browser + gh + yt-dlp).
  - 현재 호스트 상태: agent-browser ✅ · git ✅ · yt-dlp ✅ · **gh ❌ (수동 설치 +
    `gh auth login` 필요)**.

## 1. 데이터 흐름 / 산출물 위치

automation 에이전트는 격리 workspace(`/tmp/...`)에서 실행되고, **Markdown 리포트만**
`raw/automation/<job-slug>/<runId>/cli/<agent>/result.md`로 저장된다. 따라서:

- 원본(HTML/자막)을 보존하려면 prompt에서 **"추출한 본문/자막 핵심을 리포트에
  인용으로 인라인하라"**고 지시한다. (tmp의 다운로드 파일은 raw로 복사되지 않음)
- 매 실행마다 타임스탬프 runId가 새로 생긴다 → 매시간이면 job당 하루 24개 source.
  변동이 잦지 않으면 **매일(`0 0 * * *`)** 권장. 증분 커서는 내장되지 않으므로
  "지난 실행 이후 새 항목만" 로직이 필요하면 prompt에서 처리한다(아래 §6).

## 2. 웹 페이지 모니터링 (agent-browser, 즉시 가능)

```
name: web-monitor
template: custom
schedule.mode: cron
schedule.cron: 0 0 * * *          # 매일 00시 (매시간이면 0 * * * *)
selectedAgents: [claude]          # 또는 codex
autoIngestAfterRun: true
externalWritePolicy: draft-only   # (고정)
prompt: |
  다음 URL을 agent-browser로 열어 본문을 추출하라:
    - <URL1>
    - <URL2>
  각 페이지에 대해 Markdown으로:
    1) 제목·URL·접근 시각
    2) 핵심 요약(불릿 5~10개)
    3) 원본 보존용으로 핵심 단락을 인용(blockquote)으로 인라인
  접근 실패/차단 시 사유와 다음 액션 초안을 남겨라. 외부 시스템은 변경하지 마라.
```

## 3. Gerrit (git, 즉시 가능)

```
name: gerrit-watch
template: custom
schedule.cron: 0 * * * *          # 매시간
selectedAgents: [codex]
autoIngestAfterRun: true
prompt: |
  Gerrit 호스트 <https://gerrit.example.com>, 프로젝트 <project>의 최근 변경을
  조사하라. 가능하면 REST(`/changes/?q=...`) 또는 `git` clone 후 로그로 최근 N개
  change(기본 20)를 가져와 Markdown으로:
    - change 번호·제목·작성자·상태·업데이트 시각
    - 변경 요지와 리뷰 포인트 초안
  업로드/코멘트/투표 등 외부 상태 변경은 절대 하지 마라(draft-only).
```

## 4. GitHub (gh — 설치+인증 후 가능)

```
name: github-watch
template: github-gerrit-review     # 또는 custom
schedule.cron: 0 * * * *
selectedAgents: [codex]
autoIngestAfterRun: true
prompt: |
  `gh`로 <owner/repo>의 최근 활동을 수집하라:
    - 새 PR: gh pr list --state open --limit 30 --json number,title,author,updatedAt,url
    - 최근 릴리스: gh release list --limit 5
    - (선택) 이슈: gh issue list --state open --limit 30
  각 항목을 Markdown 표/불릿으로 정리하고, 주목할 PR은 변경 요지 초안을 덧붙여라.
  코멘트·머지·라벨 등 외부 변경은 하지 마라(draft-only).
```

전제: 호스트에 `gh` 설치 + `gh auth login` 완료. 미설치 시 job은 error로 끝나고
다음 주기에 재시도된다.

## 5. Confluence (agent-browser + SSO 영속 프로필)

인증은 **SSO**. API 토큰 대신 agent-browser의 **영속 프로필(`--profile`)에 로그인
상태를 한 번 저장**하고, cron job은 매번 그 프로필을 재사용한다. 프로필 경로는
**절대경로**로 지정한다 — automation은 격리 tmp workspace(`cwd`)에서 실행되고
safeMode면 env가 제한되므로, env(`AGENT_BROWSER_PROFILE`)가 아니라 명시적
`--profile <abs path>` 플래그를 쓰는 게 안전하다.

### 5.1 1회 SSO 로그인 (사용자가 터미널에서 직접, headed)

```bash
# headed 브라우저를 띄워 SSO(IdP 리다이렉트)까지 사람이 직접 로그인.
# 완료되면 쿠키/스토리지가 ~/.clio-confluence 프로필에 영속된다.
agent-browser --profile ~/.clio-confluence open "https://<confluence-host>/wiki"
# 로그인 확인 후:
agent-browser --profile ~/.clio-confluence close
```

CLIO 채팅 세션에서라면 `! agent-browser --profile ~/.clio-confluence open ...` 로
실행한다.

### 5.2 cron job

```
name: confluence-sync
template: custom
schedule.cron: 0 0 * * *
selectedAgents: [claude]
autoIngestAfterRun: true
prompt: |
  agent-browser를 항상 `--profile ~/.clio-confluence` 옵션과 함께 사용하라
  (저장된 SSO 세션 재사용). 절대 새 로그인 폼을 채우려 하지 마라.
  대상: Confluence space <SPACE> / 페이지 <PAGE_URL>.
  절차:
    1) agent-browser --profile ~/.clio-confluence open <PAGE_URL>
    2) 현재 URL이 IdP/login으로 리다이렉트됐는지 확인. 그렇다면 본문을 캡처하지
       말고 "SSO 세션 만료 — 5.1 재로그인 필요"만 보고하고 종료하라.
    3) 정상 접근이면 본문을 추출해 Markdown으로 요약하고, 보존용 핵심 단락을
       인용(blockquote)으로 인라인하라.
  페이지 편집·코멘트 등 외부 변경은 절대 하지 마라(draft-only).
```

### 5.3 운영 주의 — SSO 세션 만료

SSO 세션은 IdP 정책에 따라 수 시간~수 일 후 만료된다. 만료되면 job은 위 2)에서
"재로그인 필요"를 리포트하고 끝나며, 사용자가 §5.1을 다시 실행해 프로필을
갱신해야 한다. (무인 영구 인증은 불가 — 이게 SSO 방식의 본질적 한계다.)
만료 리포트도 raw로 저장되므로, auto-lint/Telegram 알림으로 빨리 알아챌 수 있다.

## 6. 증분(incremental) 처리 — 선택

매 실행이 독립적이라 중복 수집이 누적될 수 있다. 줄이려면 prompt에 한 줄 추가:

```
직전 실행 결과를 참고해 신규/변경 항목만 보고하라. 마지막 처리 기준은
wiki/sources/automation/<job-slug>/ 의 가장 최근 source 페이지 또는 본 job의
이전 raw/automation/<job-slug>/<이전 runId>/.../result.md 에서 확인하라.
변경이 없으면 "변동 없음"만 간단히 남겨라.
```

source 누적이 부담되면 주기적으로 `/preprocess`로 오래된 스냅샷을 정리한다.

## 7. 검증 순서 (job 활성화 전)

1. 도구 ready 확인 (Automations 도구 패널).
2. job을 **disabled**로 만들고 **Plan(dry-run)** 실행 → plan.md에서 에이전트가
   무엇을 fetch하는지 검토.
3. **Run now**로 1회 수동 실행 → `raw/automation/<job>/<runId>/.../result.md` 확인
   → auto-ingest가 wiki로 합성했는지 `wiki/log.md`·`wiki/sources/index.md` 확인.
4. 문제없으면 `enabled=true` + cron 활성화.
