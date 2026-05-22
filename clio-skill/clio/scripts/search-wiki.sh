#!/usr/bin/env bash
set -euo pipefail

query="${1:-}"
root="${2:-}"

[[ -n "${query}" ]] || {
  printf 'Usage: search-wiki.sh <query> [clio-root]\n' >&2
  exit 2
}

if [[ -z "${root}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! root="$("${script_dir}/find-clio-root.sh" 2>/dev/null)"; then
    printf 'CLIO root not found\n' >&2
    exit 1
  fi
fi

wiki="${root}/wiki"
[[ -d "${wiki}" ]] || {
  printf 'missing wiki directory: %s\n' "${wiki}" >&2
  exit 1
}

if command -v rg >/dev/null 2>&1; then
  rg -n --hidden --glob '*.md' -- "${query}" "${wiki}"
else
  grep -RIn --include='*.md' -- "${query}" "${wiki}"
fi
