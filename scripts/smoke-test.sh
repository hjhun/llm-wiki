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

log "checking install refreshes an existing CLIO directory"
install_tmp="$(mktemp -d)"
mkdir -p "${install_tmp}/archive/llm-wiki-fake/"{.agents/skills,cli-rs,config,docs,scripts,systemd,webapp}
printf '%s\n' "#!/usr/bin/env bash" "exit 0" > "${install_tmp}/archive/llm-wiki-fake/setup.sh"
printf '%s\n' '{"name":"fake-webapp"}' > "${install_tmp}/archive/llm-wiki-fake/webapp/package.json"
printf '%s\n' "# fake llm wiki" > "${install_tmp}/archive/llm-wiki-fake/llm-wiki.md"
printf '%s\n' "new readme" > "${install_tmp}/archive/llm-wiki-fake/README.md"
touch \
  "${install_tmp}/archive/llm-wiki-fake/.agents/skills/placeholder" \
  "${install_tmp}/archive/llm-wiki-fake/cli-rs/placeholder" \
  "${install_tmp}/archive/llm-wiki-fake/config/default.json" \
  "${install_tmp}/archive/llm-wiki-fake/docs/placeholder" \
  "${install_tmp}/archive/llm-wiki-fake/scripts/install.sh" \
  "${install_tmp}/archive/llm-wiki-fake/systemd/clio-web.service" \
  "${install_tmp}/archive/llm-wiki-fake/AGENTS.md" \
  "${install_tmp}/archive/llm-wiki-fake/CLAUDE.md" \
  "${install_tmp}/archive/llm-wiki-fake/LICENSE"
(cd "${install_tmp}/archive" && tar -czf "${install_tmp}/source.tar.gz" llm-wiki-fake)

mkdir -p "${install_tmp}/target/"{raw,wiki,sessions,config,webapp}
printf '%s\n' "#!/usr/bin/env bash" "exit 0" > "${install_tmp}/target/setup.sh"
printf '%s\n' '{"name":"old-webapp"}' > "${install_tmp}/target/webapp/package.json"
printf '%s\n' "# old llm wiki" > "${install_tmp}/target/llm-wiki.md"
printf '%s\n' "old readme" > "${install_tmp}/target/README.md"
printf '%s\n' "raw data" > "${install_tmp}/target/raw/source.md"
printf '%s\n' "wiki data" > "${install_tmp}/target/wiki/index.md"
printf '%s\n' '{"auth":{"cliToken":"keep"}}' > "${install_tmp}/target/config/local.json"

cat > "${install_tmp}/curl" <<'SH'
#!/usr/bin/env bash
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ -n "${output}" ]] || exit 2
cp "${CLIO_FAKE_ARCHIVE}" "${output}"
SH
chmod +x "${install_tmp}/curl"

CLIO_FAKE_ARCHIVE="${install_tmp}/source.tar.gz" \
  PATH="${install_tmp}:${PATH}" \
  "${ROOT_DIR}/scripts/install.sh" --repo owner/repo --ref fake --dir "${install_tmp}/target" --no-setup >/dev/null
grep -qx 'new readme' "${install_tmp}/target/README.md" || fail "install did not refresh project files"
grep -qx 'wiki data' "${install_tmp}/target/wiki/index.md" || fail "install did not preserve wiki data"
grep -qx 'raw data' "${install_tmp}/target/raw/source.md" || fail "install did not preserve raw data"
grep -qx '{"auth":{"cliToken":"keep"}}' "${install_tmp}/target/config/local.json" || fail "install did not preserve local config"
rm -rf "${install_tmp}"

log "checking setup.sh idempotent no-network path"
"${ROOT_DIR}/setup.sh" --skip-graphify --skip-npm-install --skip-build >/dev/null

log "checking webapp typecheck"
(cd "${WEBAPP_DIR}" && npm run typecheck)

log "checking webapp production build"
(cd "${WEBAPP_DIR}" && npm run build)

log "smoke test complete"
