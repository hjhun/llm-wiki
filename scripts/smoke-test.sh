#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBAPP_DIR="${ROOT_DIR}/webapp"

log() {
  printf '[smoke] %s\n' "$*"
}

fail() {
  printf '[smoke] error: %s\n' "$*" >&2
  exit 2
}

require_file() {
  local path="$1"
  [[ -f "${ROOT_DIR}/${path}" ]] || fail "missing file: ${path}"
}

require_dir() {
  local path="$1"
  [[ -d "${ROOT_DIR}/${path}" ]] || fail "missing directory: ${path}"
}

log "checking required files"
require_file "AGENTS.md"
require_file "CLAUDE.md"
require_file "README.md"
require_file "setup.sh"
require_file "scripts/install.sh"
require_file ".github/workflows/release.yml"
require_file "systemd/clio-web.service"
require_file "systemd/install-clio-web-service.sh"
require_file "config/default.json"
require_file "wiki/index.md"
require_file "wiki/log.md"
require_file ".agents/skills/wiki-ingest/SKILL.md"
require_file ".agents/skills/wiki-query/SKILL.md"
require_file ".agents/skills/wiki-lint/SKILL.md"
require_file ".agents/skills/wiki-graphify/SKILL.md"
require_file ".agents/skills/wiki-search-qmd/SKILL.md"
require_file ".agents/skills/wiki-marp/SKILL.md"
require_file "examples/raw/llm-wiki-demo.md"
require_file "docs/GUIDE.md"
require_file "docs/GUIDE_ko.md"

require_dir "raw"
require_dir "wiki"
require_dir "tools"
require_dir "webapp"

log "checking setup.sh syntax"
bash -n "${ROOT_DIR}/setup.sh"

log "checking scripts/install.sh syntax"
bash -n "${ROOT_DIR}/scripts/install.sh"

log "checking systemd installer syntax"
bash -n "${ROOT_DIR}/systemd/install-clio-web-service.sh"

log "checking setup.sh help"
"${ROOT_DIR}/setup.sh" --help >/dev/null

log "checking setup.sh installs missing webapp dependencies"
tmp_root="$(mktemp -d)"
cleanup_tmp_root() {
  rm -rf "${tmp_root}"
}
trap cleanup_tmp_root EXIT
mkdir -p "${tmp_root}/webapp/node_modules/next" "${tmp_root}/bin"
cp "${ROOT_DIR}/setup.sh" "${tmp_root}/setup.sh"
cat > "${tmp_root}/webapp/package.json" <<'JSON'
{
  "scripts": {
    "build": "true"
  },
  "dependencies": {
    "cytoscape": "^3.33.3",
    "next": "^15.1.0"
  }
}
JSON
cat > "${tmp_root}/webapp/node_modules/next/package.json" <<'JSON'
{
  "name": "next"
}
JSON
cat > "${tmp_root}/bin/npm" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CLIO_FAKE_NPM_LOG}"
exit 0
SH
chmod +x "${tmp_root}/bin/npm"
CLIO_FAKE_NPM_LOG="${tmp_root}/npm.log" \
  PATH="${tmp_root}/bin:${PATH}" \
  "${tmp_root}/setup.sh" --skip-graphify --skip-build >/dev/null
grep -qx 'install' "${tmp_root}/npm.log" || fail "setup.sh did not install missing webapp dependencies"

log "checking scripts/install.sh help"
"${ROOT_DIR}/scripts/install.sh" --help >/dev/null

log "checking setup.sh idempotent no-network path"
"${ROOT_DIR}/setup.sh" --skip-graphify --skip-npm-install --skip-build >/dev/null

log "checking webapp typecheck"
(cd "${WEBAPP_DIR}" && npm run typecheck)

log "checking webapp production build"
(cd "${WEBAPP_DIR}" && npm run build)

log "smoke test complete"
