import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig, type Config } from "@/lib/config";
import { readSettingsState } from "@/lib/settings";

export const dynamic = "force-dynamic";

const AgentPaths = z.object({
  codex: z.string().optional(),
  claude: z.string().optional(),
  gemini: z.string().optional(),
  cline: z.string().optional(),
});

const Body = z.object({
  server: z
    .object({
      port: z.number().int().min(1).max(65535),
      host: z.string().min(1),
    })
    .optional(),
  agent: z
    .object({
      default: z.enum(["codex", "claude", "gemini", "cline"]).nullable(),
      safeMode: z.boolean(),
      paths: AgentPaths,
    })
    .optional(),
  chunking: z
    .object({
      maxFiles: z.number().int().min(1).max(100),
      maxBytes: z.number().int().min(1024).max(50 * 1024 * 1024),
    })
    .optional(),
  graph: z
    .object({
      minCommunitySize: z.number().int().min(1).max(1000),
      autoUpdateOnIngest: z.boolean(),
    })
    .optional(),
  ui: z
    .object({
      language: z.enum(["ko", "en"]),
      defaultTab: z.enum(["chat", "explorer", "graph", "settings"]),
    })
    .optional(),
  auth: z
    .object({
      sessionTtlSec: z
        .number()
        .int()
        .min(60)
        .max(60 * 60 * 24 * 30)
        .nullable(),
    })
    .optional(),
});

function normalizePaths(paths: z.infer<typeof AgentPaths>) {
  return {
    codex: paths.codex?.trim() ?? "",
    claude: paths.claude?.trim() ?? "",
    gemini: paths.gemini?.trim() ?? "",
    cline: paths.cline?.trim() ?? "",
  };
}

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    return NextResponse.json(await readSettingsState());
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function PUT(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  try {
    const current = await loadConfig();
    const patch = {
      server: parsed.data.server,
      agent: parsed.data.agent
        ? {
            ...parsed.data.agent,
            paths: normalizePaths(parsed.data.agent.paths),
          }
        : undefined,
      // The existing Settings UI only sends maxFiles and maxBytes. Preserve
      // the newer ingest-protection keys (maxFilesPerInvocation and friends)
      // from the current config instead of dropping them.
      chunking: parsed.data.chunking
        ? { ...current.chunking, ...parsed.data.chunking }
        : undefined,
      graph: parsed.data.graph,
      ui: parsed.data.ui,
      auth: parsed.data.auth
        ? {
            ...current.auth,
            sessionTtlSec: parsed.data.auth.sessionTtlSec,
          }
        : undefined,
    } satisfies Partial<Config>;
    await patchLocalConfig(patch);
    return NextResponse.json(await readSettingsState());
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
