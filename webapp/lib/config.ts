import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CONFIG_DEFAULT_PATH,
  CONFIG_LOCAL_PATH,
  CONFIG_ROOT,
} from "./paths";

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(9091),
    host: z.string().default("0.0.0.0"),
  }),
  agent: z.object({
    /** 사용자가 Settings에서 고른 기본 CLI */
    default: z
      .enum(["codex", "claude", "agy", "cline"])
      .nullable()
      .default(null),
    /** "safe" 모드면 yolo/bypass 플래그를 떼고 호출 (대화형) */
    safeMode: z.boolean().default(false),
    /** CLI별 사용자 지정 절대 경로. 없으면 PATH 탐지. */
    paths: z
      .object({
        codex: z.string().optional(),
        claude: z.string().optional(),
        agy: z.string().optional(),
        cline: z.string().optional(),
      })
      .default({}),
    orchestration: z
      .object({
        /**
         * Optional CLI used by multi-agent wiki operations. When null, the
         * operation uses the caller/default CLI. When set, every worker and
         * coordinator pass uses this single CLI instead of rotating across all
         * detected CLIs.
         */
        cli: z
          .enum(["codex", "claude", "agy", "cline"])
          .nullable()
          .default(null),
        /**
         * Upper bound for worker CLI processes the chat orchestrator may run
         * for /ingest, /ingest-loop, and /lint. /query uses a single CLI
         * agent. The coordinator uses the selected orchestration CLI and uses
         * `namePrefix` as a stable seed for live worker personas.
         */
        maxConcurrentAgents: z.number().int().min(1).max(16).default(2),
        namePrefix: z.string().min(1).max(40).default("scientists"),
        managerName: z.string().min(1).max(40).default("Coordinator"),
      })
      .default({
        cli: null,
        maxConcurrentAgents: 2,
        namePrefix: "scientists",
        managerName: "Coordinator",
      }),
  }),
  chunking: z.object({
    /** Soft cap on the number of files in a single chunk. */
    maxFiles: z.number().int().min(1).default(8),
    /** Soft cap on the total bytes in a single chunk. */
    maxBytes: z.number().int().min(1024).default(256 * 1024),
    /**
     * Hard cap on how many files a single LLM invocation may keep in working
     * memory at once. Also the size of a sub-chunk inside a leaf.
     */
    maxFilesPerInvocation: z.number().int().min(1).default(4),
    /**
     * When a single file exceeds this size, the skill is instructed to read
     * head + tail only instead of the whole body.
     */
    maxBytesPerFile: z.number().int().min(1024).default(128 * 1024),
    /**
     * Unit of work per LLM invocation. "one_subchunk" is the default — after a
     * sub-chunk finishes, the call exits and the next sub-chunk runs in a
     * fresh invocation.
     */
    unitPerCall: z
      .enum(["one_subchunk", "one_leaf", "one_file"])
      .default("one_subchunk"),
  }),
  graph: z.object({
    minCommunitySize: z.number().int().min(1).default(3),
    extraction: z
      .object({
        /**
         * CLIO builds an Obsidian-like page-title graph first. graphify's
         * extraction pipeline then enriches that sparse topology only when it
         * has stable provenance.
         */
        primaryNodeModel: z.enum(["page-title"]).default("page-title"),
        profile: z.enum(["wiki", "code", "deep"]).default("wiki"),
        scope: z.enum(["wiki", "wiki+raw"]).default("wiki"),
        maxNodesPerLeaf: z.number().int().min(1).default(40),
        maxConceptsPerSource: z.number().int().min(1).default(8),
        minConfidence: z.number().min(0).max(1).default(0.65),
        includeRationaleNodes: z.boolean().default(false),
        includeHyperedges: z.boolean().default(false),
        dropIsolatedDerivedNodes: z.boolean().default(true),
        /**
         * Prose pages connect with explicit links + thresholded semantic
         * relatedness only. Facets stay as node metadata, not edges.
         */
        proseEdges: z
          .enum(["explicit", "explicit+semantic"])
          .default("explicit+semantic"),
        facetEdges: z.boolean().default(false),
        includeSemanticSimilarity: z.boolean().default(true),
        semanticMinConfidence: z.number().min(0).max(1).default(0.72),
        /**
         * Code graph unit is a whole project: graphify produces a real
         * graphify-out per project under projectsDir, and a detailed
         * <project>.md analysis under projectAnalysisDir.
         */
        codeModel: z
          .enum(["per-project-graphify-out"])
          .default("per-project-graphify-out"),
        projectsDir: z.string().default("wiki/graph/projects"),
        projectAnalysisDir: z.string().default("wiki/code"),
      })
      .default({
        primaryNodeModel: "page-title",
        profile: "wiki",
        scope: "wiki",
        maxNodesPerLeaf: 40,
        maxConceptsPerSource: 8,
        minConfidence: 0.65,
        includeRationaleNodes: false,
        includeHyperedges: false,
        dropIsolatedDerivedNodes: true,
        proseEdges: "explicit+semantic",
        facetEdges: false,
        includeSemanticSimilarity: true,
        semanticMinConfidence: 0.72,
        codeModel: "per-project-graphify-out",
        projectsDir: "wiki/graph/projects",
        projectAnalysisDir: "wiki/code",
      }),
    autoUpdateOnIngest: z.boolean().default(true),
    /**
     * Controls whether ingest runs scoped graph updates between iterations.
     * A scoped update refreshes completed-leaf partials and then merges all
     * graph parts. "auto" keeps small ingests quality-first and large ingests
     * resumable.
     */
    autoUpdateStrategy: z
      .enum(["auto", "finalOnly", "partialAndFinal"])
      .default("auto"),
    partialThresholds: z
      .object({
        minLeaves: z.number().int().min(1).default(4),
        minFiles: z.number().int().min(1).default(16),
        minBytes: z.number().int().min(1).default(1024 * 1024),
        minSubChunks: z.number().int().min(1).default(4),
      })
      .default({
        minLeaves: 4,
        minFiles: 16,
        minBytes: 1024 * 1024,
        minSubChunks: 4,
      }),
  }),
  search: z
    .object({
      qmd: z
        .object({
          enabled: z.boolean().default(true),
          autoUpdateOnWikiChange: z.boolean().default(true),
          scope: z.enum(["wiki", "wiki+raw"]).default("wiki"),
          defaultNoRerank: z.boolean().default(true),
          embedEnabled: z.boolean().default(false),
        })
        .default({
          enabled: true,
          autoUpdateOnWikiChange: true,
          scope: "wiki",
          defaultNoRerank: true,
          embedEnabled: false,
        }),
    })
    .default({
      qmd: {
        enabled: true,
        autoUpdateOnWikiChange: true,
        scope: "wiki",
        defaultNoRerank: true,
        embedEnabled: false,
      },
    }),
  chat: z.object({
    /**
     * Number of recent turns kept verbatim once the full session conversation
     * exceeds contextMaxBytes and older turns are compacted.
     */
    contextTurns: z.number().int().min(1).default(6),
    /**
     * UTF-8 byte threshold for chat-session context injection. Slim chat calls
     * include the full conversation up to this size; above it, older turns are
     * represented as an `이전대화` compacted memory block.
     */
    contextMaxBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .default(256 * 1024),
    /**
     * When true, a short reference to wiki/.progress/ingest/DASHBOARD.md is
     * prepended to the prompt if the dashboard exists.
     */
    includeProgressDashboard: z.boolean().default(true),
  }),
  cli: z.object({
    /**
     * Opt-in token streaming. claude `-p` buffers all output until exit, so the
     * chat answer arrives in one burst at the end. When enabled, the claude
     * agent is run with `--output-format stream-json --verbose` and the JSON
     * deltas are parsed back into incremental plain text, so onStdout delivers
     * tokens as they are generated. Experimental and claude-only for now; other
     * CLIs keep their buffered behavior regardless of this flag. Default off to
     * preserve the verified output path.
     */
    streamTokens: z.boolean().default(false),
    /**
     * Upper bound on how many characters of child stdout runCli buffers in
     * memory. When exceeded, content is dropped from the head, keeping the
     * tail, and a truncate marker is recorded.
     */
    maxStdoutBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .default(1024 * 1024),
    /** Same policy for stderr — keeps RSS bounded even with verbose logs. */
    maxStderrBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .default(256 * 1024),
    /**
     * When the argv-passed prompt is larger than this, runCli emits a warning
     * on stderr. It does not truncate — slim prompt building is the caller's
     * responsibility.
     */
    promptWarnBytes: z
      .number()
      .int()
      .min(8 * 1024)
      .default(128 * 1024),
    /**
     * Per-operation timeouts (ms) applied to the host coding-agent CLI run.
     * `null` disables the timeout entirely for that kind. `ingest` defaults to
     * null because a single ingest pass can legitimately run for tens of
     * minutes per leaf chunk and SIGTERM-ing the child mid-summary corrupts
     * partial progress. Code-heavy inputs still use the ingest timeout because
     * they are handled inside the normal wiki-ingest flow. `chat` defaults to
     * null so normal chat requests can wait until the selected CLI returns; the
     * chat UI still surfaces a Cancel button for user-driven aborts. `query`
     * also defaults to null because coding-agent CLIs can spend a long time
     * searching the wiki and a timeout-triggered SIGTERM loses the final
     * answer after the work was already paid for.
     */
    timeouts: z
      .object({
        chat: z.number().int().min(1000).nullable().default(null),
        ingest: z.number().int().min(1000).nullable().default(null),
        /**
         * Per-sub-chunk timeout inside an /ingest-loop iteration. Defaults to
         * null (no timeout) for the same reason ingest does: a single
         * sub-chunk can legitimately take tens of minutes on large leaves.
         * The loop itself is bounded by `cli.ingestLoop.maxIterations`.
         */
        "ingest-loop": z
          .number()
          .int()
          .min(1000)
          .nullable()
          .default(null),
        /**
         * /preprocess runs the deterministic scripts/preprocess-raw.mjs in
         * dry-run or apply mode. Both invocations are short relative to
         * /ingest; 60 minutes is plenty even when iterating leaf-by-leaf on
         * a large raw/ tree, while still preventing a runaway from holding
         * the lock forever.
         */
        preprocess: z
          .number()
          .int()
          .min(1000)
          .nullable()
          .default(60 * 60 * 1000),
        query: z.number().int().min(1000).nullable().default(null),
        lint: z.number().int().min(1000).nullable().default(30 * 60 * 1000),
        graph: z.number().int().min(1000).nullable().default(30 * 60 * 1000),
      })
      .default({
        chat: null,
        ingest: null,
        "ingest-loop": null,
        preprocess: 60 * 60 * 1000,
        query: null,
        lint: 30 * 60 * 1000,
        graph: 30 * 60 * 1000,
      }),
    /**
     * Settings that apply to the /ingest-loop driver. The loop repeatedly
     * spawns the host CLI to process one sub-chunk at a time (per the
     * wiki-ingest skill) until the progress state reports zero pending /
     * in_progress / partial sub-chunks and the merge pass has completed.
     */
    ingestLoop: z
      .object({
        /**
         * Hard upper bound on how many sub-chunk invocations a single
         * /ingest-loop run may perform before halting. Acts as a safety net
         * against runaway loops if the skill ever fails to advance the
         * progress state.
         */
        maxIterations: z.number().int().min(1).default(200),
        /**
         * Number of times the backend should try the same ingest-loop
         * iteration when the host CLI throws or exits non-zero. This counts
         * the initial call, so 3 means 1 normal attempt + 2 retries.
         */
        maxRetryAttempts: z.number().int().min(1).default(3),
        /**
         * Backoff delays before retrying failed CLI calls. If there are more
         * retries than entries, the final delay is reused.
         */
        retryBackoffMs: z
          .array(z.number().int().min(0))
          .default([5000, 30_000]),
      })
      .default({
        maxIterations: 200,
        maxRetryAttempts: 3,
        retryBackoffMs: [5000, 30_000],
      }),
  }),
  ui: z.object({
    language: z.enum(["ko", "en"]).default("ko"),
    theme: z.enum(["default", "light", "dark"]).default("default"),
    appSubtitle: z.string().max(80).default(""),
    defaultTab: z
      .enum(["dashboard", "chat", "explorer", "graph", "automations", "settings"])
      .default("chat"),
    agentEdgePanelEnabled: z.boolean().default(true),
  }),
  auth: z.object({
    /** bcrypt 해시. 첫 실행 시 비어 있음. */
    passwordHash: z.string().nullable().default(null),
    /** 세션 서명을 위한 32바이트 secret (base64). 첫 실행 시 자동 생성. */
    sessionSecret: z.string().nullable().default(null),
    /** 세션 유효 시간(초). null이면 만료 시각 없는 장기 로그인. */
    sessionTtlSec: z.number().int().min(60).nullable().default(60 * 60 * 24),
    /**
     * Long-lived bearer token used by the local `clio` CLI to authenticate
     * against the same API surface as the web UI. Generated on demand when
     * the CLI first calls /api/cli/token (or via Settings). Stored in plain
     * text because the CLI reads it directly from local.json; the whole
     * file is already protected by filesystem permissions.
     */
    cliToken: z.string().nullable().default(null),
  }),
  publicQuery: z
    .object({
      /**
       * Passwordless, query-only CLIO sharing endpoint. Disabled by default
       * because enabling it exposes read access to wiki-derived answers to
       * anyone who can reach the web server.
       */
      enabled: z.boolean().default(false),
      /**
       * Optional access passphrase for the public /clio endpoint. When set,
       * the public query API requires a matching `x-clio-access-token` header
       * (the /clio page prompts the visitor for it). Null means fully open —
       * the original passwordless behavior. Never returned by GET endpoints;
       * set/cleared via the dedicated /api/settings/public-token route.
       */
      accessToken: z.string().nullable().default(null),
      /**
       * When true, public chat may ask the selected coding-agent CLI to use
       * read-only external lookup tools for questions that need fresh facts
       * outside the wiki. Disabled by default so /clio remains wiki-only
       * unless the admin opts in.
       */
      allowExternalLookup: z.boolean().default(false),
      /**
       * Public chat runs in a bubblewrap process sandbox by default. Admins
       * may disable it on trusted local/LAN deployments when they need fewer
       * process boundaries. The sandbox still exposes allowlisted read-only
       * agent config directories and helper runtimes such as agent-browser
       * when they are installed.
       */
      sandboxEnabled: z.boolean().default(true),
      /**
       * Host HOME-relative paths exposed read-only inside the public CLI
       * sandbox. Use full agent homes rather than hand-picking credential
       * files because CLIs frequently add provider/plugin state over time.
       */
      sandboxReadOnlyHomePaths: z
        .array(z.string().min(1))
        .default([
          ".codex",
          ".claude",
          ".cline",
          ".agy",
          ".antigravity",
          ".agents",
          ".claude.json",
          ".codex.json",
          ".cline.json",
          ".agy.json",
          ".config/codex",
          ".config/claude",
          ".config/cline",
          ".config/agy",
          ".config/antigravity",
          ".config/anthropic",
          ".config/gcloud",
          ".config/google-cloud",
          ".local/share/codex",
          ".local/share/claude",
          ".local/share/cline",
          ".local/share/agy",
          ".local/share/anthropic",
          ".local/share/antigravity",
          ".local/state/codex",
          ".local/state/claude",
          ".local/state/cline",
          ".local/state/agy",
          ".local/state/anthropic",
          ".local/state/antigravity",
          ".cache/codex",
          ".cache/claude",
          ".cache/cline",
          ".cache/agy",
          ".cache/anthropic",
          ".cache/antigravity",
        ]),
    })
    .default({
      enabled: false,
      accessToken: null,
      allowExternalLookup: false,
      sandboxEnabled: true,
      sandboxReadOnlyHomePaths: [
        ".codex",
        ".claude",
        ".cline",
        ".agy",
        ".antigravity",
        ".agents",
        ".claude.json",
        ".codex.json",
        ".cline.json",
        ".agy.json",
        ".config/codex",
        ".config/claude",
        ".config/cline",
        ".config/agy",
        ".config/antigravity",
        ".config/anthropic",
        ".config/gcloud",
        ".config/google-cloud",
        ".local/share/codex",
        ".local/share/claude",
        ".local/share/cline",
        ".local/share/agy",
        ".local/share/anthropic",
        ".local/share/antigravity",
        ".local/state/codex",
        ".local/state/claude",
        ".local/state/cline",
        ".local/state/agy",
        ".local/state/anthropic",
        ".local/state/antigravity",
        ".cache/codex",
        ".cache/claude",
        ".cache/cline",
        ".cache/agy",
        ".cache/anthropic",
        ".cache/antigravity",
      ],
    }),
  /**
   * Auto-ingest trigger. When enabled, a background watcher or scheduler
   * runs the same /ingest-loop driver used by manual ingest. Defaults to
   * disabled so the wiki behaves exactly as before until the user opts in.
   */
  autoIngest: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(["watch", "schedule"]).default("watch"),
      watch: z
        .object({
          /**
           * Time window (ms) that collapses bursty file events from a
           * single user action (e.g. `cp -r`) into one ingest trigger.
           */
          debounceMs: z
            .number()
            .int()
            .min(1000)
            .max(60_000)
            .default(5000),
        })
        .default({ debounceMs: 5000 }),
      schedule: z
        .object({
          intervalMinutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .default(30),
        })
        .default({ intervalMinutes: 30 }),
      /**
       * When true, automatic triggers skip if wiki/.progress/ingest/.lock
       * exists (another ingest is already running). The next event or
       * scheduled tick picks the work up. When false, the trigger fires
       * anyway and the skill's own lock acquisition decides the outcome.
       */
      skipIfBusy: z.boolean().default(true),
    })
    .default({
      enabled: false,
      mode: "watch",
      watch: { debounceMs: 5000 },
      schedule: { intervalMinutes: 30 },
      skipIfBusy: true,
    }),
  /**
   * Auto-lint trigger. Two independent firing modes share one manager:
   *   - counter: counts `ingest |` entries in wiki/log.md since the last
   *     `lint |` entry; when the value reaches `counter.threshold` the UI
   *     surfaces a "lint recommended" suggestion. Never auto-executes.
   *   - cron: fires the wiki-lint skill on a preset schedule
   *     (daily / weekly / monthly + HH:MM, with day-of-week for weekly and
   *     day-of-month for monthly).
   */
  autoLint: z
    .object({
      enabled: z.boolean().default(false),
      counter: z
        .object({
          threshold: z.number().int().min(1).max(1000).default(10),
        })
        .default({ threshold: 10 }),
      cron: z
        .object({
          enabled: z.boolean().default(false),
          preset: z
            .enum(["daily", "weekly", "monthly"])
            .default("weekly"),
          time: z
            .object({
              hour: z.number().int().min(0).max(23).default(3),
              minute: z.number().int().min(0).max(59).default(0),
            })
            .default({ hour: 3, minute: 0 }),
          /** 0 = Sunday … 6 = Saturday. Used when preset === "weekly". */
          dayOfWeek: z.number().int().min(0).max(6).default(0),
          /** 1..28 to avoid edge cases on short months. preset === "monthly". */
          dayOfMonth: z.number().int().min(1).max(28).default(1),
        })
        .default({
          enabled: false,
          preset: "weekly",
          time: { hour: 3, minute: 0 },
          dayOfWeek: 0,
          dayOfMonth: 1,
        }),
      /** When true, pass `--fix` to /lint so auto-fixable issues are applied. */
      fix: z.boolean().default(true),
      /**
       * When true, skip if either wiki/.progress/ingest/.lock or
       * wiki/.progress/lint/.lock exists. Mirrors autoIngest.skipIfBusy.
       */
      skipIfBusy: z.boolean().default(true),
    })
    .default({
      enabled: false,
      counter: { threshold: 10 },
      cron: {
        enabled: false,
        preset: "weekly",
        time: { hour: 3, minute: 0 },
        dayOfWeek: 0,
        dayOfMonth: 1,
      },
      fix: true,
      skipIfBusy: true,
    }),
  telegram: z
    .object({
      /**
       * Telegram bot integration. When enabled, the webapp runs a polling
       * worker that dispatches messages from allowlisted Telegram chats
       * through the existing /query pipeline. See
       * docs/PLAN_TELEGRAM_BOT_2026-06-01.md for the full design.
       */
      enabled: z.boolean().default(false),
      /** Push a Telegram notice to trusted chats when a long ingest run ends. */
      notifyOnIngest: z.boolean().default(true),
      /** Bot token issued by @BotFather. Never returned by GET endpoints. */
      botToken: z.string().nullable().default(null),
      mode: z.enum(["polling", "webhook"]).default("polling"),
      /** Public URL the webhook mode registers with Telegram. */
      webhookPublicUrl: z.string().nullable().default(null),
      /** Required secret for the X-Telegram-Bot-Api-Secret-Token header. */
      webhookSecret: z.string().nullable().default(null),
      allowlist: z
        .array(
          z.object({
            chatId: z.number(),
            kind: z.enum(["private", "group", "channel"]),
            label: z.string().default(""),
            permission: z.enum(["query", "trusted"]).default("query"),
            approvedAt: z.string(),
          }),
        )
        .default([]),
      /** Chats that contacted the bot but are still awaiting admin approval. */
      pending: z
        .array(
          z.object({
            chatId: z.number(),
            kind: z.enum(["private", "group", "channel"]),
            label: z.string().default(""),
            firstSeenAt: z.string(),
            lastMessagePreview: z.string().default(""),
          }),
        )
        .default([]),
      /** Reply text returned to unapproved chats on first contact. */
      rejectionMessage: z
        .string()
        .default(
          "이 봇은 승인된 chat에만 응답합니다. 관리자에게 chat ID 승인 요청을 보내주세요.",
        ),
      historyTurns: z.number().int().min(0).max(50).default(6),
      replyMaxChars: z.number().int().min(200).max(4096).default(3500),
      /**
       * When true, Telegram-routed queries may use the same external lookup
       * tools as publicQuery. Defaults to false because Telegram users come
       * through a chat allowlist, not the LAN trust boundary.
       */
      allowExternalLookup: z.boolean().default(false),
    })
    .default({
      enabled: false,
      botToken: null,
      mode: "polling",
      webhookPublicUrl: null,
      webhookSecret: null,
      allowlist: [],
      pending: [],
      rejectionMessage:
        "이 봇은 승인된 chat에만 응답합니다. 관리자에게 chat ID 승인 요청을 보내주세요.",
      historyTurns: 6,
      replyMaxChars: 3500,
      allowExternalLookup: false,
    }),
  automation: z
    .object({
      enabled: z.boolean().default(false),
      maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
      defaultWorkspaceBasePath: z.string().default(""),
      jobs: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1).max(120),
            enabled: z.boolean().default(false),
            template: z
              .enum([
                "youtube-summary",
                "github-gerrit-review",
                "email-sync",
                "custom",
              ])
              .default("custom"),
            prompt: z.string().max(20_000).default(""),
            schedule: z
              .object({
                mode: z.enum(["preset", "cron"]).default("preset"),
                preset: z
                  .enum(["hourly", "daily", "weekly", "monthly"])
                  .default("daily"),
                cron: z.string().default("0 9 * * *"),
                time: z
                  .object({
                    hour: z.number().int().min(0).max(23).default(9),
                    minute: z.number().int().min(0).max(59).default(0),
                  })
                  .default({ hour: 9, minute: 0 }),
                dayOfWeek: z.number().int().min(0).max(6).default(1),
                dayOfMonth: z.number().int().min(1).max(28).default(1),
                timezone: z.string().default(""),
              })
              .default({
                mode: "preset",
                preset: "daily",
                cron: "0 9 * * *",
                time: { hour: 9, minute: 0 },
                dayOfWeek: 1,
                dayOfMonth: 1,
                timezone: "",
              }),
            selectedAgents: z
              .array(z.enum(["codex", "claude", "agy", "cline"]))
              .min(1)
              .default(["codex"]),
            workspaceBasePath: z.string().default(""),
            externalWritePolicy: z.enum(["draft-only"]).default("draft-only"),
            autoIngestAfterRun: z.boolean().default(false),
          }),
        )
        .default([]),
    })
    .default({
      enabled: false,
      maxConcurrentJobs: 2,
      defaultWorkspaceBasePath: "",
      jobs: [],
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  server: {},
  agent: {},
  chunking: {},
  graph: {},
  search: {},
  chat: {},
  cli: {},
  ui: {},
  auth: {},
  publicQuery: {},
  telegram: {},
  automation: {},
});

function normalizeLegacyGeminiCli(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === "gemini" ? "agy" : item));
  }
  if (value == null || typeof value !== "object") return value;

  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const agent = out.agent;
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    const nextAgent: Record<string, unknown> = {
      ...(agent as Record<string, unknown>),
    };
    if (nextAgent.default === "gemini") nextAgent.default = "agy";
    const paths = nextAgent.paths;
    if (paths && typeof paths === "object" && !Array.isArray(paths)) {
      const nextPaths: Record<string, unknown> = {
        ...(paths as Record<string, unknown>),
      };
      if (nextPaths.agy == null && typeof nextPaths.gemini === "string") {
        nextPaths.agy = nextPaths.gemini;
      }
      delete nextPaths.gemini;
      nextAgent.paths = nextPaths;
    }
    const orchestration = nextAgent.orchestration;
    if (
      orchestration &&
      typeof orchestration === "object" &&
      !Array.isArray(orchestration)
    ) {
      const nextOrchestration: Record<string, unknown> = {
        ...(orchestration as Record<string, unknown>),
      };
      if (nextOrchestration.cli === "gemini") nextOrchestration.cli = "agy";
      nextAgent.orchestration = nextOrchestration;
    }
    out.agent = nextAgent;
  }

  const automation = out.automation;
  if (automation && typeof automation === "object" && !Array.isArray(automation)) {
    const nextAutomation: Record<string, unknown> = {
      ...(automation as Record<string, unknown>),
    };
    const jobs = nextAutomation.jobs;
    if (Array.isArray(jobs)) {
      nextAutomation.jobs = jobs.map((job) => {
        if (!job || typeof job !== "object" || Array.isArray(job)) return job;
        const nextJob: Record<string, unknown> = {
          ...(job as Record<string, unknown>),
        };
        nextJob.selectedAgents = normalizeLegacyGeminiCli(
          nextJob.selectedAgents,
        );
        return nextJob;
      });
    }
    out.automation = nextAutomation;
  }

  return out;
}

async function readJsonIfExists<T>(p: string): Promise<Partial<T> | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as Partial<T>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function deepMerge<T>(base: T, over: Partial<T> | null | undefined): T {
  if (over === undefined) return base;
  if (over === null) return null as T;
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof over !== "object" ||
    Array.isArray(over)
  ) {
    return over as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = deepMerge(
      (base as Record<string, unknown>)[k],
      v as Partial<unknown>,
    ) as unknown;
  }
  return out as T;
}

let cached: Config | null = null;

/**
 * default.json + local.json을 머지하여 검증된 Config를 돌려준다.
 * default.json이 없으면 만들고, 디렉토리도 없으면 만든다.
 */
export async function loadConfig(force = false): Promise<Config> {
  if (cached && !force) return cached;

  await fs.mkdir(CONFIG_ROOT, { recursive: true });

  const def = await readJsonIfExists<Config>(CONFIG_DEFAULT_PATH);
  if (def == null) {
    await fs.writeFile(
      CONFIG_DEFAULT_PATH,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
      "utf8",
    );
  }
  const local = await readJsonIfExists<Config>(CONFIG_LOCAL_PATH);
  const merged = normalizeLegacyGeminiCli(
    deepMerge(deepMerge(DEFAULT_CONFIG, def), local),
  );
  cached = ConfigSchema.parse(merged);
  return cached;
}

/**
 * config/local.json에만 패치를 저장한다. default.json은 건드리지 않는다.
 */
export async function patchLocalConfig(
  patch: Partial<Config>,
): Promise<Config> {
  await fs.mkdir(CONFIG_ROOT, { recursive: true });
  const current =
    (await readJsonIfExists<Config>(CONFIG_LOCAL_PATH)) ?? {};
  const merged = deepMerge(current as Config, patch);
  await fs.writeFile(
    CONFIG_LOCAL_PATH,
    JSON.stringify(merged, null, 2) + "\n",
    "utf8",
  );
  cached = null;
  return loadConfig(true);
}

export function configPaths() {
  return {
    root: CONFIG_ROOT,
    default: CONFIG_DEFAULT_PATH,
    local: CONFIG_LOCAL_PATH,
  };
}

export function relPath(p: string): string {
  return path.relative(process.cwd(), p);
}
