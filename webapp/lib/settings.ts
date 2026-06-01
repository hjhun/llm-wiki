import "server-only";

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectAllCli } from "./cli";
import { configPaths, loadConfig } from "./config";
import { PROJECT_ROOT } from "./paths";

export type ToolStatus = {
  name: "graphify" | "qmd" | "marp" | "bwrap";
  status: "ready" | "warning" | "missing";
  path: string | null;
  version: string | null;
  note: string;
  details?: Record<string, string | number | boolean | null>;
};

async function runTool(
  absPath: string,
  args: string[],
  timeout = 4000,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(absPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.stderr?.on("data", (d) => (buf += d.toString()));
    child.on("error", () => resolve({ exitCode: null, output: buf }));
    child.on("close", (code) => {
      resolve({ exitCode: code, output: buf });
    });
  });
}

async function runVersion(absPath: string): Promise<string | null> {
  const result = await runTool(absPath, ["--version"]);
  return result.output.trim().split(/\r?\n/)[0]?.slice(0, 80) || null;
}

async function runQmdStatus(absPath: string): Promise<{
  status: ToolStatus["status"];
  note: string;
  details: Record<string, string | number | boolean | null>;
}> {
  const result = await runTool(absPath, ["collection", "list"], 5000);
  const output = result.output;
  const hasCollections = !/No collections/i.test(output);
  const details = {
    collections: hasCollections,
  };

  if (result.exitCode !== 0) {
    return {
      status: "warning",
      note: "qmd는 감지됐지만 상태 확인에 실패했습니다. qmd status를 터미널에서 확인하세요.",
      details,
    };
  }
  if (!hasCollections) {
    return {
      status: "warning",
      note: "qmd는 설치됐지만 wiki 컬렉션/인덱스가 비어 있습니다. `qmd collection add wiki && qmd update`를 실행하세요.",
      details,
    };
  }

  return {
    status: "ready",
    note: "qmd 컬렉션이 준비되어 있습니다. wiki-search-qmd가 후보 검색에 사용할 수 있습니다.",
    details,
  };
}

async function graphifyPython(absPath: string): Promise<string> {
  try {
    const firstLine = (await fs.readFile(absPath, "utf8")).split(/\r?\n/)[0];
    const candidate = firstLine.replace(/^#!/, "");
    if (candidate.includes("python")) {
      try {
        const st = await fs.stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // fall through to python3
      }
    }
  } catch {
    // fall through to python3
  }
  return "python3";
}

async function runGraphifyVersion(absPath: string): Promise<string | null> {
  const python = await graphifyPython(absPath);
  return new Promise((resolve) => {
    const child = spawn(
      python,
      [
        "-c",
        "from importlib.metadata import version; print(version('graphifyy'))",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 4000,
      },
    );
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
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

async function detectQmd(): Promise<ToolStatus> {
  const local = await firstExecutable([
    path.join(PROJECT_ROOT, "tools", "qmd", "node_modules", ".bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", ".venv", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "run.sh"),
  ]);
  const found = local ?? (await whichBin("qmd"));
  if (!found) {
    return {
      name: "qmd",
      status: "missing",
      path: null,
      version: null,
      note: "qmd가 없습니다. ./setup.sh를 실행하거나 npm install --prefix tools/qmd @tobilu/qmd를 실행하세요.",
    };
  }

  const qmd = await runQmdStatus(found);
  return {
    name: "qmd",
    status: qmd.status,
    path: found,
    version: await runVersion(found),
    note: qmd.note,
    details: qmd.details,
  };
}

async function detectGraphify(): Promise<ToolStatus> {
  const global = await whichBin("graphify");
  if (global) {
    return {
      name: "graphify",
      status: "ready",
      path: global,
      version: await runGraphifyVersion(global),
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
  name: "qmd" | "marp" | "bwrap",
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
  const [cli, graphify, qmd, marp, bwrap] = await Promise.all([
    detectAllCli(),
    detectGraphify(),
    detectQmd(),
    detectOptionalTool("marp", "marp"),
    detectOptionalTool("bwrap", "bwrap"),
  ]);

  return {
    projectRoot: PROJECT_ROOT,
    configPaths: configPaths(),
    config: {
      server: cfg.server,
      agent: cfg.agent,
      chunking: cfg.chunking,
      graph: cfg.graph,
      search: cfg.search,
      ui: cfg.ui,
      auth: {
        passwordSet: cfg.auth.passwordHash != null,
        sessionTtlSec: cfg.auth.sessionTtlSec,
      },
      publicQuery: {
        // The access passphrase is never sent to the client; only a flag.
        // It is set/cleared via the dedicated /api/settings/public-token route.
        enabled: cfg.publicQuery.enabled,
        accessTokenSet:
          typeof cfg.publicQuery.accessToken === "string" &&
          cfg.publicQuery.accessToken.length > 0,
        allowExternalLookup: cfg.publicQuery.allowExternalLookup,
        sandboxEnabled: cfg.publicQuery.sandboxEnabled,
        sandboxReadOnlyHomePaths: cfg.publicQuery.sandboxReadOnlyHomePaths,
      },
      telegram: {
        // The bot token is never sent to the client; only a flag indicating
        // whether one is configured. Setting/clearing the token has its own
        // dedicated POST endpoints that ignore the GET payload.
        enabled: cfg.telegram.enabled,
        botTokenSet: typeof cfg.telegram.botToken === "string" && cfg.telegram.botToken.length > 0,
        mode: cfg.telegram.mode,
        webhookPublicUrl: cfg.telegram.webhookPublicUrl,
        webhookSecretSet:
          typeof cfg.telegram.webhookSecret === "string" && cfg.telegram.webhookSecret.length > 0,
        allowlist: cfg.telegram.allowlist,
        pending: cfg.telegram.pending,
        rejectionMessage: cfg.telegram.rejectionMessage,
        historyTurns: cfg.telegram.historyTurns,
        replyMaxChars: cfg.telegram.replyMaxChars,
        allowExternalLookup: cfg.telegram.allowExternalLookup,
      },
      autoIngest: cfg.autoIngest,
      autoLint: cfg.autoLint,
    },
    cli,
    tools: [graphify, qmd, marp, bwrap],
  };
}
