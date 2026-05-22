#!/usr/bin/env bash
set -euo pipefail

start="${1:-$(pwd)}"
dir="$(cd "${start}" && pwd)"

while [[ "${dir}" != "/" ]]; do
  if [[ -f "${dir}/llm-wiki.md" && -f "${dir}/wiki/index.md" ]]; then
    printf '%s\n' "${dir}"
    exit 0
  fi
  dir="$(dirname "${dir}")"
done

exit 1
