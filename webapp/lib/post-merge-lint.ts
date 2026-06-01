import "server-only";

import { spawn } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";

const SCRIPT_REL = "scripts/mini-lint.mjs";

export type PostMergeLintResult = {
  ran: boolean;
  totals?: {
    pages: number;
    duplicates: number;
    brokenLinks: number;
    orphans: number;
  };
  reportPath?: string | null;
  note: string;
  error?: string;
};

function runNode(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }>
{
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, SCRIPT_REL), ...args],
      {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/**
 * Run scripts/mini-lint.mjs as a deterministic post-merge gate. Returns a
 * compact chat note summarizing duplicate-title, broken-wikilink, and orphan
 * findings. Failure to spawn the script is reported as a soft warning — the
 * loop never blocks on lint errors.
 */
export async function runPostMergeMiniLint(input: {
  signal?: AbortSignal;
} = {}): Promise<PostMergeLintResult> {
  try {
    const result = await runNode(["--json", "--quiet"], input.signal);
    if (result.code !== 0 && result.code !== 1) {
      return {
        ran: false,
        note:
          `\n\n---\n\n[post-merge mini-lint] 스크립트 실행 실패 ` +
          `(exitCode=${result.code}). 상세: ${result.stderr.trim().slice(0, 200)}\n`,
        error: result.stderr,
      };
    }
    let parsed: {
      totals: PostMergeLintResult["totals"];
      reportPath: string | null;
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      return {
        ran: false,
        note:
          `\n\n---\n\n[post-merge mini-lint] JSON 파싱 실패: ${(err as Error).message}\n`,
        error: result.stdout,
      };
    }
    const totals = parsed.totals ?? {
      pages: 0,
      duplicates: 0,
      brokenLinks: 0,
      orphans: 0,
    };
    const issueCount = totals.duplicates + totals.brokenLinks + totals.orphans;
    const label = issueCount === 0 ? "🟢 clean" : `🟡 ${issueCount} issue${issueCount === 1 ? "" : "s"}`;
    const lines = [
      "",
      "",
      "---",
      "",
      `[post-merge mini-lint] ${label} · pages=${totals.pages}, duplicates=${totals.duplicates}, broken=${totals.brokenLinks}, orphans=${totals.orphans}`,
    ];
    if (parsed.reportPath) {
      lines.push(`Report: \`${parsed.reportPath}\``);
    }
    if (issueCount > 0) {
      lines.push(
        "Run `/lint` (or open the report above) to triage these findings before the next ingest cycle.",
      );
    }
    return {
      ran: true,
      totals,
      reportPath: parsed.reportPath,
      note: lines.join("\n") + "\n",
    };
  } catch (err) {
    return {
      ran: false,
      note:
        `\n\n---\n\n[post-merge mini-lint] 실행 중 예외: ${(err as Error).message}\n`,
      error: (err as Error).stack ?? (err as Error).message,
    };
  }
}
