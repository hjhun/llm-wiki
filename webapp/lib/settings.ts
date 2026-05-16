import "server-only";

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectAllCli } from "./cli";
import { configPaths, loadConfig } from "./config";
import { PROJECT_ROOT } from "./paths";

export type ToolStatus = {
  name: "graphify" | "qmd" | "marp";
  status: "ready" | "missing";
  path: string | null;
  version: string | null;
  note: string;
};

async function runVersion(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(absPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 4000,
    });
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.stderr?.on("data", (d) => (buf += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      resolve(buf.trim().split(/\r?\n/)[0]?.slice(0, 80) || null);
    });
  });
}

async function whichBin(bin: string): Promise<string | null> {
  const PATH = process.env.PATH ?? "";
  const dirs = [
    ...PATH.split(process.platform === "win32" ? ";" : ":").filter(Boolean),
    path.join(process.env.HOME ?? "/", ".local", "bin"),
    path.join(process.env.HOME ?? "/", ".npm-global", "bin"),
    "/usr/local/bin",
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, bin);
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // missing path is fine
    }
  }
  return null;
}

async function detectGraphify(): Promise<ToolStatus> {
  const global = await whichBin("graphify");
  if (global) {
    return {
      name: "graphify",
      status: "ready",
      path: global,
      version: await runVersion(global),
      note: "PATH의 글로벌 graphify를 사용합니다.",
    };
  }

  return {
    name: "graphify",
    status: "missing",
    path: null,
    version: null,
    note: "PATH의 글로벌 graphify가 없습니다. ./setup.sh를 실행하거나 graphifyy를 설치하세요.",
  };
}

async function detectOptionalTool(
  name: "qmd" | "marp",
  bin: string,
): Promise<ToolStatus> {
  const found = await whichBin(bin);
  if (!found) {
    return {
      name,
      status: "missing",
      path: null,
      version: null,
      note: "옵션 도구입니다. 없어도 기본 Chat/Explorer/Graph는 동작합니다.",
    };
  }
  return {
    name,
    status: "ready",
    path: found,
    version: await runVersion(found),
    note: "PATH에서 감지되었습니다.",
  };
}

export async function readSettingsState() {
  const cfg = await loadConfig();
  const [cli, graphify, qmd, marp] = await Promise.all([
    detectAllCli(),
    detectGraphify(),
    detectOptionalTool("qmd", "qmd"),
    detectOptionalTool("marp", "marp"),
  ]);

  return {
    projectRoot: PROJECT_ROOT,
    configPaths: configPaths(),
    config: {
      server: cfg.server,
      agent: cfg.agent,
      chunking: cfg.chunking,
      graph: cfg.graph,
      ui: cfg.ui,
      auth: {
        passwordSet: cfg.auth.passwordHash != null,
        sessionTtlSec: cfg.auth.sessionTtlSec,
      },
    },
    cli,
    tools: [graphify, qmd, marp],
  };
}
