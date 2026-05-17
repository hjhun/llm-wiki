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
    port: z.number().int().min(1).max(65535).default(7777),
    host: z.string().default("0.0.0.0"),
  }),
  agent: z.object({
    /** 사용자가 Settings에서 고른 기본 CLI */
    default: z
      .enum(["codex", "claude", "gemini", "cline"])
      .nullable()
      .default(null),
    /** "safe" 모드면 yolo/bypass 플래그를 떼고 호출 (대화형) */
    safeMode: z.boolean().default(false),
    /** CLI별 사용자 지정 절대 경로. 없으면 PATH 탐지. */
    paths: z
      .object({
        codex: z.string().optional(),
        claude: z.string().optional(),
        gemini: z.string().optional(),
        cline: z.string().optional(),
      })
      .default({}),
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
    autoUpdateOnIngest: z.boolean().default(true),
  }),
  chat: z.object({
    /**
     * Number of recent turns re-injected into the prompt for stateless CLI
     * calls. Avoids joining the entire history so prompt size does not grow
     * linearly with turn count.
     */
    contextTurns: z.number().int().min(1).default(6),
    /**
     * When true, a short reference to wiki/.progress/ingest/DASHBOARD.md is
     * prepended to the prompt if the dashboard exists.
     */
    includeProgressDashboard: z.boolean().default(true),
  }),
  cli: z.object({
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
     * partial progress. `chat` keeps the historical 5-minute cap.
     */
    timeouts: z
      .object({
        chat: z.number().int().min(1000).nullable().default(5 * 60 * 1000),
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
        query: z.number().int().min(1000).nullable().default(30 * 60 * 1000),
        lint: z.number().int().min(1000).nullable().default(30 * 60 * 1000),
        graph: z.number().int().min(1000).nullable().default(30 * 60 * 1000),
      })
      .default({
        chat: 5 * 60 * 1000,
        ingest: null,
        "ingest-loop": null,
        query: 30 * 60 * 1000,
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
      })
      .default({ maxIterations: 200 }),
  }),
  ui: z.object({
    language: z.enum(["ko", "en"]).default("ko"),
    defaultTab: z
      .enum(["chat", "explorer", "graph", "settings"])
      .default("chat"),
  }),
  auth: z.object({
    /** bcrypt 해시. 첫 실행 시 비어 있음. */
    passwordHash: z.string().nullable().default(null),
    /** 세션 서명을 위한 32바이트 secret (base64). 첫 실행 시 자동 생성. */
    sessionSecret: z.string().nullable().default(null),
    /** 세션 유효 시간(초). null이면 만료 시각 없는 장기 로그인. */
    sessionTtlSec: z.number().int().min(60).nullable().default(60 * 60 * 24),
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
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  server: {},
  agent: {},
  chunking: {},
  graph: {},
  chat: {},
  cli: {},
  ui: {},
  auth: {},
});

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
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, def), local);
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
