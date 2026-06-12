---
name: wiki-preprocess
description: Strip noise from raw/ before ingest. Translates the user's natural-language noise description into rules JSON, runs scripts/preprocess-raw.mjs in dry-run, presents a plan, and only on /preprocess --apply moves whole files to raw/.trash/ or rewrites a file in place after backing the original up. Triggered by /preprocess.
allowed-cli: [codex, claude, gemini, cline]
---

# wiki-preprocess

## LLM Wiki Pattern Reference

This skill is a CLIO-specific preparation step around the
[`llm-wiki.md`](../../../llm-wiki.md) raw-source layer. `llm-wiki.md` treats raw
sources as the user's source of truth; therefore preprocess is the only
controlled workflow that may mutate `raw/`, and it must preserve recoverability
through dry-run plans and `raw/.trash/` backups.

## Purpose

Remove obvious noise from material under `raw/` so that downstream `/ingest`
sees clean inputs. Two layers of cleaning:

1. **File-level trash** — whole files that are clearly junk (ad-only HTML
   pages, empty/stub files, duplicate snapshots) are moved to
   `raw/.trash/<ISO-ts>_<basename>`. They are recoverable.
2. **Content-level strip** — for files we want to keep, cut out noisy
   regions (site navigation, footers, cookie banners, "subscribe to our
   newsletter" lines). The original is backed up to `raw/.trash/` and the
   cleaned content is written back to the original path.

The skill does not invent patterns. The user describes the noise in
natural language; this skill translates that into a deterministic rules
JSON, hands it to `scripts/preprocess-raw.mjs`, and reports back what the
script would (or did) do.

## Triggers

- `/preprocess [path] [free-form description of noise]` — dry-run.
  Translates the description into rules, runs the script in `plan` mode,
  presents the plan in chat, and stops. Nothing under `raw/` is changed.
- `/preprocess --apply` — re-uses the most recent
  `wiki/.progress/preprocess/<ts>-plan.json` and runs the script in
  `apply` mode. Skips re-translation; if the user wants different rules,
  they should run `/preprocess <args>` again to regenerate the plan.
- Natural-language equivalents — "이 폴더에서 광고만 정리해줘",
  "raw/inbox 빈 파일 다 trash로 옮겨" — also map to this skill, but the
  user-visible command remains `/preprocess`.

No automatic trigger (watch / schedule) for now. Preprocess only runs
when the user asks for it explicitly.

## Input

- `target` — a path under `raw/`. Defaults to `raw/`.
- A free-form natural-language description of which patterns to remove
  (file-level, content-level, or both).
- Optional `--apply` flag to commit the most recent dry-run plan.

## Output

- `wiki/.progress/preprocess/<ts>-rules.json` — the rules JSON
  this skill produced from the user's description.
- `wiki/.progress/preprocess/<ts>-plan.json` — the script's plan
  (machine).
- `wiki/.progress/preprocess/<ts>-plan.md` — the chat-facing summary
  written by this skill (human).
- `wiki/.progress/preprocess/<ts>-applied.json` — produced by `apply`.
- Moves and rewrites under `raw/` (apply only).
- One line appended to `wiki/log.md` per apply run.
- Chat session log under `sessions/<date>/<time>_preprocess_<subject>.md`.

## Preflight

1. Confirm `wiki/log.md` exists. Create it with a Phase-1 template if missing.
2. Validate the target path is inside `raw/`. Reject anything outside.
3. Ensure `wiki/.progress/preprocess/` exists. Create `tmp/` if missing.
4. Read `config/default.json` for the `cli.timeouts.preprocess` bucket — that
   is enforced by the host webapp, not by this skill, but it constrains how
   much work one invocation can do.

## Workflow

### Step 0 — Start session and acquire lock

1. Create the chat log session file
   `sessions/<YYYY-MM-DD>/<HHMMSS>_preprocess_<subject>.md` (frontmatter
   only).
2. Acquire `wiki/.progress/preprocess/.lock`. Same atomic
   `tmp/<rand>.lock` + rename pattern that wiki-ingest uses, with body
   `{"pid": <int>, "started_at": <ISO8601>, "session": "<rel path>"}`.
   - If `.lock` already exists and the recorded `pid` is alive, **abort**
     with a chat message telling the user to wait or remove the lock.
   - The ingest and lint locks are independent; if they are held, note
     that fact in chat but continue. Preprocess only touches `raw/`,
     never `wiki/sources/` or `wiki/lint/`.

### Step 1 — Parse arguments

- `/preprocess --apply [path]` → jump to Step 5 with the most recent
  `wiki/.progress/preprocess/<ts>-plan.json`. If multiple exist, pick the
  newest by mtime. If `--apply` is given but no plan exists, abort and
  tell the user to run `/preprocess <args>` first.
- Otherwise extract:
  - `target` (default `raw/`)
  - the rest of the message as a free-form noise description

### Step 2 — Translate the description into a rules JSON

Map the user's description to the schema below. Be conservative — only
include rules the user clearly asked for. If something is ambiguous
(e.g. "광고"), ask in chat which form: ad-class div, banner image, or a
specific text marker.

```json
{
  "target": "raw/inbox",
  "trash": [
    { "glob": "**/*.ad.html", "reason": "광고 페이지" },
    { "filenameRegex": "^_archive_.*", "reason": "이전 보관본" },
    { "emptyFile": true, "reason": "0바이트 빈 파일" },
    { "minBytes": 0, "maxBytes": 32, "reason": "32바이트 이하 stub" }
  ],
  "strip": [
    {
      "filenameGlob": "**/*.{html,md}",
      "contentRegex": "(?s)<nav[^>]*>.*?</nav>",
      "regexFlags": "g",
      "reason": "사이트 네비게이션"
    },
    {
      "filenameGlob": "**/*.md",
      "contentLineMatch": "^Subscribe to our newsletter",
      "reason": "뉴스레터 광고 라인"
    }
  ]
}
```

Rule shape constraints:

- `trash` matcher is one of: `glob` / `filenameRegex` / `emptyFile: true`
  / `minBytes`+`maxBytes`. Don't mix matchers in one entry.
- `strip` matcher is `contentRegex` or `contentLineMatch`. Both honor an
  optional `filenameGlob` and `regexFlags`.
- The script auto-lifts a leading inline flag group like `(?s)` or
  `(?im)` into `regexFlags`, so a Perl-style pattern is fine. Prefer
  `regexFlags: "gs"` explicitly when in doubt.
- Save the resulting rules to
  `wiki/.progress/preprocess/<ts>-rules.json`.

### Step 3 — Run the script in `plan` mode

For small targets (single directory, single file), one invocation per
target is enough:

```bash
node scripts/preprocess-raw.mjs plan \
  --target <target> \
  --rules-file wiki/.progress/preprocess/<ts>-rules.json \
  --out wiki/.progress/preprocess/<ts>-plan.json
```

For large `raw/` trees, follow CLAUDE.md Section 7 (leaf-first): list
leaf directories under `target`, run the script once per leaf into
`wiki/.progress/preprocess/<ts>-plan-<leafhash>.json`, then merge the
`actions` arrays into a single `<ts>-plan.json` before showing the user.

Persist the script's stdout (the JSON summary) verbatim into the chat
log session file so the user can audit it later.

### Step 4 — Present the plan, stop

Write a human-readable summary to
`wiki/.progress/preprocess/<ts>-plan.md` with this shape:

```markdown
# Preprocess plan — <ts>

- Target: `<target>`
- Rules: `wiki/.progress/preprocess/<ts>-rules.json`
- Plan: `wiki/.progress/preprocess/<ts>-plan.json`

## 요약
- trash: N 파일
- strip: M 파일 (총 R개 구간 제거 예정)
- skip: K 파일

## Trash 후보 (상위 5)
- `raw/.../foo.ad.html` — 광고 페이지
- ...

## Strip 후보 (상위 5)
- `raw/.../article.html` — 네비, 뉴스레터 (4 구간)
- ...

이대로 적용하려면 `/preprocess --apply` 를 입력하세요.
```

Output the same summary as the assistant reply in chat (Korean,
following CLAUDE.md Section 11). Then release the lock and stop. **Do
not** mutate `raw/` in this step.

### Step 5 — Apply (only when /preprocess --apply was issued)

1. Locate the most recent `<ts>-plan.json` in
   `wiki/.progress/preprocess/`. Abort if none.
2. Re-acquire the lock if not already held.
3. Run the script:

   ```bash
   node scripts/preprocess-raw.mjs apply \
     --plan-file wiki/.progress/preprocess/<ts>-plan.json
   ```

4. The script writes `wiki/.progress/preprocess/<ts>-applied.json` and
   emits a JSON summary on stdout: `{ok, skipped, failed}`.
5. Append one line to `wiki/log.md`:

   ```markdown
   ## [YYYY-MM-DD HH:MM] preprocess | <target>
   - rules: `wiki/.progress/preprocess/<ts>-rules.json`
   - plan:  `wiki/.progress/preprocess/<ts>-plan.json`
   - applied: trash=N, strip=M, failed=K
   ```

6. Report the same numbers in chat. If anything failed, list the failing
   paths from `<ts>-applied.json` so the user can investigate.
7. Release the lock.

## Error handling

- **Script crashes** (exit code 2): show the stderr verbatim in chat.
  The lock is released by the skill's own `finally` step, not by the
  script.
- **Some actions failed during apply** (exit code 1 from the script):
  the rest still applied. Report `failed > 0` honestly and surface the
  per-path error from `<ts>-applied.json`.
- **User cancels mid-plan**: nothing under `raw/` has changed yet — just
  release the lock and stop.
- **User cancels mid-apply**: the script processes one action at a time;
  whatever was already moved stays moved. `<ts>-applied.json` records
  what completed. Re-running `/preprocess --apply` is safe — actions
  whose source file no longer exists are recorded as `missing` and
  skipped.

## Prohibited (hard rules)

- Do **not** move files anywhere except `raw/.trash/`. No deletes, no
  cross-directory shuffles, no writes outside `raw/` (other than the
  state files under `wiki/.progress/preprocess/` and the
  one-line append to `wiki/log.md`).
- Do **not** trash `.gitkeep` or any `.trash/`, `.cleaned/`, `.preview/`
  contents. The script enforces this; don't try to work around it.
- Do **not** auto-apply. Always require a separate `/preprocess --apply`
  call.
- Do **not** persist rules between runs. Each `/preprocess` call starts
  from the user's fresh description.
- Do **not** invent patterns the user didn't ask for. If unsure, ask.

## State Files

### `wiki/.progress/preprocess/.lock`

```json
{
  "pid": 12345,
  "started_at": "2026-05-18T04:30:00.000Z",
  "session": "sessions/2026-05-18/043000_preprocess_inbox.md"
}
```

### `wiki/.progress/preprocess/<ts>-rules.json`

The rules JSON produced in Step 2. See the schema there.

### `wiki/.progress/preprocess/<ts>-plan.json`

Produced by `scripts/preprocess-raw.mjs plan`:

```json
{
  "createdAt": "2026-05-18T04:30:11.234Z",
  "target": "raw/inbox",
  "rulesFile": "wiki/.progress/preprocess/2026-05-18-0430-rules.json",
  "actions": [
    {
      "kind": "trash",
      "path": "raw/inbox/example.com/promo.ad.html",
      "size": 12342,
      "reason": "광고 페이지",
      "matchedRule": "glob:**/*.ad.html"
    },
    {
      "kind": "strip",
      "path": "raw/inbox/example.com/article.html",
      "originalBytes": 48211,
      "cleanedBytes": 31118,
      "removedRegions": 4,
      "previewDiff": "- <nav class=\"top\">…</nav>",
      "matchedRules": ["regex:<nav[^>]*>.*?</nav>"]
    },
    {
      "kind": "skip",
      "path": "raw/inbox/example.com/index.html",
      "reason": "no rule matched"
    }
  ],
  "summary": { "trash": 7, "strip": 12, "skip": 41, "totalScanned": 60 }
}
```

### `wiki/.progress/preprocess/<ts>-applied.json`

Produced by `scripts/preprocess-raw.mjs apply`. Mirrors the plan's
`actions[]` with a `status` field (`ok`, `skipped`, `missing`,
`protected`, `nochange`, `error`) and the per-action `trashedTo` /
`backupAt` recovery paths.

## Minimal Scenario

User:
> `/preprocess raw/inbox 광고 파일이랑 빈 파일 정리해주고, 네비 부분은 잘라줘`

Skill, call #1 (dry-run):

1. Lock, parse args: `target=raw/inbox`, description in Korean.
2. Translate to rules JSON:
   ```json
   {
     "target": "raw/inbox",
     "trash": [
       { "glob": "**/*.ad.html", "reason": "광고 파일" },
       { "emptyFile": true, "reason": "빈 파일" }
     ],
     "strip": [
       { "filenameGlob": "**/*.html", "contentRegex": "(?s)<nav[^>]*>.*?</nav>", "regexFlags": "g", "reason": "사이트 네비" }
     ]
   }
   ```
3. Save rules, run the script in `plan` mode, write
   `<ts>-plan.json` and `<ts>-plan.md`.
4. Reply in chat with the summary table and `/preprocess --apply` hint.
5. Release lock.

User:
> `/preprocess --apply`

Skill, call #2 (apply):

1. Lock, locate the latest plan from step 3.
2. Run the script in `apply` mode.
3. Append a `wiki/log.md` entry and report `{ok, skipped, failed}`.
4. Release lock.

## Completion Checklist

Verify every item before reporting the preprocess run complete. Render the
result as a `- Checklist:` line inside the `wiki/log.md` preprocess entry,
marking each item `[x]` done, `[ ]` + short reason when blocked, or `[-]` when
not applicable. Do not claim the run finished while a required `[ ]` remains.

Dry-run (default):

- [ ] Validated the target path is under `raw/`; enumerated leaves leaf-first.
- [ ] Produced `wiki/.progress/preprocess/<ts>-rules.{json,md}` and `<ts>-plan.json` and a chat summary.
- [ ] Made NO mutation to `raw/` (no moves, no rewrites).

Apply (`--apply`):

- [ ] Backed up every original to `raw/.trash/<ISO-ts>_<basename>` before any move or in-place rewrite.
- [ ] Applied only changes present in the approved `<ts>-plan.json`; touched nothing outside the described scope.
- [ ] Wrote `wiki/.progress/preprocess/<ts>-applied.json`.
- [ ] Never deleted `raw/chat/` captures or wrote outside `raw/` / `raw/.trash/`.
- [ ] Appended one `wiki/log.md` preprocess entry.

## Related Skills

- [wiki-ingest](../wiki-ingest/SKILL.md) — runs after preprocess. With
  noise stripped, sub-chunks are smaller and summary pages are cleaner.
- [wiki-lint](../wiki-lint/SKILL.md) — periodic health check; can flag
  recurring noise patterns that the user might want to add to the next
  `/preprocess` description.
