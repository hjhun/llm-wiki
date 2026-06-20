import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CLI_NAMES, detectCli, type CliName } from "../cli";
import { PROJECT_ROOT } from "../paths";

export type AutomationToolName =
  | "agent-browser"
  | "git"
  | "gh"
  | "yt-dlp"
  | "npm"
  | "python3"
  | "qmd"
  | "marp";

export type AutomationToolStatus = {
  name: AutomationToolName;
  status: "ready" | "missing";
  path: string | null;
  version: string | null;
  installHint: string | null;
};

export type AutomationSkillStatus = {
  name: string;
  status: "ready" | "missing";
  paths: string[];
  installHint: string | null;
};

export type AutomationToolInventory = {
  tools: AutomationToolStatus[];
  skills: AutomationSkillStatus[];
  agents: AutomationAgentCapability[];
};

export type AutomationAgentInvocation =
  | "codex-exec"
  | "claude-print"
  | "agy-prompt"
  | "cline-y"
  | "unknown";

export type AutomationAgentCapability = {
  name: CliName;
  status: "ready" | "missing" | "unknown";
  path: string | null;
  version: string | null;
  invocation: AutomationAgentInvocation;
  helpCommands: string[];
  supportsJson: boolean;
  supportsStreaming: boolean;
  supportsSandbox: boolean;
  supportsResume: boolean;
  supportsModel: boolean;
  warning: string | null;
};

const TOOL_NAMES: AutomationToolName[] = [
  "agent-browser",
  "git",
  "gh",
  "yt-dlp",
  "npm",
  "python3",
  "qmd",
  "marp",
];

const INSTALL_HINTS: Partial<Record<AutomationToolName, string>> = {
  "agent-browser":
    "Run ./setup.sh --with-agent-browser (or --with-automation-tools), or npm install -g agent-browser && agent-browser install.",
  "yt-dlp":
    "Run ./setup.sh --with-yt-dlp (or --with-automation-tools), or install with pipx/pip/your OS package manager.",
  gh: "Run ./setup.sh --with-gh (or --with-automation-tools), then authenticate with gh auth login. Manual: https://cli.github.com/.",
  qmd: "Run ./setup.sh or install with npm install --prefix tools/qmd @tobilu/qmd.",
  marp: "Run ./setup.sh --with-marp or npm install -g @marp-team/marp-cli.",
};

async function whichBin(bin: string): Promise<string | null> {
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = [
    ...(process.env.PATH ?? "").split(sep).filter(Boolean),
    path.join(process.env.HOME ?? "/", ".npm-global", "bin"),
    path.join(process.env.HOME ?? "/", ".local", "bin"),
    "/usr/local/bin",
    "/snap/bin",
  ];
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
        // continue
      }
    }
  }
  return null;
}

async function localToolBin(name: AutomationToolName): Promise<string | null> {
  if (name !== "qmd") return null;
  const candidates = [
    path.join(PROJECT_ROOT, "tools", "qmd", "node_modules", ".bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", ".venv", "bin", "qmd"),
    path.join(PROJECT_ROOT, "tools", "qmd", "run.sh"),
  ];
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

async function version(absPath: string): Promise<string | null> {
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
      resolve(buf.trim().split(/\r?\n/)[0]?.slice(0, 120) || null);
    });
  });
}

export async function detectAutomationTools(): Promise<AutomationToolInventory> {
  const [tools, skills, agents] = await Promise.all([
    Promise.all(
      TOOL_NAMES.map(async (name): Promise<AutomationToolStatus> => {
        const found = (await localToolBin(name)) ?? (await whichBin(name));
        return {
          name,
          status: found ? "ready" : "missing",
          path: found,
          version: found ? await version(found) : null,
          installHint: found ? null : INSTALL_HINTS[name] ?? null,
        };
      }),
    ),
    detectSkills(["agent-browser", "find-skills"]),
    detectAgentCapabilities(),
  ]);
  return { tools, skills, agents };
}

async function detectAgentCapabilities(): Promise<AutomationAgentCapability[]> {
  return Promise.all(
    CLI_NAMES.map(async (name): Promise<AutomationAgentCapability> => {
      const info = await detectCli(name);
      if (!info.path) {
        return {
          name,
          status: "missing",
          path: null,
          version: null,
          invocation: "unknown",
          helpCommands: [],
          supportsJson: false,
          supportsStreaming: false,
          supportsSandbox: false,
          supportsResume: false,
          supportsModel: false,
          warning: "CLI not found on PATH or in Settings.",
        };
      }

      const help = await readAgentHelp(name, info.path);
      return parseAgentCapability({
        name,
        path: info.path,
        version: info.version,
        help,
      });
    }),
  );
}

async function readAgentHelp(
  name: CliName,
  absPath: string,
): Promise<Array<{ command: string; text: string | null }>> {
  const argsByCli: Record<CliName, string[][]> = {
    codex: [["-h"], ["exec", "-h"]],
    claude: [["-h"], ["-p", "-h"]],
    agy: [["-h"]],
    cline: [["-h"]],
  };
  return Promise.all(
    argsByCli[name].map(async (args) => ({
      command: [path.basename(absPath), ...args].join(" "),
      text: await helpOutput(absPath, args),
    })),
  );
}

function helpOutput(absPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(absPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    let buf = "";
    child.stdout?.on("data", (d) => (buf += d.toString()));
    child.stderr?.on("data", (d) => (buf += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(buf.trim() || null));
  });
}

export function parseAgentCapability(input: {
  name: CliName;
  path: string;
  version: string | null;
  help: Array<{ command: string; text: string | null }>;
}): AutomationAgentCapability {
  const combined = input.help
    .map((item) => item.text ?? "")
    .join("\n")
    .toLowerCase();
  const helpCommands = input.help
    .filter((item) => item.text)
    .map((item) => item.command);
  const invocation = detectInvocation(input.name, combined);
  const status = invocation === "unknown" ? "unknown" : "ready";
  return {
    name: input.name,
    status,
    path: input.path,
    version: input.version,
    invocation,
    helpCommands,
    supportsJson: hasAny(combined, ["--json", "stream-json", "output-format json"]),
    supportsStreaming: hasAny(combined, ["stream-json", "--stream", "partial"]),
    supportsSandbox:
      hasAny(combined, [
        "--sandbox",
        "--permission-mode",
        "--dangerously",
        "--yolo",
      ]) ||
      (input.name === "cline" && hasShortFlag(combined, "y")),
    supportsResume: hasAny(combined, [
      "resume",
      "--resume",
      "--session-id",
      "--id",
      "thread_id",
    ]),
    supportsModel: hasAny(combined, ["--model", "--effort", "--reasoning"]),
    warning:
      status === "ready"
        ? null
        : "Installed CLI was found, but CLIO could not confirm its non-interactive automation shape from help output.",
  };
}

function detectInvocation(
  name: CliName,
  helpText: string,
): AutomationAgentInvocation {
  switch (name) {
    case "codex":
      return hasAny(helpText, ["codex exec", "exec [options]", "--json"])
        ? "codex-exec"
        : "unknown";
    case "claude":
      return hasAny(helpText, ['-p "', "--print", "print response"])
        ? "claude-print"
        : "unknown";
    case "agy":
      return hasAny(helpText, ["--prompt", "agy --prompt"]) ? "agy-prompt" : "unknown";
    case "cline":
      return hasAny(helpText, ["cline -y", "--id"]) || hasShortFlag(helpText, "y")
        ? "cline-y"
        : "unknown";
  }
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function hasShortFlag(haystack: string, flag: string): boolean {
  return new RegExp(`(^|\\s)-${flag}(\\s|,|$)`).test(haystack);
}

async function detectSkills(names: string[]): Promise<AutomationSkillStatus[]> {
  const roots = [
    path.join(PROJECT_ROOT, ".agents", "skills"),
    path.join(process.env.HOME ?? "/", ".agents", "skills"),
    path.join(process.env.HOME ?? "/", ".codex", "skills"),
    path.join(process.env.HOME ?? "/", ".claude", "skills"),
  ];
  return Promise.all(
    names.map(async (name): Promise<AutomationSkillStatus> => {
      const paths: string[] = [];
      for (const root of roots) {
        const candidate = path.join(root, name, "SKILL.md");
        try {
          const st = await fs.stat(candidate);
          if (st.isFile()) paths.push(path.dirname(candidate));
        } catch {
          // missing
        }
      }
      return {
        name,
        status: paths.length > 0 ? "ready" : "missing",
        paths,
        installHint:
          paths.length > 0
            ? null
            : "Use the Skills CLI: npx skills find <topic>, then npx skills add <package>.",
      };
    }),
  );
}

export async function installAutomationTool(
  name: AutomationToolName,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (name !== "agent-browser") {
    throw new Error(`install is not allowlisted for tool: ${name}`);
  }
  const npmInstall = await runInstallCommand("npm", [
    "install",
    "-g",
    "agent-browser",
  ]);
  if (!npmInstall.ok) return npmInstall;
  const browserInstall = await runInstallCommand("agent-browser", ["install"]);
  return {
    ok: browserInstall.ok,
    stdout: `${npmInstall.stdout}\n${browserInstall.stdout}`,
    stderr: `${npmInstall.stderr}\n${browserInstall.stderr}`,
  };
}

function runInstallCommand(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr }),
    );
  });
}
