"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Language = "ko" | "en";

export const BRAND_NAME = "CLIO - LLM WIKI";

export const TEXT = {
  ko: {
    common: {
      loading: "불러오는 중...",
      refresh: "새로고침",
      save: "저장",
      saved: "저장됨",
      saving: "저장 중...",
      edit: "편집",
      preview: "미리보기",
      download: "다운로드",
      cancel: "취소",
      delete: "삭제",
      language: "언어",
      korean: "한국어",
      english: "English",
    },
    sidebar: {
      local: "local",
      tabs: {
        chat: { label: "Chat", desc: "코딩 에이전트와 대화" },
        explorer: { label: "Explorer", desc: "wiki/raw 탐색" },
        graph: { label: "Knowledge Graph", desc: "지식 그래프" },
        settings: { label: "Settings", desc: "CLI · 비밀번호" },
      },
      collapse: "내비게이션 접기",
      expand: "내비게이션 펼치기",
      logout: "로그아웃",
      loggingOut: "로그아웃 중...",
      languageSaving: "저장 중",
      localOnlyPrefix: "이 인스턴스는",
      localOnlyEmphasis: "LAN 공유",
      localOnlySuffix: "입니다.",
      defaultBind: "기본 bind",
    },
    chat: {
      newTitle: "새 채팅",
      pendingPath: "메시지를 보내면 세션이 생성됩니다",
      deleteConfirm: (count: number) =>
        `${count}개 세션을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
      guideTitle: "시작 가이드",
      guideFreeQuestion: "자유 질문 또는 슬래시 커맨드:",
      guideSessions: "세션 md는 sessions/<date>/에 자동 저장됩니다.",
      guideAgent:
        "에이전트는 호스트 PC의 codex / claude / gemini / cline 중 Settings에서 지정한 것을 사용합니다.",
      processing: "처리 중...",
      progressTitle: "진행 상황",
      progressWaiting: "진행 상태를 기다리는 중...",
      empty: "_(empty)_",
      commands: "명령",
      commandMenu: "명령 메뉴",
      send: "전송",
      placeholder:
        "질문을 입력하거나 /ingest, /query, /lint ...  (Shift+Enter로 줄바꿈)",
      hint: "Enter 전송 · Shift+Enter 줄바꿈 · `/`로 슬래시 커맨드 자동완성",
      slashCommands: [
        { name: "/ingest", arg: "<path|url>", desc: "raw의 자료를 위키로 흡수 (1 sub-chunk)" },
        {
          name: "/ingest-loop",
          arg: "<path|url>",
          desc: "leaf를 순차적으로 자동 반복 ingest (Stop으로 중단 가능)",
        },
        { name: "/query", arg: "<질문>", desc: "위키 검색 + 답변 작성" },
        { name: "/lint", arg: "", desc: "위키 건강 점검" },
      ],
      stopLoop: "Stop loop",
      stopping: "Stopping...",
      stopLoopHint: "현재 sub-chunk가 끝나면 ingest-loop를 멈춥니다.",
      newChat: "+ New Chat",
      clear: "Clear",
      selectAll: "Select all",
      deleting: "Deleting...",
      delete: "Delete",
      noSessions: "아직 세션이 없습니다.",
      selectSession: (title: string) => `${title} 선택`,
    },
    explorer: {
      workspaces: {
        wiki: "LLM이 유지하는 위키 (편집 가능)",
        raw: "원본 자료 (사용자 추가, LLM은 읽기만)",
        sessions: "채팅 세션 기록 (시스템 append-only, 읽기 전용)",
      },
      readOnlyError: "sessions/는 UI에서 수정할 수 없습니다.",
      uploadBlocked: "sessions/는 업로드 불가",
      newFilePath: "새 파일 경로",
      newFolderPath: "새 폴더 경로",
      newPath: "새 경로",
      deleteConfirm: (path: string) => `${path}를 .trash/로 이동할까요?`,
      deleteTitle: "삭제",
      upload: "업로드",
      uploadFolder: "폴더 업로드",
      busy: (name: string) => `· ${name}...`,
      rawHintPrefix: "raw/에 자료를 떨군 뒤 Chat 탭의",
      rawHintSuffix: "로 위키에 반영하세요.",
      newRootFile: "새 파일 (루트)",
      newRootFolder: "새 폴더 (루트)",
      fileButton: "+ 파일",
      folderButton: "+ 폴더",
      actions: {
        newFile: "새 파일",
        newFolder: "새 폴더",
        uploadFile: "파일 업로드",
        uploadFolder: "폴더 업로드",
        rename: "이름 변경",
        delete: "삭제",
      },
      empty: "비어 있음",
      selectFile: "좌측에서 파일을 선택하세요.",
      directory: "폴더입니다. 좌측 트리에서 자식을 펼쳐주세요.",
      modified: "수정",
      readOnly:
        "이 워크스페이스는 UI 편집이 잠겨 있습니다 (sessions/는 시스템이 append-only로 관리).",
      binary: "텍스트로 열 수 없는 파일입니다.",
    },
    graph: {
      title: "Knowledge Graph",
      refresh: "Refresh",
      update: "Update",
      updating: "Updating...",
      build: "Build",
      building: "Building...",
      nodes: "Nodes",
      edges: "Edges",
      communities: "Communities",
      updated: "Updated",
      runSummary: (exitCode: number, durationMs: number) =>
        `graph run exit=${exitCode} · ${durationMs}ms · session`,
      waiting: "waiting for graph",
      waitingText:
        "`wiki-graphify build`가 끝나면 여기서 주요 노드와 리포트를 바로 확인할 수 있습니다.",
      loading: "loading",
      noGraph: "no graph",
      emptyTitle: "지식 그래프가 아직 없습니다",
      emptyText:
        "Build를 누르면 웹앱이 graphify를 직접 실행하지 않고 기본 코딩 에이전트에 `wiki-graphify build`를 요청합니다. 에이전트가 `wiki/graph/graph.json`과 `GRAPH_REPORT.md`를 생성합니다.",
      running: "Running...",
      buildGraph: "Build graph",
      selectedNode: "selected node",
      chooseNode: "캔버스나 주요 노드 목록에서 노드를 선택하세요.",
      links: "Links",
      godNodes: "god nodes",
      noCommunity: "community 정보가 없습니다.",
      report: "report",
      noReport: "리포트 파일이 없습니다.",
    },
    settings: {
      title: "Settings",
      loadingRoot: "loading project root",
      refresh: "Refresh",
      save: "Save",
      saving: "Saving...",
      savedNotice: "설정을 저장했습니다.",
      passwordNotice: "비밀번호를 변경했습니다.",
      loading: "설정을 읽는 중입니다.",
      codingAgent: "Coding Agent",
      defaultCli: "default cli",
      safeMode: "안전 모드",
      safeModeDesc: "켜면 yolo/bypass 플래그를 빼고 CLI를 호출합니다.",
      runtimeDefaults: "Runtime Defaults",
      wikiOperation: "wiki operation",
      chunkMaxFiles: "Chunk max files",
      chunkMaxBytes: "Chunk max bytes",
      minCommunitySize: "Min community size",
      defaultTab: "Default tab",
      uiLanguage: "UI language",
      autoGraph: "Auto-update graph after ingest",
      autoGraphDesc: "ingest 머지 패스 후 wiki-graphify update를 별도 호출로 실행합니다.",
      server: "Server",
      localWebUi: "local web ui",
      host: "Host",
      port: "Port",
      serverDesc:
        "host/port 변경은 다음 서버 시작부터 반영됩니다. 기본값은 0.0.0.0 (LAN 공유) 이며, 로컬에서만 접근하려면 127.0.0.1로 변경하세요.",
      tools: "Tools",
      detected: "detected",
      loginSession: "Login Session",
      keepSignedIn: "계속 유지",
      sessionDesc: "변경 후 새로 로그인한 세션부터 적용됩니다.",
      password: "Password",
      admin: "admin",
      currentPassword: "Current password",
      newPassword: "New password",
      changing: "Changing...",
      changePassword: "Change password",
      configFiles: "Config Files",
      paths: "paths",
      selected: "선택됨",
      default: "기본",
      use: "사용",
      missing: "누락",
      notDetected: "감지 안 됨",
      customPath: "수동 경로",
      autoIngest: "자동 인제스트",
      autoIngestDesc:
        "raw/ 아래에 자료가 추가되거나 일정 주기가 되면 자동으로 /ingest-loop을 실행합니다.",
      autoIngestEnabled: "자동 인제스트 사용",
      autoIngestMode: "트리거 모드",
      autoIngestModeWatch: "파일 변경 감지",
      autoIngestModeSchedule: "주기적 실행",
      autoIngestDebounce: "디바운스 (ms)",
      autoIngestInterval: "간격 (분)",
      autoIngestSkipIfBusy: "다른 ingest 실행 중이면 스킵",
      autoIngestSkipIfBusyDesc:
        "켜면 wiki/.progress/ingest/.lock 이 있을 때 트리거를 건너뛰고 다음 이벤트/주기에 다시 시도합니다.",
      autoIngestStatus: "상태",
      autoIngestStatusIdle: "대기 중",
      autoIngestStatusRunning: "실행 중",
      autoIngestStatusSkipped: "스킵됨",
      autoIngestStatusDisabled: "비활성",
      autoIngestLastRun: "마지막 실행",
      autoIngestNextRun: "다음 예정",
      autoIngestRunNow: "지금 한 번 실행",
      autoIngestRunningNow: "실행 요청 중...",
      autoIngestNoLastRun: "아직 실행된 적 없음",
      autoIngestNoNextRun: "예약 없음",
      autoIngestBannerRunning: (source: string) =>
        `자동 인제스트가 실행 중입니다 (트리거: ${source}).`,
      autoIngestBannerDone: (halt: string, iterations: number) =>
        `자동 인제스트가 종료되었습니다: ${halt} · iter=${iterations}.`,
      autoIngestBannerSkipped: (reason: string) =>
        `자동 인제스트 건너뜀: ${reason}`,
      autoLint: "자동 lint",
      autoLintDesc:
        "ingest 누적 건수가 임계값을 넘으면 추천 알림을 띄우고, 지정한 주기에 자동으로 /lint --fix를 실행합니다.",
      autoLintEnabled: "자동 lint 사용",
      autoLintCounter: "카운터 (추천만, 자동 실행 안 함)",
      autoLintThreshold: "ingest 건수 임계값",
      autoLintCronEnabled: "주기적 자동 실행",
      autoLintCronPreset: "주기",
      autoLintCronPresetDaily: "매일",
      autoLintCronPresetWeekly: "매주",
      autoLintCronPresetMonthly: "매월",
      autoLintCronTime: "시각 (HH:MM)",
      autoLintCronDayOfWeek: "요일",
      autoLintCronDayOfMonth: "일 (1–28)",
      autoLintFix: "--fix 옵션으로 자동 수정 적용",
      autoLintFixDesc:
        "켜면 자동으로 고칠 수 있는 항목(끊긴 wikilink, 메타데이터 등)은 즉시 수정하고, 의미적 검토가 필요한 항목만 보고서에 남깁니다.",
      autoLintSkipIfBusy: "ingest/lint 락이 있으면 스킵",
      autoLintSkipIfBusyDesc:
        "켜면 wiki/.progress/ingest/.lock 또는 wiki/.progress/lint/.lock이 있을 때 트리거를 건너뜁니다.",
      autoLintStatus: "상태",
      autoLintCounterStatus: (value: number, threshold: number) =>
        `누적 ${value} / ${threshold}`,
      autoLintLastRun: "마지막 실행",
      autoLintNextRun: "다음 cron 실행",
      autoLintRunNow: "지금 lint 실행",
      autoLintRunningNow: "실행 요청 중...",
      autoLintNoLastRun: "아직 실행된 적 없음",
      autoLintNoNextRun: "예약 없음",
      autoLintSuggestionHint: (count: number) =>
        `/lint 추천: ingest ${count}건 누적`,
      autoLintRunSuggested: "지금 실행",
      autoLintWeekdayShort: ["일", "월", "화", "수", "목", "금", "토"],
    },
    auth: {
      setupTitle: "비밀번호 설정",
      setupHint: "이 인스턴스의 관리자 비밀번호를 처음 설정합니다. 6자 이상.",
      setupSubmit: "비밀번호 설정 후 시작",
      loginTitle: "로그인",
      loginHint: "이 인스턴스의 관리자 비밀번호를 입력하세요.",
      loginSubmit: "로그인",
      password: "비밀번호",
      confirm: "비밀번호 확인",
      mismatch: "두 비밀번호가 일치하지 않습니다.",
      shortPassword: "비밀번호는 6자 이상이어야 합니다.",
      requestFailed: (status: number) => `요청 실패 (${status})`,
      network: "네트워크 오류",
      pending: "처리 중...",
      storage:
        "비밀번호와 세션 시크릿은 config/local.json에 저장되며 git 추적에서 제외됩니다.",
    },
  },
  en: {
    common: {
      loading: "Loading...",
      refresh: "Refresh",
      save: "Save",
      saved: "Saved",
      saving: "Saving...",
      edit: "Edit",
      preview: "Preview",
      download: "Download",
      cancel: "Cancel",
      delete: "Delete",
      language: "Language",
      korean: "한국어",
      english: "English",
    },
    sidebar: {
      local: "local",
      tabs: {
        chat: { label: "Chat", desc: "Talk with a coding agent" },
        explorer: { label: "Explorer", desc: "Browse wiki/raw" },
        graph: { label: "Knowledge Graph", desc: "Knowledge graph" },
        settings: { label: "Settings", desc: "CLI · password" },
      },
      collapse: "Collapse navigation",
      expand: "Expand navigation",
      logout: "Logout",
      loggingOut: "Logging out...",
      languageSaving: "Saving",
      localOnlyPrefix: "This instance is",
      localOnlyEmphasis: "LAN-reachable",
      localOnlySuffix: ".",
      defaultBind: "Default bind",
    },
    chat: {
      newTitle: "New chat",
      pendingPath: "A session will be created when you send a message",
      deleteConfirm: (count: number) =>
        `Delete ${count} session(s)? This cannot be undone.`,
      guideTitle: "Getting started",
      guideFreeQuestion: "Ask freely or use a slash command:",
      guideSessions: "Session Markdown is saved automatically under sessions/<date>/.",
      guideAgent:
        "The agent uses the host codex / claude / gemini / cline selected in Settings.",
      processing: "Processing...",
      progressTitle: "Progress",
      progressWaiting: "Waiting for first progress update...",
      empty: "_(empty)_",
      commands: "Commands",
      commandMenu: "Command menu",
      send: "Send",
      placeholder:
        "Ask a question or use /ingest, /query, /lint ...  (Shift+Enter for newline)",
      hint: "Enter to send · Shift+Enter for newline · `/` for slash command autocomplete",
      slashCommands: [
        {
          name: "/ingest",
          arg: "<path|url>",
          desc: "Ingest raw material into the wiki (one sub-chunk)",
        },
        {
          name: "/ingest-loop",
          arg: "<path|url>",
          desc: "Walk leaves and re-spawn /ingest until done (Stop to halt)",
        },
        { name: "/query", arg: "<question>", desc: "Search the wiki and draft an answer" },
        { name: "/lint", arg: "", desc: "Run a wiki health check" },
      ],
      stopLoop: "Stop loop",
      stopping: "Stopping...",
      stopLoopHint: "Halt the ingest-loop once the current sub-chunk finishes.",
      newChat: "+ New Chat",
      clear: "Clear",
      selectAll: "Select all",
      deleting: "Deleting...",
      delete: "Delete",
      noSessions: "No sessions yet.",
      selectSession: (title: string) => `Select ${title}`,
    },
    explorer: {
      workspaces: {
        wiki: "LLM-maintained wiki (editable)",
        raw: "Original material (user-owned, read-only for LLMs)",
        sessions: "Chat session records (system append-only, read-only)",
      },
      readOnlyError: "sessions/ cannot be edited in the UI.",
      uploadBlocked: "Uploads are disabled for sessions/.",
      newFilePath: "New file path",
      newFolderPath: "New folder path",
      newPath: "New path",
      deleteConfirm: (path: string) => `Move ${path} to .trash/?`,
      deleteTitle: "Delete",
      upload: "Upload",
      uploadFolder: "Upload folder",
      busy: (name: string) => `· ${name}...`,
      rawHintPrefix: "Drop material into raw/, then run",
      rawHintSuffix: "from the Chat tab to add it to the wiki.",
      newRootFile: "New file (root)",
      newRootFolder: "New folder (root)",
      fileButton: "+ File",
      folderButton: "+ Folder",
      actions: {
        newFile: "New file",
        newFolder: "New folder",
        uploadFile: "Upload files",
        uploadFolder: "Upload folder",
        rename: "Rename",
        delete: "Delete",
      },
      empty: "Empty",
      selectFile: "Select a file from the left.",
      directory: "This is a folder. Expand its children in the left tree.",
      modified: "modified",
      readOnly:
        "This workspace is locked for UI edits (sessions/ is managed as system append-only).",
      binary: "This file cannot be opened as text.",
    },
    graph: {
      title: "Knowledge Graph",
      refresh: "Refresh",
      update: "Update",
      updating: "Updating...",
      build: "Build",
      building: "Building...",
      nodes: "Nodes",
      edges: "Edges",
      communities: "Communities",
      updated: "Updated",
      runSummary: (exitCode: number, durationMs: number) =>
        `graph run exit=${exitCode} · ${durationMs}ms · session`,
      waiting: "waiting for graph",
      waitingText:
        "When `wiki-graphify build` finishes, key nodes and the report appear here.",
      loading: "loading",
      noGraph: "no graph",
      emptyTitle: "No knowledge graph yet",
      emptyText:
        "Build asks the default coding agent to run `wiki-graphify build`; the web app does not run graphify directly. The agent creates `wiki/graph/graph.json` and `GRAPH_REPORT.md`.",
      running: "Running...",
      buildGraph: "Build graph",
      selectedNode: "selected node",
      chooseNode: "Select a node on the canvas or from the top nodes list.",
      links: "Links",
      godNodes: "top nodes",
      noCommunity: "No community data.",
      report: "report",
      noReport: "No report file.",
    },
    settings: {
      title: "Settings",
      loadingRoot: "loading project root",
      refresh: "Refresh",
      save: "Save",
      saving: "Saving...",
      savedNotice: "Settings saved.",
      passwordNotice: "Password changed.",
      loading: "Loading settings.",
      codingAgent: "Coding Agent",
      defaultCli: "default cli",
      safeMode: "Safe mode",
      safeModeDesc: "When enabled, CLI calls omit yolo/bypass flags.",
      runtimeDefaults: "Runtime Defaults",
      wikiOperation: "wiki operation",
      chunkMaxFiles: "Chunk max files",
      chunkMaxBytes: "Chunk max bytes",
      minCommunitySize: "Min community size",
      defaultTab: "Default tab",
      uiLanguage: "UI language",
      autoGraph: "Auto-update graph after ingest",
      autoGraphDesc: "Run wiki-graphify update as a separate call after an ingest merge pass.",
      server: "Server",
      localWebUi: "local web ui",
      host: "Host",
      port: "Port",
      serverDesc:
        "Host/port changes apply on the next server start. The default is 0.0.0.0 (LAN-reachable). Set host to 127.0.0.1 to restrict access to this machine.",
      tools: "Tools",
      detected: "detected",
      loginSession: "Login Session",
      keepSignedIn: "Keep signed in",
      sessionDesc: "Changes apply to newly logged-in sessions.",
      password: "Password",
      admin: "admin",
      currentPassword: "Current password",
      newPassword: "New password",
      changing: "Changing...",
      changePassword: "Change password",
      configFiles: "Config Files",
      paths: "paths",
      selected: "Selected",
      default: "Default",
      use: "Use",
      missing: "Missing",
      notDetected: "not detected",
      customPath: "Manual path",
      autoIngest: "Auto-ingest",
      autoIngestDesc:
        "Run /ingest-loop automatically when raw/ changes or on a schedule.",
      autoIngestEnabled: "Enable auto-ingest",
      autoIngestMode: "Trigger mode",
      autoIngestModeWatch: "On file change",
      autoIngestModeSchedule: "On schedule",
      autoIngestDebounce: "Debounce (ms)",
      autoIngestInterval: "Interval (minutes)",
      autoIngestSkipIfBusy: "Skip if another ingest is running",
      autoIngestSkipIfBusyDesc:
        "When on, the trigger is skipped if wiki/.progress/ingest/.lock exists and retried on the next event/tick.",
      autoIngestStatus: "Status",
      autoIngestStatusIdle: "Idle",
      autoIngestStatusRunning: "Running",
      autoIngestStatusSkipped: "Skipped",
      autoIngestStatusDisabled: "Disabled",
      autoIngestLastRun: "Last run",
      autoIngestNextRun: "Next run",
      autoIngestRunNow: "Run now",
      autoIngestRunningNow: "Requesting...",
      autoIngestNoLastRun: "No runs yet",
      autoIngestNoNextRun: "No schedule",
      autoIngestBannerRunning: (source: string) =>
        `Auto-ingest is running (source: ${source}).`,
      autoIngestBannerDone: (halt: string, iterations: number) =>
        `Auto-ingest finished: ${halt} · iter=${iterations}.`,
      autoIngestBannerSkipped: (reason: string) =>
        `Auto-ingest skipped: ${reason}`,
      autoLint: "Auto-lint",
      autoLintDesc:
        "Surface a suggestion once ingest activity reaches the threshold and optionally run /lint --fix on a fixed schedule.",
      autoLintEnabled: "Enable auto-lint",
      autoLintCounter: "Counter (suggests only, never auto-runs)",
      autoLintThreshold: "Ingest count threshold",
      autoLintCronEnabled: "Run on a schedule",
      autoLintCronPreset: "Frequency",
      autoLintCronPresetDaily: "Daily",
      autoLintCronPresetWeekly: "Weekly",
      autoLintCronPresetMonthly: "Monthly",
      autoLintCronTime: "Time (HH:MM)",
      autoLintCronDayOfWeek: "Day of week",
      autoLintCronDayOfMonth: "Day of month (1–28)",
      autoLintFix: "Apply --fix",
      autoLintFixDesc:
        "When on, auto-fixable issues (broken wikilinks, missing metadata, etc.) are fixed in place; the report only records items needing manual review.",
      autoLintSkipIfBusy: "Skip if ingest/lint lock present",
      autoLintSkipIfBusyDesc:
        "Skip the trigger when wiki/.progress/ingest/.lock or wiki/.progress/lint/.lock exists.",
      autoLintStatus: "Status",
      autoLintCounterStatus: (value: number, threshold: number) =>
        `${value} / ${threshold}`,
      autoLintLastRun: "Last run",
      autoLintNextRun: "Next cron run",
      autoLintRunNow: "Run lint now",
      autoLintRunningNow: "Requesting...",
      autoLintNoLastRun: "No runs yet",
      autoLintNoNextRun: "No schedule",
      autoLintSuggestionHint: (count: number) =>
        `/lint recommended: ${count} ingests accumulated`,
      autoLintRunSuggested: "Run now",
      autoLintWeekdayShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    },
    auth: {
      setupTitle: "Set password",
      setupHint: "Set the administrator password for this instance. Minimum 6 characters.",
      setupSubmit: "Set password and start",
      loginTitle: "Log in",
      loginHint: "Enter the administrator password for this instance.",
      loginSubmit: "Log in",
      password: "Password",
      confirm: "Confirm password",
      mismatch: "Passwords do not match.",
      shortPassword: "Password must be at least 6 characters.",
      requestFailed: (status: number) => `Request failed (${status})`,
      network: "Network error",
      pending: "Working...",
      storage:
        "The password and session secret are stored in config/local.json, which is excluded from git.",
    },
  },
} as const;

type TextBundle = (typeof TEXT)[Language];

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => Promise<void>;
  savingLanguage: boolean;
  t: TextBundle;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: Language;
  children: React.ReactNode;
}) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const [savingLanguage, setSavingLanguage] = useState(false);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(
    async (nextLanguage: Language) => {
      if (nextLanguage === language) return;
      const previous = language;
      setLanguageState(nextLanguage);
      setSavingLanguage(true);
      try {
        const res = await fetch("/api/settings/language", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ language: nextLanguage }),
        });
        if (!res.ok) throw new Error(`language save failed (${res.status})`);
      } catch (err) {
        setLanguageState(previous);
        throw err;
      } finally {
        setSavingLanguage(false);
      }
    },
    [language],
  );

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      savingLanguage,
      t: TEXT[language],
    }),
    [language, savingLanguage, setLanguage],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }
  return value;
}
