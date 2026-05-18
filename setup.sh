#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="${ROOT_DIR}/webapp"
TOOLS_DIR="${ROOT_DIR}/tools"
CONFIG_DIR="${ROOT_DIR}/config"
WIKI_DIR="${ROOT_DIR}/wiki"
RAW_DIR="${ROOT_DIR}/raw"
SESSIONS_DIR="${ROOT_DIR}/sessions"
RUN_DIR="${ROOT_DIR}/.run"
SERVER_PID_FILE="${RUN_DIR}/webapp.pid"
SERVER_LOG_FILE="${RUN_DIR}/webapp.log"

PORT="9091"
HOST="0.0.0.0"
DEV_MODE=0
SKIP_GRAPHIFY=0
SKIP_NPM_INSTALL=0
SKIP_BUILD=0
START_SERVER=0
SHUTDOWN_SERVER=0
RESTART_EXISTING=1
WITH_QMD=0
WITH_MARP=0
WITH_AGENT_BROWSER=0
INSTALL_CLI=""

log() {
  printf '[llm-wiki] %s\n' "$*"
}

warn() {
  printf '[llm-wiki] warning: %s\n' "$*" >&2
}

fail() {
  printf '[llm-wiki] error: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

Prepare the local LLM Wiki project.

Options:
  --port <n>                    Web UI port (default: 9091)
  --host <addr>                 Web UI host (default: 0.0.0.0; use 127.0.0.1 for local-only)
  --dev                         Print dev-server command instead of production command
  --start                       Start the web server in the background after setup
  --shutdown                    Stop the running web server and exit
  --no-restart                  With --start, fail if the target port is already in use
  --skip-graphify               Do not install graphify; use existing global graphify if available
  --skip-npm-install            Do not run npm install in webapp/ (default skips when dependencies are present)
  --skip-build                  Do not run npm run build
  --with-qmd                    Best-effort optional qmd clone into tools/qmd
  --with-marp                   Best-effort optional Marp CLI install
  --with-agent-browser          Best-effort optional agent-browser install
  --install-cli=<names>         Best-effort install for codex,claude,gemini,cline
  -h, --help                    Show this help

Examples:
  ./setup.sh
  ./setup.sh --port 7788 --skip-graphify
  ./setup.sh --install-cli=claude,gemini --with-marp
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || fail "--host requires a value"
      HOST="$2"
      shift 2
      ;;
    --dev)
      DEV_MODE=1
      shift
      ;;
    --start)
      START_SERVER=1
      shift
      ;;
    --shutdown)
      SHUTDOWN_SERVER=1
      shift
      ;;
    --no-restart)
      RESTART_EXISTING=0
      shift
      ;;
    --skip-graphify)
      SKIP_GRAPHIFY=1
      shift
      ;;
    --skip-npm-install)
      SKIP_NPM_INSTALL=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --with-qmd)
      WITH_QMD=1
      shift
      ;;
    --with-marp)
      WITH_MARP=1
      shift
      ;;
    --with-agent-browser)
      WITH_AGENT_BROWSER=1
      shift
      ;;
    --install-cli=*)
      INSTALL_CLI="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

require_command() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || fail "${name} is required but was not found on PATH"
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])'
}

ensure_node_version() {
  local major
  major="$(node_major)"
  if [[ "${major}" -lt 20 ]]; then
    fail "Node.js >=20 is required; found $(node --version)"
  fi
}

write_if_missing() {
  local file="$1"
  local content="$2"
  if [[ -e "${file}" ]]; then
    return
  fi
  mkdir -p "$(dirname "${file}")"
  printf '%s\n' "${content}" > "${file}"
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

detect_cli_json() {
  local out="${CONFIG_DIR}/cli-detected.json"
  node - "${out}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const out = process.argv[2];
const names = ["codex", "claude", "gemini", "cline"];
const extras = [
  path.join(process.env.HOME || "/", ".npm-global", "bin"),
  path.join(process.env.HOME || "/", ".local", "bin"),
  "/usr/local/bin",
];
const dirs = [...(process.env.PATH || "").split(path.delimiter), ...extras]
  .filter(Boolean);

function findBin(name) {
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {}
  }
  return null;
}

function version(bin) {
  if (!bin) return null;
  const res = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 4000,
  });
  const text = `${res.stdout || ""}${res.stderr || ""}`.trim();
  return text.split(/\r?\n/)[0]?.slice(0, 120) || null;
}

const result = {
  detectedAt: new Date().toISOString(),
  cli: names.map((name) => {
    const bin = findBin(name);
    return {
      name,
      path: bin,
      version: version(bin),
      source: bin ? "PATH" : "missing",
    };
  }),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
NODE
}

install_cli_best_effort() {
  local list="$1"
  [[ -n "${list}" ]] || return 0
  require_command npm
  IFS=',' read -r -a names <<< "${list}"
  for name in "${names[@]}"; do
    case "${name}" in
      codex)
        log "best-effort install: codex via npm package @openai/codex"
        npm install -g @openai/codex || warn "codex install failed; install it manually and set the path in Settings"
        ;;
      claude)
        log "best-effort install: claude via npm package @anthropic-ai/claude-code"
        npm install -g @anthropic-ai/claude-code || warn "claude install failed; install it manually and set the path in Settings"
        ;;
      gemini)
        log "best-effort install: gemini via npm package @google/gemini-cli"
        npm install -g @google/gemini-cli || warn "gemini install failed; install it manually and set the path in Settings"
        ;;
      cline)
        warn "cline is usually distributed as an editor extension; skipping automatic install"
        ;;
      "")
        ;;
      *)
        warn "unknown CLI requested for install: ${name}"
        ;;
    esac
  done
}

install_agent_browser_best_effort() {
  if command -v agent-browser >/dev/null 2>&1; then
    log "agent-browser already available: $(command -v agent-browser)"
    return
  fi
  require_command npm
  log "best-effort install: agent-browser via npm package agent-browser"
  if npm install -g agent-browser; then
    if command -v agent-browser >/dev/null 2>&1; then
      agent-browser install || warn "agent-browser browser install failed; run 'agent-browser install' manually if browser automation is needed"
    else
      warn "agent-browser installed but not found on PATH; add npm global bin to PATH"
    fi
  else
    warn "agent-browser install failed; install it manually if browser automation jobs need it"
  fi
}

clone_if_missing() {
  local dest="$1"
  local repo="$2"
  local label="$3"
  if [[ -d "${dest}/.git" ]]; then
    log "${label} already present: ${dest}"
    return
  fi
  if [[ -e "${dest}" ]]; then
    warn "${label} path exists but is not a git checkout: ${dest}; leaving it untouched"
    return
  fi
  require_command git
  log "cloning ${label}: ${repo}"
  git clone "${repo}" "${dest}" || warn "failed to clone ${label}; you can retry later or follow tools/README.md"
}

python_user_bin_dir() {
  python3 - <<'PY' 2>/dev/null || true
import site
print(site.getuserbase() + "/bin")
PY
}

python_externally_managed() {
  python3 - <<'PY' >/dev/null 2>&1
import pathlib
import sys
import sysconfig

stdlib = sysconfig.get_path("stdlib")
marker = pathlib.Path(stdlib or "") / "EXTERNALLY-MANAGED"
sys.exit(0 if marker.exists() else 1)
PY
}

find_graphify_bin() {
  local path_bin=""
  path_bin="$(command -v graphify 2>/dev/null || true)"
  if [[ -n "${path_bin}" ]]; then
    printf '%s\n' "${path_bin}"
    return 0
  fi

  local candidate
  for candidate in \
    "${HOME:-}/.local/bin/graphify" \
    "$(python_user_bin_dir)/graphify"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

log_graphify_status() {
  local graphify_bin=""
  graphify_bin="$(find_graphify_bin || true)"
  if [[ -n "${graphify_bin}" ]]; then
    local version=""
    version="$(graphify_package_version "${graphify_bin}")"
    if [[ -n "${version}" ]]; then
      log "global graphify available: ${graphify_bin} (graphifyy ${version})"
    else
      log "global graphify available: ${graphify_bin} (version unknown)"
    fi
  else
    warn "global graphify was not found; Graph Build/Update will need graphify installed"
  fi
}

graphify_python() {
  local graphify_bin="$1"
  local first_line=""
  local python_bin=""
  first_line="$(head -n 1 "${graphify_bin}" 2>/dev/null || true)"
  python_bin="${first_line#\#!}"
  if [[ "${python_bin}" == *python* && -x "${python_bin}" ]]; then
    printf '%s\n' "${python_bin}"
    return 0
  fi
  printf 'python3\n'
}

graphify_package_version() {
  local graphify_bin="$1"
  local python_bin=""
  python_bin="$(graphify_python "${graphify_bin}")"
  "${python_bin}" - <<'PY' 2>/dev/null || true
from importlib.metadata import PackageNotFoundError, version
try:
    print(version("graphifyy"))
except PackageNotFoundError:
    pass
PY
}

run_graphify_install() {
  local graphify_bin=""
  graphify_bin="$(find_graphify_bin || true)"
  if [[ -z "${graphify_bin}" ]]; then
    warn "graphify command is not on PATH. Add your Python user bin directory to PATH, or run: python3 -m graphify install"
    return 0
  fi

  log "installing graphify assistant integration"
  "${graphify_bin}" install || warn "graphify install failed; run it manually if the Graph workflow needs it"
}

install_graphify_with_pip_user() {
  if python_externally_managed; then
    warn "Python is externally managed (PEP 668); skipping 'python3 -m pip install --user'. Install pipx with your OS package manager, then rerun setup:"
    warn "  sudo apt install pipx && pipx ensurepath"
    warn "Or rerun './setup.sh --skip-graphify' if graphify is already installed."
    return 0
  fi

  local err_file=""
  err_file="$(mktemp)"
  log "using pip: python3 -m pip install --user --upgrade graphifyy"
  if python3 -m pip install --user --upgrade graphifyy 2>"${err_file}"; then
    rm -f "${err_file}"
    return 0
  fi

  if grep -q "externally-managed-environment" "${err_file}"; then
    warn "pip refused the install because this Python environment is externally managed. Install pipx and rerun setup:"
    warn "  sudo apt install pipx && pipx ensurepath"
  else
    warn "pip graphifyy install/upgrade failed; last error lines:"
    tail -n 8 "${err_file}" >&2 || true
    warn "try: pipx install graphifyy && graphify install"
  fi
  rm -f "${err_file}"
}

install_or_upgrade_graphify_global() {
  local graphify_bin=""
  local before_version=""
  graphify_bin="$(find_graphify_bin || true)"
  if [[ -n "${graphify_bin}" ]]; then
    before_version="$(graphify_package_version "${graphify_bin}")"
    log "graphify before upgrade: ${graphify_bin} (graphifyy ${before_version:-unknown})"
  fi

  require_command python3
  log "installing/upgrading graphify globally via latest official graphifyy package"
  if command -v pipx >/dev/null 2>&1; then
    log "using pipx first: pipx upgrade/install graphifyy"
    if pipx upgrade graphifyy || pipx install graphifyy; then
      :
    else
      warn "pipx graphifyy install/upgrade failed; trying python3 -m pip --user when allowed"
      install_graphify_with_pip_user
    fi
  else
    install_graphify_with_pip_user
  fi

  graphify_bin="$(find_graphify_bin || true)"
  if [[ -z "${graphify_bin}" ]]; then
    warn "graphify command is still not available. Install it with pipx, add it to PATH, or rerun './setup.sh --skip-graphify'."
    return 0
  fi

  local after_version=""
  after_version="$(graphify_package_version "${graphify_bin}")"
  log "graphify after upgrade: ${graphify_bin} (graphifyy ${after_version:-unknown})"

  run_graphify_install
}

ensure_initial_files() {
  mkdir -p \
    "${RAW_DIR}" \
    "${WIKI_DIR}/sources" \
    "${WIKI_DIR}/answers" \
    "${WIKI_DIR}/lint" \
    "${WIKI_DIR}/archive" \
    "${WIKI_DIR}/graph/parts" \
    "${WIKI_DIR}/.progress/ingest/leaves" \
    "${SESSIONS_DIR}" \
    "${RUN_DIR}" \
    "${TOOLS_DIR}" \
    "${CONFIG_DIR}"

  local today
  today="$(date +%F)"

  if [[ ! -e "${CONFIG_DIR}/default.json" ]]; then
    cat > "${CONFIG_DIR}/default.json" <<'JSON'
{
  "server": {
    "port": 9091,
    "host": "0.0.0.0"
  },
  "agent": {
    "default": null,
    "safeMode": false,
    "paths": {}
  },
  "chunking": {
    "maxFiles": 8,
    "maxBytes": 262144,
    "maxFilesPerInvocation": 4,
    "maxBytesPerFile": 131072,
    "unitPerCall": "one_subchunk"
  },
  "graph": {
    "minCommunitySize": 3,
    "autoUpdateOnIngest": true
  },
  "chat": {
    "contextTurns": 6,
    "includeProgressDashboard": true
  },
  "cli": {
    "maxStdoutBytes": 1048576,
    "maxStderrBytes": 262144,
    "promptWarnBytes": 131072,
    "timeouts": {
      "chat": 300000,
      "ingest": null,
      "query": 1800000,
      "lint": 1800000,
      "graph": 1800000
    }
  },
  "ui": {
    "language": "ko",
    "defaultTab": "chat"
  },
  "auth": {
    "passwordHash": null,
    "sessionSecret": null,
    "sessionTtlSec": 86400
  }
}
JSON
  fi

  if [[ ! -e "${CONFIG_DIR}/local.json" ]]; then
    cat > "${CONFIG_DIR}/local.json" <<JSON
{
  "server": {
    "port": ${PORT},
    "host": $(json_escape "${HOST}")
  },
  "auth": {
    "passwordHash": null,
    "sessionSecret": null,
    "sessionTtlSec": 86400
  }
}
JSON
  fi

  if [[ ! -e "${WIKI_DIR}/index.md" ]]; then
    cat > "${WIKI_DIR}/index.md" <<EOF
---
title: LLM Wiki — Index
type: index
updated: ${today}
---

# Index

이 파일은 위키의 **목차**다. 각 운영(ingest/query/lint)의 머지 패스 마지막 단계에서 일괄 갱신된다.
규칙: 각 항목은 한 줄, 형식은 \`- [[페이지명]] — 한 줄 요약\`.

## Entities

(아직 비어 있음)

## Concepts

(아직 비어 있음)

## Sources

(아직 비어 있음)

## Answers

(아직 비어 있음)

## Comparisons

(아직 비어 있음)

## Lint Reports

(아직 비어 있음)

## Graph

- [[wiki/graph/GRAPH_REPORT]] — 지식 그래프 리포트 (graphify 실행 후 생성)
EOF
  fi

  if [[ ! -e "${WIKI_DIR}/log.md" ]]; then
    cat > "${WIKI_DIR}/log.md" <<EOF
---
title: LLM Wiki — Activity Log
type: log
updated: ${today}
---

# Activity Log

위키의 모든 운영 기록은 여기에 **append-only**로 쌓인다.

형식:
\`\`\`markdown
## [YYYY-MM-DD HH:MM] ingest | query | lint | graph | <제목>
- 변경 파일: \`wiki/<...>.md\`, ...
- 비고: 청크 N개, 머지 패스 완료
\`\`\`

---

## [${today} 00:00] init | 위키 초기화
- 생성: \`wiki/index.md\`, \`wiki/log.md\`
- 비고: setup.sh 초기화
EOF
  fi

  write_if_missing "${SESSIONS_DIR}/.gitkeep" ""
}

install_webapp() {
  [[ -d "${WEBAPP_DIR}" ]] || fail "webapp/ directory not found"
  require_command npm

  if [[ "${SKIP_NPM_INSTALL}" -eq 0 ]]; then
    if webapp_dependencies_installed; then
      log "webapp dependencies already present; skipping npm install"
    else
      log "installing webapp dependencies"
      (cd "${WEBAPP_DIR}" && npm install)
    fi
  else
    log "skipping npm install"
  fi

  if [[ "${SKIP_BUILD}" -eq 0 ]]; then
    log "building webapp"
    (cd "${WEBAPP_DIR}" && npm run build)
  else
    log "skipping webapp build"
  fi
}

webapp_dependencies_installed() {
  [[ -d "${WEBAPP_DIR}/node_modules" ]] || return 1

  (cd "${WEBAPP_DIR}" && node <<'NODE')
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const dependencies = {
  ...(manifest.dependencies || {}),
  ...(manifest.devDependencies || {}),
};

function packagePath(name) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return path.join("node_modules", scope, packageName || "", "package.json");
  }
  return path.join("node_modules", name, "package.json");
}

for (const name of Object.keys(dependencies)) {
  if (!fs.existsSync(packagePath(name))) {
    process.exit(1);
  }
}
NODE
}

next_bin() {
  local bin="${WEBAPP_DIR}/node_modules/.bin/next"
  if [[ -x "${bin}" ]]; then
    printf '%s\n' "${bin}"
    return 0
  fi
  fail "Next.js binary not found at ${bin}. Run setup without --skip-npm-install first."
}

launch_next_background() {
  local mode="$1"
  local next="$2"
  : > "${SERVER_LOG_FILE}"
  if command -v setsid >/dev/null 2>&1; then
    (
      cd "${WEBAPP_DIR}"
      nohup setsid "${next}" "${mode}" -p "${PORT}" -H "${HOST}" \
        >> "${SERVER_LOG_FILE}" 2>&1 < /dev/null &
      echo $! > "${SERVER_PID_FILE}"
    )
  else
    (
      cd "${WEBAPP_DIR}"
      nohup "${next}" "${mode}" -p "${PORT}" -H "${HOST}" \
        >> "${SERVER_LOG_FILE}" 2>&1 < /dev/null &
      echo $! > "${SERVER_PID_FILE}"
    )
  fi
}

find_port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "TCP:${PORT}" -sTCP:LISTEN 2>/dev/null | tr -cs '0-9' '\n' | sed '/^$/d' || true
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser "${PORT}/tcp" 2>/dev/null | tr -cs '0-9' '\n' | sed '/^$/d' || true
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :${PORT}" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      || true
  fi
  ps -eo pid=,args= 2>/dev/null \
    | awk -v port="${PORT}" -v webapp="${WEBAPP_DIR}" '
      $0 ~ webapp && $0 ~ /next (dev|start)/ { print $1 }
      $0 ~ /next (dev|start)/ && $0 ~ ("-p " port) { print $1 }
      $0 ~ /npm (run )?(dev|start)/ && $0 ~ webapp { print $1 }
    ' \
    || true
}

find_pid_file_pids() {
  if [[ ! -f "${SERVER_PID_FILE}" ]]; then
    return
  fi
  local pid
  pid="$(tr -dc '0-9' < "${SERVER_PID_FILE}")"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    printf '%s\n' "${pid}"
  fi
}

wait_for_pids_to_exit() {
  local pids="$1"
  local i
  for i in 1 2 3 4 5; do
    local any_alive=0
    local pid
    for pid in ${pids}; do
      if kill -0 "${pid}" 2>/dev/null; then
        any_alive=1
      fi
    done
    [[ "${any_alive}" -eq 0 ]] && return 0
    sleep 1
  done
  return 1
}

stop_pids() {
  local pids
  pids="$1"
  if [[ -z "${pids// }" ]]; then
    return 0
  fi

  log "stopping web server process(es): ${pids}"
  local pid
  for pid in ${pids}; do
    kill "${pid}" 2>/dev/null || true
  done
  if ! wait_for_pids_to_exit "${pids}"; then
    warn "process(es) did not exit after SIGTERM; sending SIGKILL: ${pids}"
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
  fi
  rm -f "${SERVER_PID_FILE}"
}

running_server_pids() {
  {
    find_pid_file_pids
    find_port_pids
  } | sort -n | uniq
}

shutdown_server() {
  local pids
  pids="$(running_server_pids | tr '\n' ' ')"
  if [[ -z "${pids// }" ]]; then
    log "no running web server found for port ${PORT}"
    rm -f "${SERVER_PID_FILE}"
    return 0
  fi
  stop_pids "${pids}"
  log "web server stopped"
}

prepare_start_port() {
  local pids
  pids="$(running_server_pids | tr '\n' ' ')"
  if [[ -z "${pids// }" ]]; then
    return
  fi

  if [[ "${RESTART_EXISTING}" -eq 0 ]]; then
    fail "port ${PORT} is already in use by pid(s): ${pids}. Stop them or omit --no-restart."
  fi

  log "port ${PORT} is already in use; restarting existing web server"
  stop_pids "${pids}"
}

start_server() {
  if [[ "${START_SERVER}" -eq 0 ]]; then
    return
  fi
  prepare_start_port
  mkdir -p "${RUN_DIR}"
  local next
  next="$(next_bin)"
  if [[ "${DEV_MODE}" -eq 1 ]]; then
    log "starting dev server in background on http://${HOST}:${PORT}"
    launch_next_background dev "${next}"
  else
    log "starting production server in background on http://${HOST}:${PORT}"
    launch_next_background start "${next}"
  fi
  sleep 1
  local pid
  pid="$(cat "${SERVER_PID_FILE}" 2>/dev/null || true)"
  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    fail "web server failed to start; see ${SERVER_LOG_FILE}"
  fi
  log "web server started with pid ${pid}"
  log "log file: ${SERVER_LOG_FILE}"
}

main() {
  log "project root: ${ROOT_DIR}"
  require_command bash
  require_command node
  require_command npm
  ensure_node_version

  if [[ "${SHUTDOWN_SERVER}" -eq 1 ]]; then
    shutdown_server
    return
  fi

  ensure_initial_files
  install_cli_best_effort "${INSTALL_CLI}"
  detect_cli_json

  if [[ "${SKIP_GRAPHIFY}" -eq 0 ]]; then
    install_or_upgrade_graphify_global
  else
    log "skipping graphify install; wiki-graphify will use global graphify from PATH if available"
    log_graphify_status
  fi

  if [[ "${WITH_QMD}" -eq 1 ]]; then
    clone_if_missing "${TOOLS_DIR}/qmd" "https://github.com/tobi/qmd.git" "qmd"
  fi

  if [[ "${WITH_MARP}" -eq 1 ]]; then
    if command -v marp >/dev/null 2>&1; then
      log "marp already available: $(command -v marp)"
    else
      require_command npm
      log "best-effort install: marp via npm package @marp-team/marp-cli"
      npm install -g @marp-team/marp-cli || warn "marp install failed; install it manually if needed"
    fi
  fi

  if [[ "${WITH_AGENT_BROWSER}" -eq 1 ]]; then
    install_agent_browser_best_effort
  fi

  install_webapp

  log "setup complete"
  log "open http://${HOST}:${PORT}"
  if [[ "${DEV_MODE}" -eq 1 ]]; then
    log "run: cd webapp && npm run dev"
  else
    log "run: cd webapp && npm start"
  fi
  if [[ "${START_SERVER}" -eq 0 ]]; then
    log "server not started; pass --start to run it from setup.sh"
  fi
  log "first visit will redirect to /setup for the admin password"

  start_server
}

main "$@"
