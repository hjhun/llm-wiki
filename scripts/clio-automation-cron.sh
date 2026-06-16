#!/usr/bin/env bash
#
# CLIO automation watchdog / external trigger.
#
# Why this exists:
#   CLIO's automation scheduler is an in-memory setTimeout living inside the
#   single Next.js server process. It only fires while that process is
#   continuously alive from arming until the fire instant. On WSL/desktop the
#   process is not reliably long-lived (terminal close, WSL suspend, crash),
#   so scheduled jobs silently miss their fire time.
#
# What this does, every time it runs (intended to be called once per minute by
# cron):
#   1. Ensure the web server is up; if it is down, relaunch it. Boot runs the
#      manager's catch-up, which replays any run missed while the process was
#      down (exactly once).
#   2. Hit POST /api/automation/tick to force a reconcile in the running
#      process (arm missing timers, replay missed slots) as a belt-and-
#      suspenders backstop.
#
# Usage:
#   scripts/clio-automation-cron.sh            # one tick (ensure-up + reconcile)
#   scripts/clio-automation-cron.sh install    # install the per-minute crontab entry
#   scripts/clio-automation-cron.sh uninstall  # remove the crontab entry
#   scripts/clio-automation-cron.sh status     # show whether the entry is installed
#
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")/.." && pwd)"
WEBAPP_DIR="${ROOT_DIR}/webapp"
RUN_DIR="${ROOT_DIR}/.run"
SERVER_PID_FILE="${RUN_DIR}/webapp.pid"
SERVER_LOG_FILE="${RUN_DIR}/webapp.log"
CRON_MARKER="# clio-automation-cron (${ROOT_DIR})"

log() { printf '[clio-cron] %s\n' "$*" >&2; }

# Pull port / host / token / run mode out of the JSON config with node, which
# CLIO already requires. Falls back to defaults when fields are missing.
read_config() {
  node - "$ROOT_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
const def = readJson(path.join(root, "config", "default.json"));
const loc = readJson(path.join(root, "config", "local.json"));
const server = { ...(def.server || {}), ...(loc.server || {}) };
const auth = { ...(def.auth || {}), ...(loc.auth || {}) };
const port = server.port || 9091;
const token = auth.cliToken || "";
const hasBuild = fs.existsSync(path.join(root, "webapp", ".next", "BUILD_ID"));
process.stdout.write(`${port}\t${token}\t${hasBuild ? "start" : "dev"}\n`);
NODE
}

IFS=$'\t' read -r PORT CLI_TOKEN NEXT_MODE < <(read_config)
PORT="${PORT:-9091}"
NEXT_MODE="${NEXT_MODE:-start}"
BASE_URL="http://127.0.0.1:${PORT}"

next_bin() {
  local bin="${WEBAPP_DIR}/node_modules/.bin/next"
  [[ -x "${bin}" ]] || { log "next binary not found at ${bin}; run setup.sh first"; return 1; }
  printf '%s\n' "${bin}"
}

server_listening() {
  # 0 = something answered on the port (even a redirect / 401), non-0 otherwise.
  curl -s -o /dev/null --connect-timeout 3 --max-time 8 "${BASE_URL}/api/automation/tick" \
    -X POST >/dev/null 2>&1
  local code=$?
  # curl exit 7 = connection refused (server down). Any HTTP response (incl.
  # 401/500) means the server is up.
  [[ "${code}" -ne 7 ]]
}

start_server() {
  local next
  next="$(next_bin)" || return 1
  mkdir -p "${RUN_DIR}"
  log "server not responding; launching '${next} ${NEXT_MODE}' on port ${PORT}"
  (
    cd "${WEBAPP_DIR}"
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid "${next}" "${NEXT_MODE}" -p "${PORT}" -H "0.0.0.0" \
        >> "${SERVER_LOG_FILE}" 2>&1 < /dev/null &
    else
      nohup "${next}" "${NEXT_MODE}" -p "${PORT}" -H "0.0.0.0" \
        >> "${SERVER_LOG_FILE}" 2>&1 < /dev/null &
    fi
    echo $! > "${SERVER_PID_FILE}"
  )
  # Wait up to ~40s for readiness so the follow-up tick lands on a live server.
  local i
  for i in $(seq 1 40); do
    if server_listening; then
      log "server is up"
      return 0
    fi
    sleep 1
  done
  log "server did not become ready in time; see ${SERVER_LOG_FILE}"
  return 1
}

do_tick() {
  local auth_header=()
  [[ -n "${CLI_TOKEN}" ]] && auth_header=(-H "Authorization: Bearer ${CLI_TOKEN}")
  local out
  out="$(curl -s --connect-timeout 3 --max-time 30 -X POST \
    "${auth_header[@]}" "${BASE_URL}/api/automation/tick" 2>/dev/null)" || {
    log "tick request failed"
    return 1
  }
  log "tick: ${out:0:200}"
}

run_once() {
  if ! server_listening; then
    start_server || return 1
  fi
  do_tick
}

crontab_install() {
  local line="* * * * * ${SCRIPT_PATH} >/dev/null 2>&1 ${CRON_MARKER}"
  local current
  current="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "${current}" | grep -Fq "${CRON_MARKER}"; then
    log "crontab entry already installed"
    return 0
  fi
  printf '%s\n%s\n' "${current}" "${line}" | sed '/^$/d' | crontab -
  log "installed per-minute crontab entry"
  log "  ${line}"
}

crontab_uninstall() {
  local current
  current="$(crontab -l 2>/dev/null || true)"
  if ! printf '%s\n' "${current}" | grep -Fq "${CRON_MARKER}"; then
    log "no crontab entry to remove"
    return 0
  fi
  printf '%s\n' "${current}" | grep -Fv "${CRON_MARKER}" | sed '/^$/d' | crontab -
  log "removed crontab entry"
}

crontab_status() {
  if crontab -l 2>/dev/null | grep -Fq "${CRON_MARKER}"; then
    log "crontab entry: installed"
  else
    log "crontab entry: not installed"
  fi
}

case "${1:-run}" in
  run)
    # Serialize concurrent runs: a per-minute cron can otherwise overlap with a
    # previous invocation still waiting for the server to come up (~40s),
    # racing two launches on the same port. flock is best-effort; if it is not
    # available we just run.
    mkdir -p "${RUN_DIR}"
    if command -v flock >/dev/null 2>&1; then
      exec 9>"${RUN_DIR}/automation-cron.lock"
      if ! flock -n 9; then
        log "another watchdog run is in progress; skipping"
        exit 0
      fi
    fi
    run_once
    ;;
  install) crontab_install ;;
  uninstall) crontab_uninstall ;;
  status) crontab_status ;;
  *)
    log "usage: $(basename "$0") [run|install|uninstall|status]"
    exit 2
    ;;
esac
