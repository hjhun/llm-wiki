import "server-only";

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";

export type ReleaseInfo = {
  repo: string;
  installScriptUrl: string;
  currentVersion: string | null;
  latestVersion: string | null;
  latestName: string | null;
  latestUrl: string | null;
  latestPublishedAt: string | null;
  currentRef: string | null;
  currentCommit: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  note: string;
};

export type UpdateResult = {
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string;
  command: string;
};

const REPO = "hjhun/llm-wiki";
const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/hjhun/llm-wiki/main/scripts/install.sh";
const UPDATE_LOCK_PATH = path.join(PROJECT_ROOT, ".run", "update.lock");
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_LIMIT = 80_000;

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  html_url?: string | null;
  published_at?: string | null;
};

async function readCurrentVersion(): Promise<string | null> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(PROJECT_ROOT, "webapp", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function runShort(
  command: string,
  args: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(output.trim().split(/\r?\n/)[0]?.slice(0, 120) || null);
    });
  });
}

function parseSemver(version: string | null): number[] | null {
  if (!version) return null;
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(latest: string | null, current: string | null): boolean {
  const latestParts = parseSemver(latest);
  const currentParts = parseSemver(current);
  if (!latestParts || !currentParts) return false;
  for (let i = 0; i < latestParts.length; i += 1) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

export async function readReleaseInfo(): Promise<ReleaseInfo> {
  const checkedAt = new Date().toISOString();
  const [currentVersion, currentRef, currentCommit] = await Promise.all([
    readCurrentVersion(),
    runShort("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    runShort("git", ["rev-parse", "--short", "HEAD"]),
  ]);

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      cache: "no-store",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "clio-settings-update-check",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub release check failed (${res.status})`);
    }

    const release = (await res.json()) as GitHubRelease;
    const latestVersion = release.tag_name ?? null;
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);
    const note = updateAvailable
      ? "A newer GitHub release is available."
      : "This install is at or ahead of the latest comparable release.";

    return {
      repo: REPO,
      installScriptUrl: INSTALL_SCRIPT_URL,
      currentVersion,
      latestVersion,
      latestName: release.name ?? null,
      latestUrl: release.html_url ?? null,
      latestPublishedAt: release.published_at ?? null,
      currentRef,
      currentCommit,
      updateAvailable,
      checkedAt,
      note,
    };
  } catch (err) {
    return {
      repo: REPO,
      installScriptUrl: INSTALL_SCRIPT_URL,
      currentVersion,
      latestVersion: null,
      latestName: null,
      latestUrl: null,
      latestPublishedAt: null,
      currentRef,
      currentCommit,
      updateAvailable: false,
      checkedAt,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function acquireUpdateLock() {
  await fs.mkdir(path.dirname(UPDATE_LOCK_PATH), { recursive: true });
  try {
    const handle = await fs.open(UPDATE_LOCK_PATH, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error("An update is already running.");
    }
    throw err;
  }
}

export async function runReleaseUpdate(): Promise<UpdateResult> {
  const lock = await acquireUpdateLock();
  const startedAt = new Date().toISOString();
  const command =
    `curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- update --dir ${PROJECT_ROOT}`;

  try {
    return await new Promise<UpdateResult>((resolve) => {
      let settled = false;
      const finish = (result: UpdateResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn(
        "bash",
        [
          "-lc",
          `curl -fsSL "${INSTALL_SCRIPT_URL}" | bash -s -- update --dir "$1"`,
          "clio-update",
          PROJECT_ROOT,
        ],
        {
          cwd: PROJECT_ROOT,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: UPDATE_TIMEOUT_MS,
        },
      );

      let output = "";
      const append = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(output.length - OUTPUT_LIMIT);
        }
      };

      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => {
        output += `\n${err instanceof Error ? err.message : String(err)}`;
        finish({
          exitCode: null,
          output: output.trim(),
          startedAt,
          finishedAt: new Date().toISOString(),
          command,
        });
      });
      child.on("close", (exitCode) => {
        finish({
          exitCode,
          output: output.trim(),
          startedAt,
          finishedAt: new Date().toISOString(),
          command,
        });
      });
    });
  } finally {
    await lock.close().catch(() => undefined);
    await fs.unlink(UPDATE_LOCK_PATH).catch(() => undefined);
  }
}
