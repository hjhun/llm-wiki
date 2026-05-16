# webapp/

Local web UI for CLIO - LLM WIKI (Next.js 15 + React 19 + Tailwind 3.4).

The wiki is operated through four vertical tabs on the left: **Chat / Explorer / Graph / Settings**.

## Directory Roles

| Path | Description |
|---|---|
| `app/` | Next.js App Router. The `(protected)` route group is session-guarded. |
| `app/api/` | Server routes: auth, files, chat, graph, and settings. |
| `components/` | UI components such as Sidebar and AuthCard. |
| `lib/` | Server libraries such as `paths.ts`, `config.ts`, and `auth.ts`. |

## Relationship to the Wiki Repository

This folder accesses data in the wiki repository, which is the parent directory, through **relative paths**.

- `raw/`, `wiki/`, `sessions/`, `tools/`, `config/`, and `.agents/skills/` all live at the wiki root, the parent directory.
- `lib/paths.ts` automatically detects the wiki root using the `llm-wiki.md` or `CLAUDE.md` marker.
- The root can also be specified explicitly through the `PROJECT_ROOT` environment variable.

## Run

```bash
# Development, using ../config/default.json + ../config/local.json server.host/port
npm run dev

# Development, reachable from the same LAN/VPN
npm run dev:lan

# Production build + run
npm run build
npm start

# Production run, reachable from the same LAN/VPN
npm run start:lan

# Typecheck
npm run typecheck
```

`npm run dev` and `npm start` honor the Settings page host/port values on
the next server start. The default host is `0.0.0.0`, so the server is reachable
from any machine on the same network at `http://<server-ip>:<port>`. The
`*:lan` scripts force `0.0.0.0` regardless of Settings; set host to `127.0.0.1`
in Settings (or `config/local.json`) when you want to restrict access.

On first run, set the administrator password at `/setup`. The password hash and session secret are stored in `../config/local.json`, which is excluded from git tracking.

## Dependencies

- `next`, `react`, `react-dom`
- `bcryptjs` — password hashing
- `jose` — session JWT (HS256)
- `zod` — input/config validation
- `tailwindcss` 3.4

Install from this folder with `npm install`.
