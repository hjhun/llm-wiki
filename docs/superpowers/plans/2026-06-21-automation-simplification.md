---
title: CLIO Automations 단순화 계획
type: plan
updated: 2026-06-21
---

# CLIO Automations 단순화 계획

## 배경

현재 Automations는 자연어 prompt를 분석해 여러 coding agent CLI가 격리 workspace에서 `plan` 또는 `run`을 수행하는 모델이다. 이 구조는 실험적 agent 작업에는 유연하지만, 실제 주기 자동화에는 다음 문제가 있다.

- 사용자가 스케줄을 만들 수는 있지만, 예약 전에 "이 작업이 실제로 성공한다"는 검증 기준이 약하다.
- `Dry-run verify`는 실제 자동화 코드의 테스트라기보다 agent가 plan을 생성하는 경로에 가깝다.
- UI가 prompt builder, template, agent 선택, workspace, schedule, artifact viewer를 한 화면에 함께 보여 주어 운영자가 이해해야 할 개념이 많다.
- 반복 자동화의 핵심인 입력, 실행 코드, output 파일, log 파일, exit code, 테스트 결과가 job의 1급 개념으로 드러나지 않는다.

따라서 Automations의 기본 모델을 "에이전트가 매번 무엇을 할지 추론하는 예약 작업"에서 "검증된 script/code를 정해진 주기로 실행하는 작업"으로 단순화한다.

## 목표

1. 사용자는 자동화 job마다 실행할 script 또는 command를 명시한다.
2. job에는 schedule, working directory, output file, log file, timeout, environment allowlist를 설정한다.
3. 저장 또는 enable 전에 테스트 실행이 통과해야 한다.
4. 예약 실행은 테스트를 통과한 실행 정의만 사용한다.
5. agent 기반 prompt automation은 기본 흐름에서 제거하거나 Advanced/Legacy 영역으로 분리한다.
6. 설치된 agent CLI의 실제 기능은 `codex -h`, `codex exec -h`, `claude -h`, `claude -p -h` 같은 로컬 help 출력으로 감지한다.

## 비목표

- 임의의 외부 시스템에 쓰기 권한을 자동 부여하지 않는다.
- 자연어 prompt만으로 바로 예약 job을 생성하는 흐름을 기본값으로 유지하지 않는다.
- 첫 단계에서 복잡한 DAG, 의존성 그래프, retries policy, distributed worker를 만들지 않는다.
- `raw/`, `wiki/` 운영 규칙과 ingest/query/lint skill 동작을 변경하지 않는다.

## 권장 접근

권장안은 Script-first automation이다.

Automation job은 다음 필드를 중심으로 재정의한다.

- `name`: 표시 이름
- `enabled`: 예약 활성화 여부
- `command`: 실행 명령 또는 script path
- `args`: 선택적 인자 목록
- `cwd`: 작업 디렉터리
- `schedule`: 기존 preset/cron/timezone 모델 재사용
- `outputPath`: 성공 산출물 위치
- `logPath`: stdout/stderr 로그 위치
- `timeoutMs`: 실행 제한 시간
- `lastTest`: 마지막 테스트 실행의 status, exit code, started/ended time, output/log 경로
- `requiresPassingTest`: 기본값 `true`

이 방식은 기존 scheduler, runtime state, artifact root를 재사용하면서도 사용자가 이해하는 자동화 단위가 훨씬 명확하다. 기존 prompt/agent job은 `kind: "agent"`로 남기거나, UI에서 Legacy로 접어 둔다.

Agent CLI를 호출하는 Advanced/Legacy job은 문서에 적힌 일반 기능을 그대로 가정하지 않는다. CLIO가 실행 환경에서 직접 help 출력을 수집해 버전별 옵션 차이를 확인하고, 지원되는 invocation shape만 UI와 runner에 노출한다.

## 대안 비교

### A. UI만 단순화

현재 backend 모델은 유지하고 화면에서 일부 패널만 숨긴다.

장점은 구현이 빠르다는 점이다. 단점은 핵심 문제인 "실행 전 검증 부족"이 해결되지 않는다.

### B. Script-first 모델

job의 기본 단위를 command/script로 바꾸고 테스트 통과를 enable 조건으로 삼는다.

장점은 실제 운영 자동화에 맞고, 실패 원인과 로그가 명확하다는 점이다. 단점은 기존 prompt builder와 agent runner를 호환 처리해야 한다.

### C. Test-first code generator

사용자가 목표를 쓰면 CLIO가 test를 먼저 만들고, 통과하는 script를 생성한 뒤 예약한다.

장점은 장기적으로 가장 강력하다. 단점은 범위가 크고, 생성된 코드의 신뢰성/보안/권한 모델을 먼저 설계해야 한다. 2단계 이후 기능으로 미룬다.

## UX 설계

Automations 첫 화면은 세 영역으로 줄인다.

1. Job list
   - 이름, enabled, last test status, next run, last run status만 표시한다.

2. Job editor
   - Script/Command
   - Schedule
   - Output and logs
   - Timeout
   - Enable toggle

3. Test and run panel
   - `Test now`
   - `Run once`
   - 최근 테스트 결과
   - 최근 실행 로그 링크

`Enable`은 마지막 테스트가 성공하지 않았으면 비활성화한다. 사용자가 강제로 저장은 할 수 있지만, 예약 활성화는 막는다.

## 실행 흐름

### 저장

1. API가 job body를 검증한다.
2. command/script path, cwd, outputPath, logPath가 repository 또는 허용된 경로 정책을 만족하는지 검사한다.
3. schedule cron이 유효한지 검사한다.
4. job은 disabled 상태로 저장할 수 있다.
5. enabled 상태로 저장하려면 `lastTest.status === "success"`가 필요하다.

### 테스트

1. `POST /api/automation/jobs/:id/test`가 command를 한 번 실행한다.
2. stdout/stderr는 configured logPath와 artifact path에 모두 저장한다.
3. exit code 0이면 success로 기록한다.
4. outputPath가 설정되어 있으면 파일 존재 여부를 검사한다.
5. 결과를 runtime state와 job의 `lastTest`에 기록한다.

### 예약 실행

1. scheduler는 enabled job만 발화한다.
2. 실행 직전에 `requiresPassingTest`와 `lastTest`를 다시 확인한다.
3. 조건을 만족하지 않으면 run을 skip하고 reason을 기록한다.
4. 실행 결과는 기존 `progress/automation/artifacts/<job>/<run>/`에도 기록한다.
5. configured output/log path가 있으면 해당 위치에도 기록한다.

### CLI 기능 감지

1. CLIO는 automation 상태 조회 또는 도구 refresh 시 `codex -h`, `codex exec -h`, `claude -h`, `claude -p -h` 등 안전한 help 명령을 실행한다.
2. help 출력에서 non-interactive 실행 방식, JSON/stream 출력, sandbox/permission flag, session/resume flag, model flag, timeout에 영향을 주는 flag를 감지한다.
3. 감지 결과는 `progress/automation/tool-capabilities.json` 같은 runtime cache에 저장한다.
4. runner는 hard-coded 가정보다 capability cache를 우선한다. 예를 들어 어떤 설치본에서 `cline`이 `--id`와 positional prompt를 쓰면 그 형태를 따른다.
5. 감지 실패 시 해당 CLI는 automation target으로 표시하되, save/test/run 단계에서 "capability unknown" 경고를 보여 주고 실행 전 테스트를 필수로 유지한다.

## 구현 단계

### 1단계: 스키마와 runner 분리

- `webapp/lib/automation/schema.ts`에 script job body를 추가한다.
- 기존 job은 `kind: "agent"`로 호환하고 새 job은 `kind: "script"`로 둔다.
- `webapp/lib/automation/runner.ts`를 `runAgentAutomationJob`과 `runScriptAutomationJob`으로 나눈다.
- script runner는 shell 문자열을 직접 해석하기보다 command + args 배열을 우선 지원한다.

### 2단계: 테스트 게이트

- `POST /api/automation/jobs/:id/test`를 추가한다.
- test 결과를 `progress/automation/state.json`에 기록한다.
- `POST/PUT /api/automation/jobs`에서 enabled 저장 시 마지막 테스트 성공 여부를 검증한다.
- scheduler `trigger()`에서도 테스트 통과 여부를 한 번 더 확인한다.

### 3단계: CLI capability 감지

- `webapp/lib/automation/tools.ts`에 help 기반 capability detector를 추가한다.
- `codex`, `claude`, `agy`, `cline`별 help 명령과 timeout을 정의한다.
- detector 결과에 non-interactive command shape, output mode, sandbox flag, model flag, resume/session support를 기록한다.
- 기존 tools panel은 설치 여부뿐 아니라 "automation-ready" 여부와 감지된 실행 형태를 보여 준다.

### 4단계: UI 단순화

- `webapp/components/automation/Automations.tsx`에서 기본 화면을 script job editor 중심으로 재구성한다.
- Build from prompt, templates, selected agents는 Advanced/Legacy 섹션으로 접거나 일시적으로 숨긴다.
- job card에는 last test, next run, last run만 표시한다.
- action은 Save, Test now, Run once, Delete로 제한한다.

### 5단계: 문서와 마이그레이션

- `docs/GUIDE.md`와 `docs/GUIDE_ko.md`의 Automations 섹션을 script-first 모델로 갱신한다.
- 기존 agent job은 그대로 로드되도록 유지하되 새 UI에서는 Legacy로 표시한다.
- `config/default.json`은 기존 기본값을 유지하되 새 job 예시는 문서에만 둔다.

## 테스트 계획

- 스키마 단위 테스트
  - script job 필수 필드 누락 시 실패
  - invalid cron 실패
  - enabled 저장 시 last test 없으면 실패

- runner 단위 테스트
  - 성공 command의 stdout/stderr/output/log 저장 확인
  - 실패 command의 exit code와 error 기록 확인
  - timeout 발생 시 프로세스 종료와 timeout reason 기록 확인

- manager 테스트
  - 테스트 미통과 enabled job은 cron trigger에서 skip
  - 테스트 통과 job은 기존 schedule/catch-up 경로에서 실행
  - maxConcurrentJobs와 inFlight guard 유지

- capability detector 테스트
  - fixture help 출력에서 `codex exec`, `claude -p`, `cline -y` 실행 형태 감지
  - 알 수 없는 help 출력이면 unsupported가 아니라 `unknown`으로 기록
  - detector 실패가 전체 automation status API를 실패시키지 않음

- UI 검증
  - 새 job 생성 -> Test now 실패 -> Enable 불가
  - Test now 성공 -> Enable 가능 -> Run once 결과 확인
  - Legacy agent job이 깨지지 않고 읽기/실행 가능

## 위험과 대응

- Shell injection 위험
  - 기본 입력은 command + args 배열로 받고, raw shell mode는 Advanced로 제한한다.

- 경로 혼동
  - output/log path는 상대 경로를 repository root 기준으로 정규화하고, 절대 경로는 명시적으로 허용된 경우만 받는다.

- 기존 agent job 호환성
  - 마이그레이션 없이 `kind` 기본값을 `agent`로 추론해 기존 설정을 읽는다.

- CLI 버전별 옵션 차이
  - 로컬 help 출력 기반 capability detector를 사용하고, 감지 결과와 실제 테스트 실행 결과를 artifact에 함께 남긴다.

- 테스트가 오래 걸리는 자동화
  - test timeout을 job timeout과 별도로 둘 수 있게 하되, 첫 구현에서는 동일 timeout을 사용한다.

## 완료 기준

- 새 script automation job을 만들고 테스트 통과 후에만 enable할 수 있다.
- 예약 실행은 테스트 미통과 job을 실행하지 않고 skip reason을 남긴다.
- output/log 파일 위치를 UI에서 설정하고 실행 후 확인할 수 있다.
- 설치된 `codex`, `claude`, `agy`, `cline`의 automation 실행 가능 여부를 help 출력 기반으로 표시한다.
- 기존 agent 기반 automation job은 설정 파일을 깨뜨리지 않고 유지된다.
- 관련 단위 테스트와 최소 1개 UI smoke test가 통과한다.
