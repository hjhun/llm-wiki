<p align="center">
  <img src="docs/svg/clio.svg" alt="CLIO" width="220">
</p>

# CLIO

**CLIO is a local-first LLM Wiki workbench.** Drop source material into `raw/`, let a coding agent maintain a human-readable Markdown wiki in `wiki/`, and use the browser UI to ingest, query, inspect, and graph your growing knowledge base.

CLIO implements the LLM Wiki pattern: the LLM does the maintenance work that people usually avoid, while the user stays in the curator role. The result is not only a chat transcript or vector index. It is a durable wiki that can be read, searched, reviewed, versioned, and improved over time.

<table>
<tr><td><b>Local-first knowledge base</b></td><td>Your original files live in <code>raw/</code>. CLIO writes summaries, concepts, entities, answers, indexes, and logs into <code>wiki/</code>.</td></tr>
<tr><td><b>Agent-operated wiki</b></td><td>Codex, Claude, Gemini, or cline can run the project skills for ingest, query, lint, and graph workflows.</td></tr>
<tr><td><b>Browser UI</b></td><td>Next.js app with Chat, Explorer, Graph, and Settings tabs for everyday operation.</td></tr>
<tr><td><b>Incremental ingest</b></td><td>Large source trees are processed leaf-first in small chunks, then merged into a coherent wiki.</td></tr>
<tr><td><b>Knowledge graph</b></td><td>Graph Build/Update requests go through the coding agent and the <code>wiki-graphify</code> skill, using the global <code>graphify</code> command.</td></tr>
<tr><td><b>Reviewable outputs</b></td><td>Markdown files, append-only logs, lint reports, graph JSON, and session records make the system inspectable.</td></tr>
</table>

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/v0.1.0/scripts/install.sh | bash -s -- --start
```

The installer downloads the `v0.1.0` release tarball into `./clio`, runs
`setup.sh`, and starts the web app. It never overwrites an existing directory;
choose another location with `--dir <path>` if `./clio` already exists.

Open from this machine:

```text
http://127.0.0.1:7777
```

CLIO binds to `0.0.0.0` by default, so other machines on the same LAN can also
reach it at `http://<server-ip>:7777`. Override with `--host 127.0.0.1` in the
installer command, `setup.sh --host 127.0.0.1` inside the project, or by editing
`server.host` in Settings if you want to restrict access.

On first visit, CLIO redirects to `/setup` so you can set the administrator password. After login, open Settings and choose the default coding agent CLI.

For a more detailed walkthrough, see [docs/first-run.md](./docs/first-run.md).

---

## What CLIO Does

CLIO turns a folder of source material into a maintained wiki.

1. You put source files in `raw/`.
2. You ask for an operation in the Chat tab, such as `/ingest raw/articles`.
3. The selected coding agent reads `AGENTS.md`, `CLAUDE.md`, and the project-local skill files.
4. The agent writes or updates pages under `wiki/`.
5. CLIO shows the result through Explorer, Chat, and Graph.

The important split is ownership:

| Path | Owner | Purpose |
|---|---|---|
| `raw/` | User | Original source material. CLIO and agents do not modify it. |
| `wiki/` | LLM agent | Maintained Markdown wiki. |
| `wiki/sources/YYYY/YYYY-MM/` | LLM agent | One summary page per source, grouped by source chronology. |
| `wiki/answers/` | LLM agent | Saved answers from query workflows. |
| `wiki/lint/` | LLM agent | Wiki health reports. |
| `wiki/graph/` | LLM agent + graphify | Graph JSON, graph report, partial graph state. |
| `sessions/` | System | Chat and CLI session records. |
| `.agents/skills/` | Project | Local agent skills that define CLIO operations. |
| `webapp/` | Project | Next.js web UI. |

---

## Core Workflows

Run these from the Chat tab:

```text
/ingest raw/<path>
/query <question>
/lint
```

Graph workflows are available from the Graph tab:

```text
wiki-graphify build
wiki-graphify update
wiki-graphify query "<question>"
```

The web app does not execute `graphify` directly. It asks the selected coding agent to run the `wiki-graphify` skill, and that skill performs the leaf-first graph build/update flow.

`graphify` itself should not require a separate API key in this integration.
If a Graph Build/Update request asks for a key, it usually means the selected
coding agent CLI is not logged in, or the webapp process was started without
the CLI's normal `HOME`/environment. Start CLIO from the same shell where the
CLI works, or configure the CLI credentials for the account running the webapp.

For `/query`, CLIO keeps the LLM Wiki pattern wiki-first: the agent reads `wiki/index.md`, selects candidate pages, and answers from cited wiki/source pages. Optional helpers such as `qmd` and `wiki-graphify` can improve candidate search and relationship context, but they do not replace page reading.

---

## Web UI

| Tab | Purpose |
|---|---|
| Chat | Send `/ingest`, `/query`, `/lint`, or natural-language requests to the selected coding agent. |
| Explorer | Browse and inspect files in the wiki workspace. |
| Graph | View graph status, trigger graph build/update, and inspect generated graph artifacts. |
| Settings | Configure the default coding agent, server options, graph settings, and password. |

---

## Supported Agent CLIs

CLIO is designed to work with host-installed coding agent CLIs.

| CLI | Invocation shape |
|---|---|
| `codex` | `codex exec "<prompt>"` |
| `claude` | `claude -p "<prompt>"` |
| `gemini` | `gemini --prompt "<prompt>"` |
| `cline` | `cline -y "<prompt>"` |

`setup.sh` detects available CLIs and writes the result to `config/cli-detected.json`. Missing CLIs can be installed manually or configured by path in Settings.

Optional best-effort install:

```bash
./setup.sh --install-cli=claude,gemini
```

---

## Graphify

CLIO uses [safishamsi/graphify](https://github.com/safishamsi/graphify) for knowledge graph generation.

`setup.sh` does not clone graphify into `tools/`. It uses the global `graphify` command. During setup it checks the installed `graphifyy` package version, upgrades to the latest package available from PyPI, logs the before/after version, and runs `graphify install` for the assistant integration.

If `graphify` is missing, setup follows the graphify README installation flow:

```bash
pipx install graphifyy && graphify install
```

If `pipx` is not available and Python allows user-site installs, setup falls
back to:

```bash
python3 -m pip install --user --upgrade graphifyy
graphify install
```

On Debian/Ubuntu systems with an externally managed Python environment
(PEP 668), setup skips the `pip --user` fallback and prints pipx guidance
instead of using `--break-system-packages`.

To skip graphify installation/upgrade and use an already-installed global command:

```bash
./setup.sh --skip-graphify
```

---

## Setup Script

The release installer is the recommended installation entrypoint for new users:

```bash
curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/v0.1.0/scripts/install.sh | bash -s -- --start
```

Installer options:

| Option | Description |
|---|---|
| `--dir <path>` | Install directory. Default: `./clio`. The installer fails if this path already exists. |
| `--ref <ref>` | GitHub tag, branch, or commit to download. Default: `v0.1.0`. |
| `--repo <repo>` | GitHub repo as `owner/name` or a `github.com` URL. Default: `hjhun/llm-wiki`. |
| `--no-setup` | Download and unpack only; do not run `setup.sh`. |

Any other arguments are passed through to `setup.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/hjhun/llm-wiki/v0.1.0/scripts/install.sh | bash -s -- --dir ./my-clio --skip-graphify --port 7788 --start
```

Prerequisites for the installer are `bash`, `tar`, and either `curl` or `wget`.
The project setup itself requires Node.js `>=20`, npm, Python 3, and one
supported coding agent CLI for full operation.

Inside an installed or cloned checkout, `setup.sh` remains the project setup and
runtime helper:

```bash
./setup.sh --help
```

Common options:

| Option | Description |
|---|---|
| `--start` | Start the web server in the background after setup. |
| `--shutdown` | Stop the running CLIO web server and exit. |
| `--no-restart` | With `--start`, fail if the target port is already in use. |
| `--port <n>` | Web UI port. Default: `7777`. |
| `--host <addr>` | Web UI host. Default: `0.0.0.0` (LAN-reachable). Use `127.0.0.1` to restrict to this machine. |
| `--dev` | Use the development server command. |
| `--skip-graphify` | Do not install graphify. Use existing global `graphify` if available. |
| `--skip-npm-install` | Skip `webapp/` dependency installation. |
| `--skip-build` | Skip `npm run build`. |
| `--with-qmd` | Best-effort optional qmd setup. |
| `--with-marp` | Best-effort optional Marp CLI setup. |

Server runtime files are written under `.run/`:

```text
.run/webapp.pid
.run/webapp.log
```

---

## Development

Requirements:

- Node.js `>=20`
- npm
- Python 3
- One supported coding agent CLI for full operation
- Optional: `graphify`, `qmd`, `marp`

Install without starting the server:

```bash
git clone https://github.com/hjhun/llm-wiki.git
cd llm-wiki
./setup.sh
```

Development server:

```bash
./setup.sh --skip-build --dev
cd webapp
npm run dev
```

Typecheck and build:

```bash
cd webapp
npm run typecheck
npm run build
```

Smoke test:

```bash
./scripts/smoke-test.sh
```

The smoke test checks required files, `setup.sh` syntax/help, an idempotent no-network setup path, TypeScript, and the production build.

---

## Project Structure

```text
.
├── .agents/skills/       # Project-local agent skills
├── config/               # Default and local configuration
├── docs/                 # First-run and QA documentation
├── examples/raw/         # Sample source material
├── raw/                  # User-owned source material
├── scripts/              # Project utility scripts
├── tools/                # Optional local helper tools such as qmd
├── webapp/               # Next.js web application
└── wiki/                 # Agent-maintained Markdown wiki
```

Important operating documents:

| File | Purpose |
|---|---|
| [AGENTS.md](./AGENTS.md) | Agent operating rules for Codex, Gemini, cline, and other agents. |
| [CLAUDE.md](./CLAUDE.md) | Claude-side mirror of the same operating rules. |
| [IDEATION.md](./IDEATION.md) | Product and architecture notes. |
| [docs/first-run.md](./docs/first-run.md) | First-run guide. |
| [docs/qa.md](./docs/qa.md) | QA checklist. |
| [tools/README.md](./tools/README.md) | Optional tool notes. |

---

## Security Model

- CLIO binds to `0.0.0.0` by default so other machines on the same LAN can connect via `http://<server-ip>:<port>`. Set `server.host` to `127.0.0.1` in Settings (or `config/local.json`) to restrict access to this machine.
- The administrator-password gate is the only auth layer. Treat LAN exposure accordingly: only run on a trusted network.
- First run requires an administrator password.
- `config/local.json`, sessions, runtime logs, and generated local state are git-ignored by default.
- `raw/` is treated as immutable source material. Agents must not edit, move, or delete it.
- Secrets and API keys must not be written into wiki pages or graph reports.
- Coding agent execution is routed through configured CLI adapters and project-local operating rules.

---

## Sample Demo

`raw/` is user-owned, so CLIO does not copy sample data into it automatically.

```bash
mkdir -p raw/demo
cp examples/raw/llm-wiki-demo.md raw/demo/
```

Then run in the Chat tab:

```text
/ingest raw/demo
/query Why is the leaf-first merge pass necessary in LLM Wiki?
```

---

## Documentation

| Document | What's covered |
|---|---|
| [First-run guide](./docs/first-run.md) | Install, start, login, choose agent, run demo ingest/query/graph. |
| [QA checklist](./docs/qa.md) | Smoke tests, manual web checks, ingest/query/graph checks, sensitive file review. |
| [Agent rules](./AGENTS.md) | Repository conventions, wiki ownership, skill routing, hard rules. |
| [Claude mirror](./CLAUDE.md) | Same rules for Claude-based agents. |
| [Tool notes](./tools/README.md) | graphify, qmd, and marp notes. |

---

## References

- [Andrej Karpathy, `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the original LLM Wiki pattern that inspired this project.
- [safishamsi/graphify](https://github.com/safishamsi/graphify) — knowledge graph generation used by CLIO's graph workflow.

---

## License

This project is licensed under the Apache License 2.0. See [LICENSE](./LICENSE).

---

## Status

CLIO is currently a local-first project scaffold and working prototype. The main surfaces are implemented, but the project is still early: expect the agent skills, graph schema, and setup ergonomics to continue evolving.
