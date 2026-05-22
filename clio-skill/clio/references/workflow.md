# CLIO Wiki Context Workflow

Use this workflow when a development task can benefit from existing CLIO
knowledge.

1. Locate the CLIO root.
   - Prefer the current repository if it contains `llm-wiki.md` and `wiki/index.md`.
   - Otherwise walk upward from the current directory.
   - If no CLIO root is found, continue without CLIO context and say so briefly.
2. Read `wiki/index.md`.
   - Use it as a map, not as the full evidence.
   - Pick the smallest relevant set of pages.
3. Read candidate pages.
   - For code tasks, start with `wiki/code/<project>/overview.md` when present.
   - Then inspect module, API, architecture, testing, or debug pages as needed.
   - For source-backed claims, read the linked `wiki/sources/...` pages.
4. Search only when the index is insufficient.
   - Prefer `rg` over broad file reads.
   - Use graph/qmd output only to find candidates.
5. Answer or implement with citations.
   - Mention the wiki pages that influenced the work.
   - If CLIO evidence is stale or missing, say so rather than guessing.

For ordinary coding tasks, CLIO context should be quick and targeted. Do not turn
every small edit into a full wiki operation.
