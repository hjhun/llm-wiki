# CLIO Paths

Common CLIO paths:

| Path | Meaning |
|---|---|
| `raw/` | Original user-provided sources. Treat as read-only unless a CLIO preprocess workflow explicitly applies changes. |
| `raw/chat/` | User-approved external captures from chat or browser workflows. Existing captures are append-only evidence. |
| `wiki/` | Agent-maintained Markdown knowledge base. |
| `wiki/index.md` | Category catalog and first stop for narrowing context. |
| `wiki/log.md` | Append-only operation log. |
| `wiki/sources/` | Source summaries derived from original material. |
| `wiki/code/` | Code Wiki pages: project overviews, modules, APIs, architecture, testing, debug notes. |
| `wiki/answers/` | Query answers saved back into the wiki. |
| `wiki/lint/` | Wiki health reports. |
| `wiki/graph/` | Knowledge graph artifacts and graph reports. |

Project-local CLIO skills, when present, live under `.agents/skills/` and take
priority for CLIO operations such as ingest, query, lint, graph, preprocess, and
browser capture.
