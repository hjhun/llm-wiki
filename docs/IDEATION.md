# LLM Wiki Project Ideation

> An ideation document for an open project that packages Andrej Karpathy's [`llm-wiki.md`](./llm-wiki.md) pattern so anyone can run their own LLM Wiki with a single `setup.sh`.

## 1. Overview

### 1.1 Background
- Conventional RAG "rediscovers" answers from the source material on every query. Knowledge does not accumulate.
- Karpathy's LLM Wiki pattern has an LLM maintain a **persistent, incrementally growing wiki**, a set of Markdown documents. The human gathers sources and asks questions; the LLM handles summaries, cross-references, and maintenance work.
- This project packages that idea as an **immediately usable tool**. The user can `git clone`, run `./setup.sh`, open the browser, drop material into `raw/`, and run one `/ingest` command to grow the wiki.

### 1.2 Goals
- **Reproducible setup**: `setup.sh` handles global graphify install/detection, optional helper tools, and app build. Coding agent CLIs are used from the **host installation**.
- **Agent-independent operation**: automatically detect whichever CLI the user has among codex/claude/gemini/cline and run the same workflow.
- **Integrated UI for wiki + graph + chat + explorer**: everything in one browser workspace.
- **The wiki is a plain Markdown git repository**: 100% compatible with external tools such as Obsidian.
- **Extensibility**: add new skills, tools, and CLI adapters as modules.

### 1.3 Non-Goals for Now
- Multi-user or SaaS productization. The first target is local single-user use.
- Vector DB infrastructure. `index.md` plus optional `qmd`-level search is enough.
- Hosting an LLM directly. Work is delegated to external coding agent CLIs.

---

## 2. Core Idea Summary (`llm-wiki.md`)

Separate the system into three layers.

- **Raw sources** (`raw/`) - original material gathered by the user. Immutable. Articles, papers, images, notes.
- **Wiki** (`wiki/`) - structured Markdown written and maintained by the LLM. Entities, concepts, summaries, comparisons, synthesis.
- **Schema** - rules that tell the LLM how to operate the wiki. In this project, `CLAUDE.md` and `AGENTS.md` play that role.

Three operations:

- **Ingest**: read a new source, create a summary page, update entity/concept pages, and update `index.md` and `log.md`.
- **Query**: search and synthesize from the wiki first, then feed good answers back into the wiki.
- **Lint**: health-check contradictions, orphan pages, broken links, and missing updates.

This project provides those three operations as **three skills** and **three slash commands**.

---

## 3. Directory Structure (Current + Planned)

```text
llm-wiki/
├── llm-wiki.md              # Original idea file (Karpathy). Do not modify.
├── IDEATION.md              # This document
├── CLAUDE.md                # Wiki operating rules (schema layer)
├── AGENTS.md                # Mirror of CLAUDE.md
├── setup.sh                 # One-command setup script
├── README.md                # User-facing quick start
│
├── raw/                     # User source material (immutable)
├── wiki/                    # Wiki maintained by the LLM
│   ├── index.md             # Content catalog
│   ├── log.md               # Chronological operation log
│   └── ...                  # Entity, concept, and summary pages
├── sessions/                # Chat session records (md)
│   └── <YYYY-MM-DD>/<HHMMSS>_<subject>.md
├── tools/                   # Project-local helper tools such as qmd
│
├── .agents/
│   └── skills/              # Project-specific skills (override globals)
│       ├── wiki-ingest/SKILL.md
│       ├── wiki-query/SKILL.md
│       ├── wiki-lint/SKILL.md
│       ├── wiki-graphify/SKILL.md       # graphify integration
│       ├── wiki-search-qmd/SKILL.md     # optional, active when qmd is installed
│       └── wiki-marp/SKILL.md           # optional slide generation
│
├── webapp/                  # Next.js full-stack app (UI + API + CLI spawn)
│   ├── app/                 # App Router
│   │   ├── (protected)/     # Session guard: chat / explorer / graph / settings
│   │   ├── setup/, login/   # First-run password setup and login
│   │   └── api/             # /api/auth, /api/files, /api/chat, /api/graph
│   ├── components/          # Sidebar, AuthCard, ...
│   ├── lib/                 # paths.ts, config.ts, auth.ts
│   ├── package.json
│   └── README.md
│
└── config/
    ├── default.json         # Port, default CLI, wiki paths, and so on
    └── local.json           # User overrides (gitignored)
```

---

## 4. CLAUDE.md / AGENTS.md (Schema Layer)

This project's CLAUDE.md declares: "**This repository is an LLM Wiki, and you are its maintainer.**" AGENTS.md mirrors the same content so Codex and other agents follow the same rules.

Core sections:

1. **Purpose and roles**: wiki maintainer; user as curator.
2. **Path rules**: `raw/` immutable, `wiki/` LLM-owned, plus `sessions/` and `tools/`.
3. **Operation definitions**: input, output, and update targets for Ingest / Query / Lint.
4. **Page conventions**:
   - Entity pages, concept pages, source summary pages, comparison/analysis pages.
   - Use wikilinks `[[Page]]`.
   - YAML frontmatter: `type`, `tags`, `sources`, `updated`.
5. **Index/log rules**:
   - `wiki/index.md` as a category catalog.
   - `wiki/log.md` format: `## [YYYY-MM-DD HH:MM] ingest|query|lint | <title>`.
6. **Skill routing table**: which request calls which skill, with `.agents/skills/wiki-*/SKILL.md` paths.
7. **Graph integration**: graph creation/update must go through the `wiki-graphify` skill.
8. **Hard rules**: do not modify `raw/`; do not delete wiki pages arbitrarily, move them to `archive/`; do not guess external URLs.
9. **Override order**: direct user instruction > local CLAUDE.md/AGENTS.md > global CLAUDE.md > system defaults.

AGENTS.md contains the same rules and explicitly states that the two files must stay synchronized.

---

## 5. Skill Design (`.agents/skills/`)

All project skills live under `.agents/skills/<name>/SKILL.md`. CLAUDE.md states that coding agents should load project-local skills **before** global skills, especially for graphify.

Common frontmatter for each SKILL.md:

```yaml
---
name: <kebab-case>
description: <one-line trigger description>
allowed-cli: [codex, claude, gemini, cline]
---
```

### 5.1 `wiki-ingest`
- **Trigger**: `/ingest <path|URL>`, "ingest ...", or the chat `+` menu.
- **Input**: a single source (file/URL) or multiple sources (folder).
- **Chunk policy (required)**: coding agents lose quality or exceed context if too many files are provided at once. Therefore, always split work by **leaf directory**, meaning directories with no child directories.
  1. Walk the input path tree and list leaf directories, such as `raw/foo/bar/`.
  2. Treat each leaf directory as a **local chunk**. Run one ingest for only the files in that leaf, then create partial summary/entity pages.
  3. After every leaf is complete, run a **merge pass**: combine child-leaf summaries by parent directory, then update the root-level synthesis page, `index.md`, and `log.md` once more.
  4. A single file or URL is one chunk.
  5. Persist chunk progress as a checklist in `sessions/<date>/<time>_ingest.md` so work can be resumed.
- **Workflow per chunk**:
  1. Read sources in the chunk and extract key takeaways.
  2. Create `wiki/sources/<YYYY>/<YYYY-MM>/<slug>.md` with YAML frontmatter.
  3. Find and update related entity/concept pages, or create them if missing.
  4. If a contradiction is found, add a `> ⚠️ Conflicts with [[...]]` block to the relevant page.
  5. Append a chunk-level log entry to `wiki/log.md`.
- **Merge pass (once per full operation)**:
  1. Combine summaries from child leaves by parent directory and update parent concept/topic pages.
  2. Reorganize `wiki/index.md` in bulk.
  3. Optionally call `wiki-graphify update`.
- **Output**: chunk processing log, changed-file list, final synthesis summary, and recommended next actions.

### 5.2 `wiki-query`
- **Trigger**: `/query <question>`, general chat input, or questions without a slash command.
- **Workflow**:
  1. Scan `wiki/index.md` first and select candidate pages.
  2. If optional `wiki-search-qmd` is active, use it as a hybrid-search helper.
  3. If graph artifacts exist, use `wiki-graphify` as a graph-context helper for related nodes, communities, and cited-page clues.
  4. Read candidate pages and produce an answer with citations.
  5. Auto-select answer format: Markdown answer, comparison table, Marp slides, or matplotlib chart.
  6. With user confirmation, feed the answer back into `wiki/answers/<slug>.md` and update `index.md` and `log.md`.
- **Output**: answer, cited page links, and a "Save to wiki?" toggle.

### 5.3 `wiki-lint`
- **Trigger**: `/lint` or scheduled runs.
- **Checks**:
  - Contradictions between pages.
  - Stale claims invalidated by new sources.
  - Orphan pages with zero inbound links.
  - Frequently mentioned concepts without their own page.
  - Broken wikilinks.
  - Missing metadata/frontmatter.
- **Output**: `wiki/lint/<date>.md` report, split into automatically fixable items and items needing manual review.

### 5.4 `wiki-graphify` (graphify Integration)
- **Purpose**: create, update, and query a knowledge graph over `wiki/` and `raw/`.
- **Execution rule**: CLAUDE.md states that **graphify uses the global `graphify` command from `PATH`**. If missing, `setup.sh` installs the official `graphifyy` package and runs `graphify install`. The skill body repeats the same rule.
- **Commands**:
  - `wiki-graphify build` - full build, outputting `wiki/graph/graph.json` and `GRAPH_REPORT.md`.
  - `wiki-graphify update` - incremental update, triggered automatically after ingest when configured.
  - `wiki-graphify query "<question>"` - graph-based context and, when invoked directly, a graph-cited answer.
- **Chunk policy (required)**: graphifying the whole corpus at once can hit the coding agent context limit. Use the same principle as `wiki-ingest`: create **partial graphs by leaf directory** and then merge.
  1. List leaf directories in `raw/` and `wiki/`.
  2. For each leaf, use the global graphify CLI to build a **partial graph** into `wiki/graph/parts/<path-hash>.json`.
  3. After all leaves finish, run a **merge pass**: merge identical entities by node id/normalized name, recompute communities, and write final `wiki/graph/graph.json` and `GRAPH_REPORT.md`.
  4. `update` rebuilds only changed leaves and reruns the merge pass.
  5. Store progress in `wiki/graph/.state.json` as leaf path -> last build time/hash, so runs can resume.
- **Source**: <https://github.com/safishamsi/graphify>.
- **Integration point**: the Graph tab visualizes `wiki/graph/graph.json`. Build/Update buttons do not call graphify from the web server; they ask the default coding agent CLI in Settings to run `wiki-graphify build/update`. `wiki-query` can optionally use graph context as an auxiliary retrieval/context signal, similar to qmd, while keeping final answers grounded in wiki/source pages.
- **Adaptive ingest update**: after multi-agent ingest, `graph.autoUpdateStrategy=auto` uses leaf/file/byte/sub-chunk thresholds to decide whether to run scoped `update` between loop iterations. Small ingests prioritize the final `update` quality pass; large ingests refresh target leaf partials and immediately merge the full parts set for a connected graph.

### 5.5 Optional Tool Skills, Active When Installed
- `wiki-search-qmd` - if [qmd](https://github.com/tobi/qmd) exists, delegate BM25 + vector + LLM reranking search to `wiki-query`.
- `wiki-marp` - if Marp CLI exists, generate slide-style answers.
- `wiki-obsidian-clipper` - guide the user to use Obsidian Web Clipper. Automatic installation is not possible; provide guidance only.
- `wiki-images` - for sources with images, read text first, then open images separately for supplemental context, following the workaround from Karpathy's document.

The first step of each optional skill should be: "Check whether the required binary exists. If missing, disable gracefully and link installation guidance in README."

---

## 6. Web UI (Next.js Full-Stack, `webapp/`)

### 6.1 Basic Behavior
- All web UI source lives in `webapp/`: `webapp/app`, `webapp/components`, `webapp/lib`, and `webapp/package.json`.
- Wiki data (`raw/`, `wiki/`, `sessions/`, `tools/`, `config/`, `.agents/skills/`) remains at the wiki root, the parent directory. `webapp/lib/paths.ts` detects the root using the `llm-wiki.md`/`CLAUDE.md` marker, or `PROJECT_ROOT`.
- `setup.sh` runs `npm install && npm run build` in `webapp/`, then starts `npm start` at `http://localhost:<port>`. Default port is `9091`, bound to `127.0.0.1`.
- Four vertical tabs on the left: **Chat / Explorer / Graph / Settings**.
- Authentication: on first run, set the administrator password. Store a bcrypt hash and session secret in `config/local.json`. Sessions are jose HS256 JWTs issued as httpOnly cookies.

### 6.2 Chat Tab
- Top-right **[New Chat]** button. Clicking starts a new session; otherwise the previous session continues.
- Session storage: `sessions/<YYYY-MM-DD>/<HHMMSS>_<subject>.md`. The subject is a short LLM-generated summary of the first user message.
- The message area renders Markdown, including code blocks, checklists, and wikilinks. Clicking a wikilink jumps to the Explorer tab.
- Input area:
  - **`+` button** -> command palette for ingest, query, lint, file attachment, and image attachment.
  - **`/` autocomplete** -> `/ingest`, `/query`, `/lint`, extensible later.
  - File drag-and-drop -> choose between `raw/` import or attachment.
- Results appear as toast notifications and "changed wiki files" cards in chat. Clicking a card opens Explorer.

### 6.3 Explorer Tab
- Left tree file browser + right editor/preview.
- Workspace selectors: `wiki/`, `raw/`, `sessions/`.
- Markdown: editor plus **Preview** toggle for live rendering. Images, links, and wikilinks all work.
- Other files (text/json/png/pdf/etc.): appropriate viewer, such as monospace text, inline image, or iframe PDF.
- Actions: new file/folder, rename, delete (trash means move to `archive/`; permanent delete requires confirmation), upload.
- Changes under `raw/` show a banner: "The LLM recommends updating the wiki", with a one-click `/ingest` trigger.

### 6.4 Graph Tab
- Data sources: `wiki/graph/graph.json` and `wiki/graph/GRAPH_REPORT.md`.
- Visualization: force-directed graph via cytoscape.js or sigma.js. Cluster colors, node click opens a page preview side panel.
- Top controls: Rebuild / Incremental Update / search box / community toggle.
- Empty state: if no graph exists, show guidance and a "Build now" button that asks the default coding agent CLI to run `wiki-graphify build`.

### 6.5 Settings Tab
- **Admin**: change password, log out of sessions.
- **CLI selection**: dropdown for `codex | claude | gemini | cline`, plus path/model/extra flags per CLI. Show auto-detection results.
- **Wiki paths**: override `wiki/`, `raw/`, and `sessions/`.
- **Tool status**: graphify, qmd, and marp installation/version/active toggle.
- **Port/host**: service port and bind address, default `127.0.0.1`.
- **Backup**: `wiki/` git auto-commit on/off and push remote settings.

---

## 7. Coding Agent CLI Integration

### 7.0 Principle: Host First
- **Use the CLI already installed on the host PC.** This project does not create a separate isolated environment. It detects `codex`, `claude`, `gemini`, and `cline` from `PATH`.
- Detection order: 1. absolute path specified in `Settings`; 2. `which`/`whereis`; 3. common install locations such as `~/.npm-global/bin`, `~/.local/bin`, `/usr/local/bin`.
- CLIs not installed on the host are **not installed automatically**. Settings and README only provide official installation guidance. Best-effort installation is attempted only when an explicit option such as `setup.sh --install-cli=claude` is used.
- Every detected CLI is shown in Settings with version and path. The user chooses one as the "default agent".

### 7.1 Adapter Design
Following dormammu's `cli_adapter.py` pattern, Node has an adapter layer with the same mapping.

| CLI | Invocation shape | Directory option | yolo/allow flag |
|---|---|---|---|
| `codex` | `codex exec "<prompt>"` | change cwd | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude -p "<prompt>"` (print mode) | change cwd | `--dangerously-skip-permissions` |
| `gemini` | `gemini --prompt "<prompt>"` | `--include-directories` | `--approval-mode yolo` |
| `cline` | `cline -y "<prompt>"` | change cwd | `-y` (yolo mode, auto-approval) |

### 7.2 Safeguards
- yolo/bypass flags apply **only inside the local wiki directory**. The adapter forces `cwd` to the project root.
- Settings provides a "Safe mode" toggle that enables approval dialogs. The default is yolo for convenience, with a strong warning banner.
- Logs: store stdout/stderr from every CLI call in `sessions/.cli/<timestamp>.log`. Chat receives only a summary.

### 7.3 Session Persistence
- Chat session Markdown files are the conversation history. If the CLI is stateless, such as `claude -p`, inject the full session Markdown as context on every turn.
- A "Continue last session" button starts a new turn with the most recent session Markdown as context.

---

## 8. `setup.sh` Behavior

Order:

1. **Prerequisite checks**: `git`, `bash`, `curl`, `python3`, `node` (>=20), `pnpm` (enable corepack if missing), `whereis`, and so on.
2. **graphify install/detection**: by default, find `graphify` in `PATH`, read the installed `graphifyy` package version, upgrade `graphifyy` to the latest available package globally, and run `graphify install`. Prefer `pipx`; use `pip --user` only when Python is not externally managed. With `--skip-graphify`, skip installation/upgrade and use only an already-installed global `graphify`.
3. **Coding agent CLI detection (no install)**: search for `codex`, `claude`, `gemini`, and `cline` in `PATH` and common install paths. Record found items with path/version in `config/cli-detected.json`.
   - If at least one is found, continue. If none are found, warn and continue so the user can set a manual path in Settings.
   - **Automatic installation is disabled by default.** Only if the user passes `--install-cli=<name>[,<name>...]` should setup attempt official installation for that CLI, for example `--install-cli=claude` -> `npm i -g @anthropic-ai/claude-code`.
   - Installation failures print guidance and do not stop setup.
4. **Helper tools**: qmd is installed by default as the wiki search helper; heavier or presentation-focused tools such as Marp remain opt-in.
5. **App build**: `cd webapp && npm install && npm run build`, or pnpm.
6. **Initialization**: create templates for `wiki/index.md`, `wiki/log.md`, `wiki/.gitignore`, and `config/local.json` if missing.
7. **First run**: prompt for administrator password, save hash, and show service start instructions such as `cd webapp && npm start` or `./run.sh`.
8. **POST checks**: check port and open the browser automatically when possible.

Flags:

- `--port <n>` default 9091
- `--install-cli=<name>[,<name>]` opt-in install attempt for missing coding agent CLIs; default behavior is detection only
- `--skip-qmd`, `--with-marp` helper tool setup
- `--dev` development mode using `pnpm dev` with hot reload

---

## 9. Security and Permissions

- **Local only**: default bind is `127.0.0.1`. External exposure requires an explicit option.
- **Administrator password**: forced on first run, stored as a bcrypt hash. Session cookie expires after 24h, configurable later.
- **Read-only mode (future)**: expose only Explorer/Graph through a guest token.
- **CLI call isolation**: force cwd, whitelist environment variables, avoid shell interpolation by using Node `execFile` or `spawn` argument arrays.
- **Sensitive file guard**: hide `.env`, `config/local.json`, and `**/credentials*` by default in Explorer.

---

## 10. Work Roadmap (Suggested Phases)

Each phase is scoped so it can become an independent PR or session.

- **Phase 0 - Agreement**: approve IDEATION.md (current).
- **Phase 1 - Schema layer**: write CLAUDE.md / AGENTS.md, `wiki/index.md`/`log.md` templates, and `.gitignore`.
- **Phase 2 - Core skills**: skeletons for `wiki-ingest`, `wiki-query`, and `wiki-lint`, plus minimal scenario manuals.
- **Phase 3 - graphify integration**: global graphify install/detection, `wiki-graphify` skill, execution rules, first graph output.
- **Phase 4 - Next.js app scaffold**: four tabs, auth, file IO API, CLI adapter, chat session storage.
- **Phase 5 - `setup.sh`**: automate all items, idempotency, flags.
- **Phase 6 - Optional tool skills**: qmd / marp detection and integration.
- **Phase 7 - Docs and QA**: README, first-run guide, one sample raw file, full ingest demo.

---

## 11. Decisions and Open Research

- **cline CLI**: use `cline -y "<prompt>"` as the standard non-interactive yolo form. If not installed on the host, show it as inactive in Settings and provide install guidance only.
- **Gemini CLI option changes**: `--approval-mode` may change in the future. Add version detection to the adapter.
- **Codex CLI package name**: installation source may vary by user environment and needs standardization.
- **Graph visualization library**: benchmark cytoscape.js vs sigma.js. Initial recommendation: cytoscape, because community examples are plentiful.
- **Wiki auto-commit policy**: decide between committing after every ingest and user-triggered commits.
- **Image attachment handling**: decide whether images uploaded in chat should be automatically moved to `raw/assets/`.
- **Multilingual behavior**: default UI is Korean, while English wiki content is allowed. Expose writing language as a user setting in CLAUDE.md.

---

## 12. Shared Operation Principle: Leaf-First + Merge

This cross-cutting principle applies to both ingest and graphify.

- **Leaf-directory processing**: never start by throwing the whole root at the agent. Split the tree into small units at directories with no child directories.
- **Preserve partial outputs**: each leaf result, such as a summary or partial graph, is saved as a separate file. If a run fails, retry only that leaf.
- **Integrate with a merge pass**: after all leaves finish, a separate merge stage builds indexes, parent pages, and the final graph.
- **Persist state**: record progress/completed chunks in `sessions/.../*_ingest.md`, `wiki/graph/.state.json`, and similar files. Interrupted work resumes automatically on the next run.
- **Protect the agent**: expose chunk token/file-count limits, such as N files or M total bytes per chunk, in config so they can be tuned to the host CLI context limit.

This principle is written with the same tone in CLAUDE.md / AGENTS.md and every SKILL.md, so any coding agent follows the same procedure.

## 13. One-Line Summary

> The user drops material into `raw/`. They type `/ingest` in the browser. The host coding agent (codex/claude/gemini/cline) grows `wiki/` leaf directory by leaf directory, then synthesizes it with a merge pass. graphify builds the graph the same way. Explorer lets the user inspect it, Chat lets them ask questions, and the wiki gets smarter every day.
