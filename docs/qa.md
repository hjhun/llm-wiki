# QA Checklist

Use the following sequence before a release or after a large change.

## Quick Static Verification

```bash
./scripts/smoke-test.sh
```

Checks:

- Syntax check for `setup.sh`.
- Required documentation and skill files exist.
- `setup.sh --help` prints successfully.
- `setup.sh --skip-graphify --skip-npm-install --skip-build` runs idempotently.
- `webapp` typecheck.
- `webapp` production build.

## Manual Web Verification

```bash
./setup.sh --start --dev --skip-build
```

Browser:

```text
http://127.0.0.1:7777
```

Check:

- A password can be set at `/setup`.
- Login works.
- The default coding agent can be selected in the Settings tab.
- `wiki/index.md` and `wiki/log.md` can be opened in the Explorer tab.
- A message can be sent from the Chat tab.
- The Graph tab shows the empty-graph state and the Build button.

Shutdown:

```bash
./setup.sh --shutdown
```

## Sample Ingest Verification

Because `raw/` is user-owned, the user copies the sample.

```bash
mkdir -p raw/demo
cp examples/raw/llm-wiki-demo.md raw/demo/
```

Chat tab:

```text
/ingest raw/demo
```

Expected result:

- A sample summary page is created under `wiki/sources/YYYY/YYYY-MM/`.
- Related concept pages are created or updated.
- `wiki/index.md` is updated.
- An ingest entry is appended to `wiki/log.md`.

## Query Verification

Chat tab:

```text
/query Why is the leaf-first merge pass necessary?
```

Expected result:

- The answer includes citations to wiki pages.
- There are no unsupported assertions.
- A save toggle or `wiki/answers/` feedback notice is shown.

## Graph Verification

Click `Build` in the Graph tab.

Expected result:

- The coding agent runs `wiki-graphify build`.
- `wiki/graph/graph.json` is created.
- `wiki/graph/GRAPH_REPORT.md` is created.
- The Graph tab displays node, edge, and community counts.

Notes:

- graphify uses the global `graphify` command from `PATH`.
- If `setup.sh --skip-graphify` was used, installation is skipped, so a global `graphify` must already exist.
- The Graph tab does not execute graphify directly. It asks the default coding agent to do it.

## Sensitive Information Check

Before committing:

```bash
git status --short
```

Files that must not be tracked:

- `config/local.json`
- `config/cli-detected.json`
- `.run/*`
- `sessions/**`
- `webapp/.next/**`
- `webapp/node_modules/**`

## Recording Failures

If there is a problem, do not edit old entries in `wiki/log.md`; append a new entry instead.

```markdown
## [YYYY-MM-DD HH:MM] lint | QA failure record
- Symptom: ...
- Action: ...
```
