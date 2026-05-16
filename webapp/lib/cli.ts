import "server-only";

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { PROJECT_ROOT } from "./paths";

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

export async function detectCli(name: CliName): Promise<CliInfo> {
  const cfg = await loadConfig();
  const explicit = (cfg.agent.paths as Record<string, string | undefined>)[
    name
  ];
  if (explicit && existsSync(explicit)) {
    return {
      name,
      path: explicit,
      version: await runVersion(explicit),
      source: "config",
    };
  }
  const found = await whichBin(name);
  if (found) {
    return {
      name,
      path: found,
      version: await runVersion(found),
      source: "PATH",
    };
  }
  return { name, path: null, version: null, source: "missing" };
}

export async function detectAllCli(): Promise<CliInfo[]> {
  return Promise.all(CLI_NAMES.map((n) => detectCli(n)));
}

function buildArgs(
  cli: CliName,
  prompt: string,
  safeMode: boolean,
): string[] {
  switch (cli) {
    case "codex":
      return safeMode
        ? ["exec", prompt]
        : ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt];
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
            PROJECT_ROOT,
          ]
        : [
            "--prompt",
            prompt,
            "--approval-mode",
            "yolo",
            "--include-directories",
            PROJECT_ROOT,
          ];
    case "cline":
      return safeMode ? [prompt] : ["-y", prompt];
  }
}

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export async function runCli(
  cli: CliName,
  prompt: string,
  opts: {
    safeMode?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const info = await detectCli(cli);
  if (!info.path) {
    throw new Error(
      `coding agent CLI not found on host: ${cli}. Settings 탭에서 경로를 지정하거나 호스트에 설치하세요.`,
    );
  }
  const args = buildArgs(cli, prompt, opts.safeMode ?? false);
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(info.path!, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
      });
    });
  });
}
