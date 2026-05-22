import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { PROJECT_ROOT } from "./paths";
import { errorMessage } from "./api";

type QmdRunResult = {
  ok: boolean;
  note: string;
};

async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function whichQmd(): Promise<string | null> {
  const local = await firstExecutable([
    path.join(PROJECT_ROOT, "tools", "qmd", "node_modules", ".bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", ".venv", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "run.sh"),
  ]);
  if (local) return local;

  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = [
    ...(process.env.PATH ?? "").split(sep).filter(Boolean),
    path.join(process.env.HOME ?? "/", ".npm-global", "bin"),
    "/usr/local/bin",
  ];
  return firstExecutable(dirs.map((dir) => path.join(dir, "qmd")));
}

function runQmd(
  qmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(qmd, args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).name === "AbortError") {
        resolve({ exitCode: null, output });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ exitCode: code, output }));
  });
}

export async function maybeRefreshQmdIndex(input: {
  cfg: Config;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<QmdRunResult> {
  const qmdConfig = input.cfg.search.qmd;
  if (!qmdConfig.enabled || !qmdConfig.autoUpdateOnWikiChange) {
    return { ok: true, note: "" };
  }

  const qmd = await whichQmd();
  if (!qmd) {
    const note =
      "\n\n---\n\n[auto qmd skipped] qmd를 찾지 못했습니다. `./setup.sh`를 다시 실행하세요.\n";
    input.onChunk?.(note);
    return { ok: true, note };
  }

  const note = `\n\n---\n\n[auto qmd] \`${path.relative(PROJECT_ROOT, qmd) || qmd} update\`를 실행합니다.\n`;
  input.onChunk?.(note);
  try {
    const collections = await runQmd(qmd, ["collection", "list"], input.signal);
    if (/No collections/i.test(collections.output)) {
      const add = await runQmd(qmd, ["collection", "add", "wiki"], input.signal);
      if (add.exitCode !== 0) {
        return {
          ok: false,
          note:
            `${note}\n[auto qmd blocker] wiki 컬렉션 생성 실패\n\n` +
            add.output.trim(),
        };
      }
    }

    const update = await runQmd(qmd, ["update"], input.signal);
    if (update.exitCode !== 0) {
      return {
        ok: false,
        note:
          `${note}\n[auto qmd blocker] qmd update 실패\n\n` +
          update.output.trim(),
      };
    }

    if (qmdConfig.embedEnabled) {
      const embed = await runQmd(qmd, ["embed"], input.signal);
      if (embed.exitCode !== 0) {
        return {
          ok: false,
          note:
            `${note}\n[auto qmd blocker] qmd embed 실패\n\n` +
            embed.output.trim(),
        };
      }
    }

    return {
      ok: true,
      note: `${note}\n[auto qmd result] wiki 검색 인덱스를 갱신했습니다.`,
    };
  } catch (err) {
    return {
      ok: false,
      note: `${note}\n[auto qmd blocker] ${errorMessage(err)}`,
    };
  }
}
