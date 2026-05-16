# webapp/

Local web UI for LLM Wiki (Next.js 15 + React 19 + Tailwind 3.4).

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
# Development (port 7777, bound to 127.0.0.1)
npm run dev

# Production build + run
npm run build
npm start

# Typecheck
npm run typecheck
```

On first run, set the administrator password at `/setup`. The password hash and session secret are stored in `../config/local.json`, which is excluded from git tracking.

## Dependencies

- `next`, `react`, `react-dom`
- `bcryptjs` — password hashing
- `jose` — session JWT (HS256)
- `zod` — input/config validation
- `tailwindcss` 3.4

Install from this folder with `npm install`.
