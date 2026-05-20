# clio CLI

Native Rust command-line interface for the CLIO LLM wiki. It runs the same
operations as the web app's Chat tab from a terminal or a script.

`setup.sh` builds this crate in release mode and installs the binary to
`<install-dir>/bin/clio`. To build it directly:

```bash
cargo build --release
./target/release/clio --help
```

## Commands

| Command | Transport | Description |
|---|---|---|
| `clio raw add <path>...` | local FS | Copy files/folders into `raw/`; pass `--symlink` to add links instead. Re-adding an existing path replaces it and moves the old entry to `raw/.trash/`. |
| `clio raw remove <raw-path>...` | local FS | Soft-delete a file from `raw/` (moves it to `raw/.trash/`). |
| `clio raw list [raw-path]` | local FS | List files under `raw/`. |
| `clio ingest [path]` | webapp HTTP | Run one `/ingest` pass. |
| `clio ingest-loop` | webapp HTTP | Run `/ingest-loop` until the progress state is drained. |
| `clio query <question>` | webapp HTTP | Ask the wiki a question. |
| `clio lint [--fix]` | webapp HTTP | Run the wiki-lint health check. |
| `clio status` | webapp HTTP | Show resolved project, webapp URL, and token status. |

The `ingest`/`ingest-loop`/`query`/`lint` commands POST to the running
webapp's `/api/chat/send` endpoint. They therefore behave exactly like the
Chat tab — same configured coding agent, same ingest-loop orchestration,
same session logs. The `raw` subcommands never need the webapp; they only
touch the filesystem.

## Project & webapp discovery

Each invocation resolves a CLIO project root in this order:

1. `--home` flag / `CLIO_HOME` env var.
2. `~/.clio` if it is a CLIO project (the install default).
3. Walk up from the current directory looking for `llm-wiki.md` / `CLAUDE.md`.

It then reads `config/default.json` + `config/local.json` for:

- `server.host` / `server.port` → the webapp base URL (`0.0.0.0` is dialed
  as `127.0.0.1`). Override with `--base-url` / `CLIO_BASE_URL`.
- `auth.cliToken` → the bearer token sent as `Authorization: Bearer …`.
  Override with `--token` / `CLIO_TOKEN`.

`setup.sh` generates `auth.cliToken` via `webapp/scripts/ensure-cli-token.mjs`.

## Tests

```bash
cargo test
```

- Unit tests (`src/**`): path-traversal guards, base-URL building, NDJSON
  progress formatting.
- `tests/raw_cli.rs`: end-to-end `raw` subcommand behaviour against a temp
  project.
- `tests/http_cli.rs`: `ingest`/`query`/`lint` against an `httpmock` server,
  pinning the request body shape and bearer header.
