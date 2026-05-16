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
    host: z.string().default("127.0.0.1"),
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
    /** 한 청크에 들어갈 최대 파일 수 */
    maxFiles: z.number().int().min(1).default(8),
    /** 한 청크 총 바이트 상한 */
    maxBytes: z.number().int().min(1024).default(256 * 1024),
  }),
  graph: z.object({
    minCommunitySize: z.number().int().min(1).default(3),
    autoUpdateOnIngest: z.boolean().default(true),
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
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  server: {},
  agent: {},
  chunking: {},
  graph: {},
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
