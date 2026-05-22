import "server-only";

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { CONFIG_ROOT, PROJECT_ROOT } from "./paths";

export type CliName = "codex" | "claude" | "gemini" | "cline";
export const CLI_NAMES: readonly CliName[] = [
  "codex",
  "claude",
  "gemini",
  "cline",
] as const;

export type CliInfo = {
  name: CliName;
  path: string | null;
  version: string | null;
  source: "config" | "PATH" | "missing";
};

type DetectOptions = {
  includeVersion?: boolean;
};

type DetectCacheEntry = {
  expiresAt: number;
  includeVersion: boolean;
  info: CliInfo;
};

const DETECT_CACHE_MS = 30_000;
const DEFAULT_PUBLIC_CLI_HOME = path.join(CONFIG_ROOT, "public-cli-home");
const detectCache = new Map<CliName, DetectCacheEntry>();

/** PATH 검색. 빌트인 which 대용. */
async function whichBin(bin: string): Promise<string | null> {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  // 일반 경로 보강: ~/.npm-global/bin, ~/.local/bin, /usr/local/bin
  const extras = [
    path.join(process.env.HOME ?? "/", ".npm-global", "bin"),
    path.join(process.env.HOME ?? "/", ".local", "bin"),
    "/usr/local/bin",
  ];
  const dirs = [...PATH.split(sep).filter(Boolean), ...extras];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        const st = await fs.stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // 무시
      }
    }
  }
  return null;
}

async function runVersion(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(absPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.stderr?.on("data", (d) => (buf += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const trimmed = buf.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? null;
      resolve(trimmed);
    });
  });
}

export async function detectCli(
  name: CliName,
  opts: DetectOptions = {},
): Promise<CliInfo> {
  const includeVersion = opts.includeVersion ?? true;
  const cached = detectCache.get(name);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    (cached.includeVersion || !includeVersion)
  ) {
    return includeVersion || cached.info.version
      ? cached.info
      : { ...cached.info, version: null };
  }

  const cfg = await loadConfig();
  const explicit = (cfg.agent.paths as Record<string, string | undefined>)[
    name
  ];
  if (explicit && existsSync(explicit)) {
    const info: CliInfo = {
      name,
      path: explicit,
      version: includeVersion ? await runVersion(explicit) : null,
      source: "config",
    };
    detectCache.set(name, {
      expiresAt: Date.now() + DETECT_CACHE_MS,
      includeVersion,
      info,
    });
    return info;
  }
  const found = await whichBin(name);
  if (found) {
    const info: CliInfo = {
      name,
      path: found,
      version: includeVersion ? await runVersion(found) : null,
      source: "PATH",
    };
    detectCache.set(name, {
      expiresAt: Date.now() + DETECT_CACHE_MS,
      includeVersion,
      info,
    });
    return info;
  }
  const info = { name, path: null, version: null, source: "missing" as const };
  detectCache.set(name, {
    expiresAt: Date.now() + DETECT_CACHE_MS,
    includeVersion,
    info,
  });
  return info;
}

export async function detectAllCli(
  opts: DetectOptions = {},
): Promise<CliInfo[]> {
  return Promise.all(CLI_NAMES.map((n) => detectCli(n, opts)));
}

function buildArgs(
  cli: CliName,
  prompt: string,
  safeMode: boolean,
  projectRoot: string,
  skipGitRepoCheck: boolean,
): string[] {
  switch (cli) {
    case "codex":
      return [
        "exec",
        ...(skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
        ...(safeMode ? [] : ["--dangerously-bypass-approvals-and-sandbox"]),
        prompt,
      ];
    case "claude":
      return safeMode
        ? ["-p", prompt]
        : ["-p", prompt, "--dangerously-skip-permissions"];
    case "gemini":
      return safeMode
        ? [
            "--prompt",
            prompt,
            "--include-directories",
            projectRoot,
          ]
        : [
            "--prompt",
            prompt,
            "--approval-mode",
            "yolo",
            "--include-directories",
            projectRoot,
          ];
    case "cline":
      return safeMode ? [prompt] : ["-y", prompt];
  }
}

export type StreamTruncation = {
  /** UTF-16 code units dropped from the head of the captured buffer. */
  droppedChars: number;
  /** Final cap that was applied (chars). */
  cap: number;
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  stdoutTruncated: StreamTruncation | null;
  stderrTruncated: StreamTruncation | null;
};

type BubblewrapSandbox = {
  kind: "bubblewrap";
  /** Dedicated HOME exposed to the public CLI process. */
  homeDir?: string;
};

type CliSandbox = BubblewrapSandbox;

type SpawnPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Bounded, tail-priority string buffer. Keeps at most `cap` characters,
 * discarding from the head when chunks arrive beyond the cap. Tracks how
 * many characters were dropped so callers can surface a truncate marker.
 *
 * Length is measured in JS string length (UTF-16 code units), which is a
 * close-enough proxy for "bytes of log" without paying for full byte
 * accounting on every chunk. The point is to bound RSS, not perfect
 * accuracy.
 */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  private dropped = 0;
  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      const drop = this.chunks.shift() as string;
      this.size -= drop.length;
      this.dropped += drop.length;
    }
    if (this.size > this.cap && this.chunks.length === 1) {
      const only = this.chunks[0];
      const sliced = only.slice(only.length - this.cap);
      this.dropped += only.length - sliced.length;
      this.chunks[0] = sliced;
      this.size = sliced.length;
    }
  }

  toString(): string {
    const body = this.chunks.join("");
    if (this.dropped > 0) {
      return `…<truncated ${this.dropped} chars>…\n` + body;
    }
    return body;
  }

  truncation(): StreamTruncation | null {
    if (this.dropped === 0) return null;
    return { droppedChars: this.dropped, cap: this.cap };
  }
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

async function addRoBindIfExists(args: string[], pathname: string): Promise<void> {
  if (await exists(pathname)) args.push("--ro-bind", pathname, pathname);
}

async function addResolvedFileBindIfNeeded(
  args: string[],
  pathname: string,
): Promise<void> {
  const realPath = await fs.realpath(pathname).catch(() => null);
  if (!realPath || realPath === pathname || !(await exists(realPath))) return;
  addDirChain(args, path.dirname(realPath));
  args.push("--ro-bind", realPath, realPath);
}

async function addRoBindAtIfExists(
  args: string[],
  source: string,
  target: string,
): Promise<void> {
  if (await exists(source)) {
    addDirChain(args, path.dirname(target));
    args.push("--ro-bind", source, target);
  }
}

async function clinePrefixEntries(hostHome: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(hostHome, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.startsWith(".cline"))
    .map((entry) => entry.name)
    .sort();
}

function skipNestedBind(rel: string, bound: string[]): boolean {
  return bound.some((parent) => rel.startsWith(`${parent}/`));
}

function addDirChain(args: string[], pathname: string): void {
  const normalized = path.resolve(pathname);
  const parts = normalized.split(path.sep).filter(Boolean);
  let current = path.isAbsolute(normalized) ? path.sep : "";
  for (const part of parts) {
    current = current === path.sep ? path.join(current, part) : path.join(current, part);
    args.push("--dir", current);
  }
}

function publicSandboxEnv(homeDir: string): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USER: process.env.USER ?? "clio-public",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "clio-public",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    TMPDIR: "/tmp",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
  };
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;

  for (const key of [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }

  return env;
}

function nodePackageRoot(realCliPath: string): string | null {
  const parts = realCliPath.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length) return null;

  const packageEnd =
    parts[index + 1]?.startsWith("@") && index + 2 < parts.length
      ? index + 3
      : index + 2;
  return parts.slice(0, packageEnd).join(path.sep) || path.sep;
}

async function addCliRuntimeBinds(
  args: string[],
  _cli: CliName,
  cliPath: string,
): Promise<string> {
  const realCliPath = await fs.realpath(cliPath).catch(() => cliPath);
  const packageRoot = nodePackageRoot(realCliPath);
  if (packageRoot) {
    addDirChain(args, packageRoot);
    args.push("--ro-bind", packageRoot, packageRoot);
    return realCliPath;
  }

  addDirChain(args, path.dirname(realCliPath));
  args.push("--ro-bind", realCliPath, realCliPath);
  return realCliPath;
}

async function addCommandRuntimeBinds(
  args: string[],
  command: string,
): Promise<void> {
  const commandPath = await whichBin(command);
  if (!commandPath) return;

  addDirChain(args, path.dirname(commandPath));
  args.push("--ro-bind", commandPath, commandPath);

  const realCommandPath = await fs.realpath(commandPath).catch(() => commandPath);
  const packageRoot = nodePackageRoot(realCommandPath);
  if (packageRoot) {
    addDirChain(args, packageRoot);
    args.push("--ro-bind", packageRoot, packageRoot);
    return;
  }

  if (realCommandPath !== commandPath && (await exists(realCommandPath))) {
    addDirChain(args, path.dirname(realCommandPath));
    args.push("--ro-bind", realCommandPath, realCommandPath);
  }
}

async function addAgentBrowserRuntimeBinds(
  args: string[],
  sandboxHomeSource: string,
  sandboxHomeTarget: string,
): Promise<void> {
  const commandPath = await whichBin("agent-browser");
  if (!commandPath) return;

  await addCommandRuntimeBinds(args, "agent-browser");

  const stateDirSource = path.join(sandboxHomeSource, ".agent-browser");
  await fs.mkdir(stateDirSource, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirSource, 0o700).catch(() => undefined);

  const hostHome = process.env.HOME;
  if (!hostHome) return;

  const hostAgentBrowserDir = path.join(hostHome, ".agent-browser");
  const sandboxAgentBrowserDir = path.join(
    sandboxHomeTarget,
    ".agent-browser",
  );

  for (const name of ["browsers", "skills", "skill-data"]) {
    await addRoBindAtIfExists(
      args,
      path.join(hostAgentBrowserDir, name),
      path.join(sandboxAgentBrowserDir, name),
    );
  }

  const puppeteerCache = path.join(hostHome, ".cache", "puppeteer");
  await addRoBindAtIfExists(
    args,
    puppeteerCache,
    path.join(sandboxHomeTarget, ".cache", "puppeteer"),
  );
}

async function addAgentConfigBinds(
  args: string[],
  sandboxHomeSource: string,
  sandboxHomeTarget: string,
): Promise<void> {
  const hostHome = process.env.HOME;
  if (!hostHome) return;

  for (const dir of [".codex", ".claude", ".cline", ".gemini"]) {
    await fs.mkdir(path.join(sandboxHomeSource, dir), {
      recursive: true,
      mode: 0o700,
    });
  }

  const sharedEntries = [
    ".claude.json",
    ".codex.json",
    ".cline.json",
    ".gemini.json",
    ".codex/AGENTS.md",
    ".codex/config.toml",
    ".codex/auth.json",
    ".codex/credentials.json",
    ".codex/models_cache.json",
    ".codex/skills",
    ".codex/plugins",
    ".codex/rules",
    ".claude/.credentials.json",
    ".claude/CLAUDE.md",
    ".claude/auth.json",
    ".claude/credentials.json",
    ".claude/mcp-needs-auth-cache.json",
    ".claude/oauth.json",
    ".claude/oauth_creds.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/commands",
    ".claude/plugins",
    ".claude/skills",
    ".cline/.credentials.json",
    ".cline/auth.json",
    ".cline/credentials.json",
    ".cline/mcp_settings.json",
    ".cline/settings.json",
    ".cline/skills",
    ".gemini/config.json",
    ".gemini/google_accounts.json",
    ".gemini/oauth_creds.json",
    ".gemini/projects.json",
    ".gemini/settings.json",
    ".gemini/antigravity/mcp_config.json",
    ".config/codex",
    ".config/claude",
    ".config/cline",
    ".config/gemini",
    ".config/anthropic",
  ];
  const entries = Array.from(
    new Set([...sharedEntries, ...(await clinePrefixEntries(hostHome))]),
  ).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  const bound: string[] = [];
  for (const rel of entries) {
    if (skipNestedBind(rel, bound)) continue;
    await addRoBindAtIfExists(
      args,
      path.join(hostHome, rel),
      path.join(sandboxHomeTarget, rel),
    );
    if (await exists(path.join(hostHome, rel))) bound.push(rel);
  }
}

async function buildBubblewrapSpawnPlan(input: {
  cli: CliName;
  cliPath: string;
  cliArgs: string[];
  cwd: string;
  sandbox: BubblewrapSandbox;
}): Promise<SpawnPlan> {
  const bwrap = await whichBin("bwrap");
  if (!bwrap) {
    throw new Error("bubblewrap (bwrap) is required for public CLI sandboxing");
  }

  const sandboxHomeSource = path.resolve(
    input.sandbox.homeDir ?? DEFAULT_PUBLIC_CLI_HOME,
  );
  await fs.mkdir(sandboxHomeSource, { recursive: true, mode: 0o700 });
  await fs.chmod(sandboxHomeSource, 0o700).catch(() => undefined);

  const hostHome = process.env.HOME || "/home/clio-public";
  const sandboxHomeTarget = hostHome.startsWith("/")
    ? hostHome
    : "/home/clio-public";
  const cwd = path.resolve(input.cwd);
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
  ];
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  args.push(
    "--dir",
    "/run/user",
    "--dir",
    `/run/user/${uid}`,
    "--dir",
    "/home",
    "--bind",
    sandboxHomeSource,
    sandboxHomeTarget,
  );

  for (const systemPath of [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
  ]) {
    await addRoBindIfExists(args, systemPath);
  }
  await addResolvedFileBindIfNeeded(args, "/etc/resolv.conf");

  await addAgentConfigBinds(args, sandboxHomeSource, sandboxHomeTarget);
  const sandboxCliPath = await addCliRuntimeBinds(args, input.cli, input.cliPath);
  await addAgentBrowserRuntimeBinds(args, sandboxHomeSource, sandboxHomeTarget);

  args.push(
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--clearenv",
  );

  const env = publicSandboxEnv(sandboxHomeTarget);
  for (const [key, value] of Object.entries(env)) {
    if (value != null) args.push("--setenv", key, value);
  }

  args.push(sandboxCliPath, ...input.cliArgs);
  return {
    command: bwrap,
    args,
    cwd: "/",
    env: publicSandboxEnv(sandboxHomeTarget),
  };
}

export async function runCli(
  cli: CliName,
  prompt: string,
  opts: {
    safeMode?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    /** Override config caps for testing. */
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    /**
     * When the caller's signal aborts, by default we SIGTERM the child so it
     * does not outlive the HTTP request. Long-running ingest jobs need the
     * opposite — if the browser/proxy drops the streaming response while the
     * CLI is mid sub-chunk, we want the CLI to keep running to completion and
     * persist its progress. Setting this to false detaches abort from kill.
     * Defaults to true to preserve historical behavior for other callers.
     */
    killOnAbort?: boolean;
    /** Working directory for this CLI process. Defaults to the wiki repo. */
    cwd?: string;
    /** Directory exposed to CLIs that support explicit project scopes. */
    projectRoot?: string;
    /** Allow Codex to run from a non-git, intentionally isolated cwd. */
    skipGitRepoCheck?: boolean;
    /** Optional process sandbox. Public endpoints should use bubblewrap. */
    sandbox?: CliSandbox;
  } = {},
): Promise<RunResult> {
  const info = await detectCli(cli);
  if (!info.path) {
    throw new Error(
      `coding agent CLI not found on host: ${cli}. Settings 탭에서 경로를 지정하거나 호스트에 설치하세요.`,
    );
  }
  const cfg = await loadConfig();
  const stdoutCap = opts.maxStdoutBytes ?? cfg.cli.maxStdoutBytes;
  const stderrCap = opts.maxStderrBytes ?? cfg.cli.maxStderrBytes;
  const promptWarnCap = cfg.cli.promptWarnBytes;

  if (prompt.length > promptWarnCap) {
    // We do not truncate here — the slim prompt builder is the primary
    // defense. But once the prompt exceeds the OS argv ceiling (typically
    // 128 KB to 2 MB) spawn itself fails with E2BIG, so surface a warning
    // and let the caller shrink the prompt.
    console.warn(
      `[runCli] prompt is ${prompt.length} chars (cap ~${promptWarnCap}). ` +
        `Reduce contextTurns or move shared context into wiki/.progress/.`,
    );
  }

  const cwd = opts.cwd ?? PROJECT_ROOT;
  const projectRoot = opts.projectRoot ?? cwd;
  const args = buildArgs(
    cli,
    prompt,
    opts.safeMode ?? false,
    projectRoot,
    opts.skipGitRepoCheck ?? false,
  );
  const spawnPlan = opts.sandbox
    ? await buildBubblewrapSpawnPlan({
        cli,
        cliPath: info.path,
        cliArgs: args,
        cwd,
        sandbox: opts.sandbox,
      })
    : {
        command: info.path,
        args,
        cwd,
        env: { ...process.env },
      };
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: spawnPlan.cwd,
      env: spawnPlan.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutBuf = new TailBuffer(stdoutCap);
    const stderrBuf = new TailBuffer(stderrCap);
    let closed = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdoutBuf.push(chunk);
      opts.onStdout?.(chunk);
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderrBuf.push(chunk);
      opts.onStderr?.(chunk);
    });

    let timeoutKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          timeoutKillTimer ??= setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 2000);
        }, opts.timeoutMs)
      : null;
    const killOnAbort = opts.killOnAbort ?? true;
    const onAbort = () => {
      child.kill("SIGTERM");
      abortKillTimer ??= setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 2000);
    };
    if (killOnAbort && opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort);
      }
    }

    child.on("error", (err) => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (killOnAbort) opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (timeoutKillTimer) clearTimeout(timeoutKillTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (killOnAbort) opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        stdoutTruncated: stdoutBuf.truncation(),
        stderrTruncated: stderrBuf.truncation(),
      });
    });
  });
}
