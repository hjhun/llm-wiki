#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEBAPP_DIR="${ROOT_DIR}/webapp"
TEMPLATE_FILE="${SCRIPT_DIR}/clio-web.service"
SERVICE_NAME="clio-web.service"
UNIT_DIR="/etc/systemd/system"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
SERVICE_GROUP=""
DO_START=1
DO_ENABLE=1
SKIP_NPM_INSTALL=0
SKIP_BUILD=0

log() {
  printf '[clio-systemd] %s\n' "$*"
}

warn() {
  printf '[clio-systemd] warning: %s\n' "$*" >&2
}

fail() {
  printf '[clio-systemd] error: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: ./systemd/install-clio-web-service.sh [options]

Install and optionally start the CLIO web UI as a systemd service.

Options:
  --service-name <name>       Unit name (default: clio-web.service)
  --unit-dir <path|etc|vendor>
                              Install unit directory.
                              etc    -> /etc/systemd/system (default)
                              vendor -> /usr/lib/systemd/system when present,
                                        falling back to /lib/systemd/system
  --user <name>               User that runs the web app (default: current user)
  --group <name>              Group that runs the web app (default: user's primary group)
  --root <path>               CLIO checkout path (default: repository root)
  --skip-npm-install          Do not run npm install when node_modules is missing
  --skip-build                Do not run npm run build before installing the service
  --no-enable                 Install the unit but do not enable it at boot
  --no-start                  Install/enable the unit but do not restart it now
  -h, --help                  Show this help

Examples:
  ./systemd/install-clio-web-service.sh
  ./systemd/install-clio-web-service.sh --unit-dir vendor
  ./systemd/install-clio-web-service.sh --user clio --group clio --root /opt/clio
EOF
}

require_command() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || fail "${name} is required but was not found on PATH"
}

sudo_cmd() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

detect_vendor_unit_dir() {
  if [[ -d /usr/lib/systemd/system ]]; then
    printf '/usr/lib/systemd/system\n'
  elif [[ -d /lib/systemd/system ]]; then
    printf '/lib/systemd/system\n'
  else
    printf '/usr/lib/systemd/system\n'
  fi
}

primary_group_for_user() {
  local user="$1"
  id -gn "${user}" 2>/dev/null || getent passwd "${user}" | awk -F: '{ print $4 }'
}

home_for_user() {
  local user="$1"
  getent passwd "${user}" | awk -F: '{ print $6 }'
}

append_path_dir() {
  local dir="$1"
  local path_value="$2"
  if [[ -n "${dir}" && ":${path_value}:" != *":${dir}:"* ]]; then
    printf '%s:%s\n' "${dir}" "${path_value}"
  else
    printf '%s\n' "${path_value}"
  fi
}

render_unit() {
  local template
  local rendered
  local service_home="$1"
  local path_value="$2"
  template="$(< "${TEMPLATE_FILE}")"
  rendered="${template//__CLIO_USER__/${SERVICE_USER}}"
  rendered="${rendered//__CLIO_GROUP__/${SERVICE_GROUP}}"
  rendered="${rendered//__CLIO_HOME__/${service_home}}"
  rendered="${rendered//__CLIO_ROOT__/${ROOT_DIR}}"
  rendered="${rendered//__CLIO_WEBAPP_DIR__/${WEBAPP_DIR}}"
  rendered="${rendered//__CLIO_PATH__/${path_value}}"
  printf '%s\n' "${rendered}"
}

run_webapp_command() {
  if [[ "${EUID}" -eq 0 && "${SERVICE_USER}" != "root" ]]; then
    sudo -H -u "${SERVICE_USER}" env PATH="${PATH:-}" bash -c \
      'cd "$1" && shift && "$@"' bash "${WEBAPP_DIR}" "$@"
  else
    (cd "${WEBAPP_DIR}" && "$@")
  fi
}

prepare_webapp() {
  require_command npm
  if [[ ! -d "${WEBAPP_DIR}" ]]; then
    fail "webapp directory not found: ${WEBAPP_DIR}"
  fi

  if [[ "${SKIP_NPM_INSTALL}" -eq 0 && ! -d "${WEBAPP_DIR}/node_modules" ]]; then
    log "installing webapp dependencies"
    run_webapp_command npm install
  elif [[ "${SKIP_NPM_INSTALL}" -eq 1 ]]; then
    log "skipping npm install"
  else
    log "webapp dependencies already installed"
  fi

  if [[ "${SKIP_BUILD}" -eq 0 ]]; then
    log "building webapp"
    run_webapp_command npm run build
  else
    log "skipping webapp build"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      [[ $# -ge 2 ]] || fail "--service-name requires a value"
      SERVICE_NAME="$2"
      shift 2
      ;;
    --unit-dir)
      [[ $# -ge 2 ]] || fail "--unit-dir requires a value"
      case "$2" in
        etc)
          UNIT_DIR="/etc/systemd/system"
          ;;
        vendor)
          UNIT_DIR="$(detect_vendor_unit_dir)"
          ;;
        /*)
          UNIT_DIR="$2"
          ;;
        *)
          fail "--unit-dir must be an absolute path, 'etc', or 'vendor'"
          ;;
      esac
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || fail "--user requires a value"
      SERVICE_USER="$2"
      shift 2
      ;;
    --group)
      [[ $# -ge 2 ]] || fail "--group requires a value"
      SERVICE_GROUP="$2"
      shift 2
      ;;
    --root)
      [[ $# -ge 2 ]] || fail "--root requires a value"
      ROOT_DIR="$(cd "$2" && pwd)"
      WEBAPP_DIR="${ROOT_DIR}/webapp"
      shift 2
      ;;
    --skip-npm-install)
      SKIP_NPM_INSTALL=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-enable)
      DO_ENABLE=0
      shift
      ;;
    --no-start)
      DO_START=0
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

main() {
  require_command systemctl
  require_command install
  require_command getent
  if [[ "${EUID}" -ne 0 || "${SERVICE_USER}" != "root" ]]; then
    require_command sudo
  fi

  [[ -f "${TEMPLATE_FILE}" ]] || fail "service template not found: ${TEMPLATE_FILE}"
  [[ -f "${ROOT_DIR}/setup.sh" ]] || fail "CLIO root does not look valid: ${ROOT_DIR}"
  [[ -f "${WEBAPP_DIR}/package.json" ]] || fail "webapp package.json not found: ${WEBAPP_DIR}/package.json"
  getent passwd "${SERVICE_USER}" >/dev/null || fail "user not found: ${SERVICE_USER}"

  if [[ -z "${SERVICE_GROUP}" ]]; then
    SERVICE_GROUP="$(primary_group_for_user "${SERVICE_USER}")"
  fi
  getent group "${SERVICE_GROUP}" >/dev/null || fail "group not found: ${SERVICE_GROUP}"

  local service_home
  service_home="$(home_for_user "${SERVICE_USER}")"
  [[ -n "${service_home}" ]] || fail "could not determine home directory for ${SERVICE_USER}"

  prepare_webapp

  local npm_dir
  local node_dir
  local path_value
  npm_dir="$(dirname "$(command -v npm)")"
  node_dir="$(dirname "$(command -v node)")"
  path_value="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  path_value="$(append_path_dir "${node_dir}" "${path_value}")"
  path_value="$(append_path_dir "${npm_dir}" "${path_value}")"

  local tmp_unit
  tmp_unit="$(mktemp)"
  render_unit "${service_home}" "${path_value}" > "${tmp_unit}"

  log "installing ${SERVICE_NAME} into ${UNIT_DIR}"
  sudo_cmd install -d -m 0755 "${UNIT_DIR}"
  sudo_cmd install -m 0644 "${tmp_unit}" "${UNIT_DIR}/${SERVICE_NAME}"
  rm -f "${tmp_unit}"

  log "reloading systemd"
  sudo_cmd systemctl daemon-reload

  if [[ "${DO_ENABLE}" -eq 1 ]]; then
    log "enabling ${SERVICE_NAME} for multi-user.target"
    sudo_cmd systemctl enable "${SERVICE_NAME}"
  else
    log "service installed but not enabled"
  fi

  if [[ "${DO_START}" -eq 1 ]]; then
    log "starting ${SERVICE_NAME}"
    sudo_cmd systemctl restart "${SERVICE_NAME}"
    sudo_cmd systemctl --no-pager --lines=12 status "${SERVICE_NAME}" || true
  else
    log "service installed but not started"
  fi

  log "unit file: ${UNIT_DIR}/${SERVICE_NAME}"
  log "logs: journalctl -u ${SERVICE_NAME} -f"
}

main "$@"
