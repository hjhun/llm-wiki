#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="hjhun/llm-wiki"
DEFAULT_REF="v0.1.0"
DEFAULT_DIR="clio"

INSTALL_DIR="${CLIO_INSTALL_DIR:-${DEFAULT_DIR}}"
REPO="${CLIO_REPO:-${DEFAULT_REPO}}"
REF="${CLIO_REF:-${DEFAULT_REF}}"
RUN_SETUP=1
SETUP_ARGS=()
CLEANUP_DIR=""

log() {
  printf '[clio-install] %s\n' "$*"
}

warn() {
  printf '[clio-install] warning: %s\n' "$*" >&2
}

fail() {
  printf '[clio-install] error: %s\n' "$*" >&2
  exit 2
}

cleanup() {
  if [[ -n "${CLEANUP_DIR}" ]]; then
    rm -rf "${CLEANUP_DIR}"
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [installer options] [setup.sh options]

Download CLIO from a GitHub source tarball, create a local project directory,
and run the project's setup.sh.

Installer options:
  --dir <path>       Install directory (default: ./clio)
  --ref <ref>        GitHub tag, branch, or commit to install (default: v0.1.0)
  --repo <repo>      GitHub repo as owner/name or https://github.com/owner/name
                    (default: hjhun/llm-wiki)
  --no-setup         Download and unpack only; do not run setup.sh
  -h, --help         Show this help

Any other arguments are passed through to setup.sh.

Examples:
  curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/v0.1.0/scripts/install.sh | bash -s -- --start
  bash scripts/install.sh --dir ./my-clio --skip-graphify --skip-build
  bash scripts/install.sh --ref main --no-setup
EOF
}

require_command() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || fail "${name} is required but was not found on PATH"
}

normalize_repo_slug() {
  local repo="$1"
  repo="${repo%.git}"
  repo="${repo%/}"

  case "${repo}" in
    https://github.com/*)
      repo="${repo#https://github.com/}"
      ;;
    http://github.com/*)
      repo="${repo#http://github.com/}"
      ;;
    git@github.com:*)
      repo="${repo#git@github.com:}"
      ;;
  esac

  repo="${repo%.git}"
  repo="${repo%/}"

  if [[ ! "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "--repo must be a GitHub owner/repo slug or github.com URL; got: ${repo}"
  fi

  printf '%s\n' "${repo}"
}

download_file() {
  local url="$1"
  local output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 -o "${output}" "${url}"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "${output}" "${url}"
    return
  fi

  fail "curl or wget is required to download ${url}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        [[ $# -ge 2 ]] || fail "--dir requires a value"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --ref)
        [[ $# -ge 2 ]] || fail "--ref requires a value"
        REF="$2"
        shift 2
        ;;
      --repo)
        [[ $# -ge 2 ]] || fail "--repo requires a value"
        REPO="$2"
        shift 2
        ;;
      --no-setup)
        RUN_SETUP=0
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        SETUP_ARGS+=("$@")
        break
        ;;
      *)
        SETUP_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

absolute_install_dir() {
  local requested="$1"
  local parent=""
  local base=""

  parent="$(dirname "${requested}")"
  base="$(basename "${requested}")"

  [[ -n "${base}" && "${base}" != "." && "${base}" != "/" ]] || fail "invalid install directory: ${requested}"
  mkdir -p "${parent}"
  parent="$(cd "${parent}" && pwd)"
  printf '%s/%s\n' "${parent}" "${base}"
}

main() {
  parse_args "$@"

  require_command tar
  require_command mktemp

  local repo_slug=""
  local target_dir=""
  local archive_url=""
  local tmp_dir=""
  local archive_file=""
  local extract_dir=""
  local extracted_root=""

  repo_slug="$(normalize_repo_slug "${REPO}")"
  target_dir="$(absolute_install_dir "${INSTALL_DIR}")"
  archive_url="https://codeload.github.com/${repo_slug}/tar.gz/${REF}"

  if [[ -e "${target_dir}" || -L "${target_dir}" ]]; then
    fail "install directory already exists: ${target_dir}. Choose another path with --dir; this installer never overwrites existing data."
  fi

  tmp_dir="$(mktemp -d)"
  CLEANUP_DIR="${tmp_dir}"
  trap cleanup EXIT
  archive_file="${tmp_dir}/source.tar.gz"
  extract_dir="${tmp_dir}/extract"
  mkdir -p "${extract_dir}"

  log "downloading ${repo_slug}@${REF}"
  download_file "${archive_url}" "${archive_file}"

  log "extracting source archive"
  tar -xzf "${archive_file}" -C "${extract_dir}"
  extracted_root="$(find "${extract_dir}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "${extracted_root}" ]] || fail "downloaded archive did not contain a project directory"
  [[ -f "${extracted_root}/setup.sh" ]] || fail "downloaded archive is missing setup.sh"

  log "installing to ${target_dir}"
  mv "${extracted_root}" "${target_dir}"

  if [[ "${RUN_SETUP}" -eq 0 ]]; then
    log "download complete; setup skipped"
    log "project directory: ${target_dir}"
    return 0
  fi

  log "running setup.sh ${SETUP_ARGS[*]:-}"
  (cd "${target_dir}" && bash ./setup.sh "${SETUP_ARGS[@]}")
  log "installation complete"
  log "project directory: ${target_dir}"
}

main "$@"
