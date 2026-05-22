# CLIO Safety Rules

- Do not modify, delete, move, format, or clean files under `raw/` during normal
  development work.
- Do not cite real filesystem paths outside `raw/` for source material reached
  through an approved symlink; keep citations in logical `raw/...` form.
- Do not invent external URLs. Use only URLs present in source material or
  provided by the user.
- Do not place credentials, tokens, cookies, API keys, or private account data in
  wiki pages or final answers. Mask sensitive values if they appear in evidence.
- Do not edit `sessions/`, `.env*`, or `config/local.json`.
- For CLIO wiki pages, prefer Korean unless the user asks otherwise. Keep file
  names, identifiers, commands, URLs, and frontmatter keys in English.
- For code changes outside CLIO operations, treat the wiki as context and leave
  ingest/query/lint side effects alone unless explicitly requested.
