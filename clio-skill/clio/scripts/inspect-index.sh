#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"

if [[ -z "${root}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! root="$("${script_dir}/find-clio-root.sh" 2>/dev/null)"; then
    printf 'CLIO root not found\n' >&2
    exit 1
  fi
fi

index="${root}/wiki/index.md"
[[ -f "${index}" ]] || {
  printf 'missing index: %s\n' "${index}" >&2
  exit 1
}

sed -n '1,240p' "${index}"
