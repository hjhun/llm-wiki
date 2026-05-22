#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${ROOT_DIR}/clio"
TARGETS="global"
PROJECT_DIR=""

log() {
  printf '[clio-skill] %s\n' "$*"
}

fail() {
  printf '[clio-skill] error: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: skills.sh install [global|project|both|none] [options]

Install the CLIO agent skill.

Targets:
  global            Install to ~/.agents/skills/clio (default)
  project           Install to <project>/.agents/skills/clio
  both              Install to both global and project targets
  none              Do nothing

Options:
  --project-dir <path>          CLIO project directory for project/both targets
  --global-skills-dir <path>    Override global skills directory
                                (default: ~/.agents/skills)
  -h, --help                    Show this help
EOF
}

absolute_path() {
  local requested="$1"
  local parent=""
  local base=""

  if [[ "${requested}" == "." ]]; then
    pwd
    return
  fi

  parent="$(dirname "${requested}")"
  base="$(basename "${requested}")"
  mkdir -p "${parent}"
  parent="$(cd "${parent}" && pwd)"
  printf '%s/%s\n' "${parent}" "${base}"
}

copy_skill() {
  local dest="$1"

  [[ -d "${SOURCE_DIR}" ]] || fail "missing skill source: ${SOURCE_DIR}"
  [[ -f "${SOURCE_DIR}/SKILL.md" ]] || fail "missing skill source file: ${SOURCE_DIR}/SKILL.md"

  mkdir -p "${dest}"
  find "${dest}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  (cd "${SOURCE_DIR}" && tar -cf - .) | (cd "${dest}" && tar -xf -)
  log "installed clio skill to ${dest}"
}

parse_args() {
  [[ $# -gt 0 ]] || fail "missing command; expected: install"

  case "$1" in
    install)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown command: $1"
      ;;
  esac

  if [[ $# -gt 0 ]]; then
    case "$1" in
      global|project|both|none)
        TARGETS="$1"
        shift
        ;;
    esac
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-dir)
        [[ $# -ge 2 ]] || fail "--project-dir requires a value"
        PROJECT_DIR="$2"
        shift 2
        ;;
      --global-skills-dir)
        [[ $# -ge 2 ]] || fail "--global-skills-dir requires a value"
        CLIO_GLOBAL_SKILLS_DIR="$2"
        shift 2
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
}

install_targets() {
  local global_dir="${CLIO_GLOBAL_SKILLS_DIR:-${HOME:-}/.agents/skills}"
  local project_skill_dir=""

  case "${TARGETS}" in
    none)
      log "skill installation skipped"
      return
      ;;
    global|project|both)
      ;;
    *)
      fail "unknown install target: ${TARGETS}"
      ;;
  esac

  if [[ "${TARGETS}" == "global" || "${TARGETS}" == "both" ]]; then
    [[ -n "${HOME:-}" || -n "${CLIO_GLOBAL_SKILLS_DIR:-}" ]] || fail "HOME is required for global install"
    copy_skill "$(absolute_path "${global_dir}")/clio"
  fi

  if [[ "${TARGETS}" == "project" || "${TARGETS}" == "both" ]]; then
    [[ -n "${PROJECT_DIR}" ]] || fail "--project-dir is required for project install"
    project_skill_dir="$(absolute_path "${PROJECT_DIR}")/.agents/skills/clio"
    copy_skill "${project_skill_dir}"
  fi
}

parse_args "$@"
install_targets
