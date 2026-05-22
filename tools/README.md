# tools/

This directory is reserved for **project-local helper tools** used by LLM Wiki. Tools that are naturally installed per repository, such as qmd, belong here.

All tools placed in this directory are excluded from git tracking by `.gitignore`. When the user opts into installation, `setup.sh` clones and sets them up under this directory.

## graphify

Used for knowledge graph creation, updates, and queries. The Graph tab does not execute graphify directly; it sends `wiki-graphify build/update` requests to the default coding agent CLI. When the coding agent runs the [`wiki-graphify`](../.agents/skills/wiki-graphify/SKILL.md) skill, it uses the global `graphify` command from `PATH`.

- Source: <https://github.com/safishamsi/graphify>
- Package: the official PyPI package name is `graphifyy`; the CLI command is `graphify`.
- Setup:
  ```bash
  ./setup.sh
  ```
- Manual install:
  ```bash
  pip install graphifyy && graphify install
  # or pipx
  pipx install graphifyy && graphify install
  ```

Using `./setup.sh --skip-graphify` skips installation attempts and uses only an already-installed global `graphify` from `PATH`.

## qmd

qmd is installed by default when `setup.sh` runs. The [`wiki-search-qmd`](../.agents/skills/wiki-search-qmd/SKILL.md) skill uses it as an auxiliary candidate search tool for `wiki-query`; final answers must still be grounded in wiki/source/raw pages that the agent actually reads.

- Package: `@tobilu/qmd`
- Recommended location: `tools/qmd/`
- Setup: `setup.sh` installs qmd when missing, creates the `wiki` collection when no collections exist, and runs `qmd update`.
- Skip setup: `setup.sh --skip-qmd`
- Manual install:
  ```bash
  npm install --prefix tools/qmd @tobilu/qmd
  tools/qmd/node_modules/.bin/qmd collection add wiki
  tools/qmd/node_modules/.bin/qmd update
  ```

## marp (Optional)

When installed, the [`wiki-marp`](../.agents/skills/wiki-marp/SKILL.md) skill can generate slide-style answers.

- Recommended location: `tools/marp-cli/`, or a global `marp` command, which needs no extra setup here.
- Setup: `setup.sh --with-marp`, or `npm i -g @marp-team/marp-cli`.

---

## Rules for Adding a New Tool

When adding a new helper tool to this directory, also do the following.

1. Add a `README.md` or entry script inside the tool folder.
2. Add a setup step to `setup.sh` behind an optional flag.
3. Create `.agents/skills/wiki-<tool-name>/SKILL.md`. Its first step should be: "Check the allowed execution path -> if unavailable, disable gracefully and point to the README."
4. Add a section to this `tools/README.md`.
5. Confirm that `.gitignore` excludes the tool folder automatically with a `tools/<name>/` pattern.
