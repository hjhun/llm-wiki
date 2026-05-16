# First-Run Guide

This document walks a new user through running LLM Wiki for the first time and verifying the ingest flow with the sample material.

## 1. Install

```bash
./setup.sh
```

Default behavior:

- If `webapp/node_modules` already exists, `npm install` is skipped.
- If `graphify` is missing, the official `graphifyy` package is installed globally and `graphify install` is run.
- Coding agent CLIs (`codex`, `claude`, `gemini`, `cline`) are detected and recorded in `config/cli-detected.json`.
- The server is not started automatically.

To start the server immediately:

```bash
./setup.sh --start
```

This command starts the web app in the background and exits. Logs and the PID are stored under `.run/`.

```text
.run/webapp.pid
.run/webapp.log
```

Shutdown:

```bash
./setup.sh --shutdown
```

## 2. Open the Web UI

Open this URL in a browser.

```text
http://127.0.0.1:7777
```

On first visit, the app redirects to `/setup`. Set the administrator password there.

## 3. Select the Default Coding Agent

Open the Settings tab.

1. Check which CLI is available among `codex`, `claude`, `gemini`, and `cline`.
2. Click the `Use` button for the CLI you want to set as the default agent.
3. Enter a manual path if needed.
4. Save.

Chat and Graph Build/Update operations run through this default coding agent.

## 4. Prepare Sample Material

`raw/` is the user-owned source area. Automation does not modify it directly.

To run the demo, copy the sample yourself.

```bash
mkdir -p raw/demo
cp examples/raw/llm-wiki-demo.md raw/demo/
```

## 5. Ingest Demo

Run this in the Chat tab.

```text
/ingest raw/demo
```

Expected flow:

1. The coding agent reads `AGENTS.md` and the `wiki-ingest` skill.
2. `raw/demo` is processed as a leaf-directory chunk.
3. A summary page is created under `wiki/sources/...`.
4. Required concept/entity pages are created or updated.
5. `wiki/index.md` and `wiki/log.md` are updated.
6. Depending on settings, `wiki-graphify update` is recommended or run.

## 6. Query Demo

After ingest, ask this in the Chat tab.

```text
/query Why is the leaf-first merge pass necessary in LLM Wiki?
```

The answer should include citations to wiki pages.

## 7. Graph Demo

Click `Build` in the Graph tab.

Important: the Graph tab does not execute graphify directly. It asks the default coding agent to run `wiki-graphify build`, and the coding agent chooses the graphify execution path according to the skill rules.

Execution path:

1. Global `graphify` from `PATH`.
2. `python3 -m graphify` if the package is installed but the script path is not on `PATH`.

## 8. Troubleshooting

If the port is already in use:

```bash
./setup.sh --shutdown
./setup.sh --start
```

To reset the password, set `auth.passwordHash` and `auth.sessionSecret` in `config/local.json` back to `null`, then restart the server.

If no coding agent is detected, specify its path in the Settings tab or install that CLI on the host machine.
