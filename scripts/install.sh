#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="hjhun/llm-wiki"
DEFAULT_VERSION="latest"
DEFAULT_FALLBACK_REF="main"
# When the caller does not pass --dir, fall back to ${HOME}/.clio so a fresh
# install lands in a hidden home directory by default. Anyone who needs the
# pre-1.0 behaviour of installing into ./clio can still pass --dir or set
# CLIO_INSTALL_DIR explicitly.
DEFAULT_DIR="${HOME:-${USERPROFILE:-.}}/.clio"

INSTALL_DIR="${CLIO_INSTALL_DIR:-${DEFAULT_DIR}}"
INSTALL_DIR_SET=0
REPO="${CLIO_REPO:-${DEFAULT_REPO}}"
VERSION="${CLIO_VERSION:-${DEFAULT_VERSION}}"
REF="${CLIO_REF:-}"
COMMAND="install"
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
Usage: install.sh [install|update|upgrade] [installer options] [setup.sh options]

Commands:
  install           Download CLIO, create a new project directory, and run setup.sh.
                    If the directory already contains CLIO, refresh project files
                    while preserving user data. This is the default command.
  update, upgrade   Update an existing CLIO directory from the selected release/ref.
                    Preserves raw/, wiki/, sessions/, config/local.json, .run/,
                    webapp/node_modules/, webapp/.next/, and webapp/.env*.

Installer options:
  --dir <path>       Install directory (default: ~/.clio).
                    For update/upgrade, defaults to . when run inside CLIO.
  --version <ver>    GitHub release tag to install, or "latest" (default: latest)
  --ref <ref>        GitHub tag, branch, or commit to install exactly.
                    Overrides --version; useful for main or a commit SHA.
  --repo <repo>      GitHub repo as owner/name or https://github.com/owner/name
                    (default: hjhun/llm-wiki)
  --no-setup         Download and unpack only; do not run setup.sh
  -h, --help         Show this help

Any other arguments are passed through to setup.sh.

Examples:
  curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/main/scripts/install.sh | bash -s -- --start
  curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/main/scripts/install.sh | bash -s -- update --dir ./clio --start
  bash scripts/install.sh update --ref main --skip-build
  curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/main/scripts/install.sh | bash -s -- --version v0.1.0
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

download_stdout() {
  local url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 15 "${url}"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- "${url}"
    return
  fi

  fail "curl or wget is required to download ${url}"
}

resolve_version_ref() {
  local repo_slug="$1"
  local version="$2"
  local release_json=""
  local tag=""

  [[ -n "${version}" ]] || fail "--version must not be empty"

  if [[ "${version}" != "latest" ]]; then
    printf '%s\n' "${version}"
    return
  fi

  if ! release_json="$(download_stdout "https://api.github.com/repos/${repo_slug}/releases/latest" 2>/dev/null)"; then
    if [[ "${repo_slug}" == "${DEFAULT_REPO}" && -n "${DEFAULT_FALLBACK_REF}" ]]; then
      warn "could not resolve latest release for ${repo_slug}; falling back to ${DEFAULT_FALLBACK_REF}"
      printf '%s\n' "${DEFAULT_FALLBACK_REF}"
      return
    fi
    fail "could not resolve the latest release for ${repo_slug}"
  fi
  tag="$(printf '%s\n' "${release_json}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

  [[ -n "${tag}" ]] || fail "latest release response for ${repo_slug} did not include tag_name"
  printf '%s\n' "${tag}"
}

parse_args() {
  if [[ $# -gt 0 ]]; then
    case "$1" in
      install|update|upgrade)
        COMMAND="$1"
        shift
        ;;
    esac
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        [[ $# -ge 2 ]] || fail "--dir requires a value"
        INSTALL_DIR="$2"
        INSTALL_DIR_SET=1
        shift 2
        ;;
      --version)
        [[ $# -ge 2 ]] || fail "--version requires a value"
        VERSION="$2"
        REF=""
        shift 2
        ;;
      --ref)
        [[ $# -ge 2 ]] || fail "--ref requires a value"
        REF="$2"
        VERSION=""
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

  if [[ "${requested}" == "." ]]; then
    pwd
    return
  fi

  parent="$(dirname "${requested}")"
  base="$(basename "${requested}")"

  [[ -n "${base}" && "${base}" != "." && "${base}" != "/" ]] || fail "invalid install directory: ${requested}"
  mkdir -p "${parent}"
  parent="$(cd "${parent}" && pwd)"
  printf '%s/%s\n' "${parent}" "${base}"
}

is_clio_project_dir() {
  local dir="$1"
  [[ -f "${dir}/setup.sh" && -f "${dir}/webapp/package.json" && -f "${dir}/llm-wiki.md" ]]
}

select_update_dir_default() {
  if [[ "${COMMAND}" != "install" && "${INSTALL_DIR_SET}" -eq 0 ]] && is_clio_project_dir "."; then
    INSTALL_DIR="."
  fi
}

download_source_archive() {
  local repo_slug="$1"
  local ref="$2"
  local tmp_dir="$3"
  local archive_url="https://codeload.github.com/${repo_slug}/tar.gz/${ref}"
  local archive_file="${tmp_dir}/source.tar.gz"
  local extract_dir="${tmp_dir}/extract"
  local extracted_root=""

  mkdir -p "${extract_dir}"

  log "downloading ${repo_slug}@${ref}" >&2
  download_file "${archive_url}" "${archive_file}"

  log "extracting source archive" >&2
  tar -xzf "${archive_file}" -C "${extract_dir}"
  extracted_root="$(find "${extract_dir}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "${extracted_root}" ]] || fail "downloaded archive did not contain a project directory"
  [[ -f "${extracted_root}/setup.sh" ]] || fail "downloaded archive is missing setup.sh"

  printf '%s\n' "${extracted_root}"
}

sync_path() {
  local source_root="$1"
  local target_root="$2"
  local rel_path="$3"
  local source_path="${source_root}/${rel_path}"
  local target_path="${target_root}/${rel_path}"
  local target_parent=""

  if [[ ! -e "${source_path}" && ! -L "${source_path}" ]]; then
    warn "source path missing in archive; skipping ${rel_path}"
    return
  fi

  target_parent="$(dirname "${target_path}")"
  mkdir -p "${target_parent}"

  if ! command -v rsync >/dev/null 2>&1; then
    sync_path_without_rsync "${source_path}" "${target_path}" "${rel_path}"
    return
  fi

  if [[ -d "${source_path}" && ! -L "${source_path}" ]]; then
    rsync -a --checksum --delete \
      --exclude 'node_modules/' \
      --exclude '.next/' \
      --exclude '.env' \
      --exclude '.env.*' \
      "${source_path}/" "${target_path}/"
    return
  fi

  rsync -a --checksum "${source_path}" "${target_path}"
}

sync_path_without_rsync() {
  local source_path="$1"
  local target_path="$2"
  local rel_path="$3"

  if [[ -d "${source_path}" && ! -L "${source_path}" ]]; then
    mkdir -p "${target_path}"
    if [[ "${rel_path}" == "webapp" ]]; then
      find "${target_path}" -mindepth 1 -maxdepth 1 \
        ! -name 'node_modules' \
        ! -name '.next' \
        ! -name '.env' \
        ! -name '.env.*' \
        -exec rm -rf {} +
    else
      find "${target_path}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    fi
    (cd "${source_path}" && tar -cf - .) | (cd "${target_path}" && tar -xf -)
    return
  fi

  cp -Pp "${source_path}" "${target_path}"
}

run_project_setup() {
  local target_dir="$1"
  local repo_slug="$2"
  local ref="$3"

  if [[ "${RUN_SETUP}" -eq 0 ]]; then
    log "setup skipped"
    return
  fi

  log "running setup.sh ${SETUP_ARGS[*]:-}"
  (
    cd "${target_dir}"
    CLIO_RELEASE_REPO="${repo_slug}" CLIO_RELEASE_REF="${ref}" bash ./setup.sh "${SETUP_ARGS[@]}"
  )
}

run_install() {
  local repo_slug="$1"
  local ref="$2"
  local target_dir="$3"
  local tmp_dir="$4"
  local extracted_root=""
  local not_clio_message=""

  if [[ -e "${target_dir}" || -L "${target_dir}" ]]; then
    if ! is_clio_project_dir "${target_dir}"; then
      not_clio_message="install directory already exists and does not look"
      not_clio_message+=" like a CLIO project: ${target_dir}."
      not_clio_message+=" Choose another path with --dir."
      fail "${not_clio_message}"
    fi
    log "install directory already exists; refreshing project files"
    log "preserving raw/, wiki/, sessions/, local config, and runtime data"
    run_update "${repo_slug}" "${ref}" "${target_dir}" "${tmp_dir}"
    return
  fi

  extracted_root="$(download_source_archive "${repo_slug}" "${ref}" "${tmp_dir}")"

  log "installing to ${target_dir}"
  mv "${extracted_root}" "${target_dir}"

  run_project_setup "${target_dir}" "${repo_slug}" "${ref}"

  log "installation complete"
  log "project directory: ${target_dir}"
}

run_update() {
  local repo_slug="$1"
  local ref="$2"
  local target_dir="$3"
  local tmp_dir="$4"
  local extracted_root=""
  local update_paths=(
    ".agents/skills"
    "cli-rs"
    "config/default.json"
    "docs"
    "scripts"
    "systemd"
    "webapp"
    "AGENTS.md"
    "CLAUDE.md"
    "LICENSE"
    "README.md"
    "llm-wiki.md"
    "setup.sh"
  )
  local rel_path=""

  [[ -d "${target_dir}" ]] || fail "update target does not exist: ${target_dir}"
  is_clio_project_dir "${target_dir}" || fail "update target does not look like a CLIO project: ${target_dir}"

  extracted_root="$(download_source_archive "${repo_slug}" "${ref}" "${tmp_dir}")"

  log "updating project files in ${target_dir}"
  for rel_path in "${update_paths[@]}"; do
    sync_path "${extracted_root}" "${target_dir}" "${rel_path}"
  done

  run_project_setup "${target_dir}" "${repo_slug}" "${ref}"

  log "update complete"
  log "preserved data directories: raw/, wiki/, sessions/"
  log "project directory: ${target_dir}"
}

main() {
  parse_args "$@"
  select_update_dir_default

  require_command tar
  require_command mktemp

  local repo_slug=""
  local target_dir=""
  local tmp_dir=""

  case "${COMMAND}" in
    install|update|upgrade)
      ;;
    *)
      fail "unknown command: ${COMMAND}"
      ;;
  esac

  repo_slug="$(normalize_repo_slug "${REPO}")"
  target_dir="$(absolute_install_dir "${INSTALL_DIR}")"
  if [[ -z "${REF}" ]]; then
    REF="$(resolve_version_ref "${repo_slug}" "${VERSION}")"
  fi

  tmp_dir="$(mktemp -d)"
  CLEANUP_DIR="${tmp_dir}"
  trap cleanup EXIT

  if [[ "${COMMAND}" == "install" ]]; then
    run_install "${repo_slug}" "${REF}" "${target_dir}" "${tmp_dir}"
  else
    run_update "${repo_slug}" "${REF}" "${target_dir}" "${tmp_dir}"
  fi
}

main "$@"
