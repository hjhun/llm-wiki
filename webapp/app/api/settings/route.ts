import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig, type Config } from "@/lib/config";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { readSettingsState, invalidateDetectionCache } from "@/lib/settings";
import { getAutoIngestManager } from "@/lib/auto-ingest/manager";
import { getAutoLintManager } from "@/lib/auto-lint/manager";

export const dynamic = "force-dynamic";

const AgentPaths = z.object({
  codex: z.string().optional(),
  claude: z.string().optional(),
  agy: z.string().optional(),
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
      default: z.enum(["codex", "claude", "agy", "cline"]).nullable(),
      safeMode: z.boolean(),
      paths: AgentPaths,
      roles: z.object({
        maintenance: z.enum(["codex", "claude", "agy", "cline"]).nullable(),
        query: z.enum(["codex", "claude", "agy", "cline"]).nullable(),
      }),
    })
    .optional(),
  cli: z
    .object({
      streamTokens: z.boolean(),
      ingestLoop: z
        .object({
          maxStagnantRounds: z.number().int().min(1).max(1000),
          resumeSessions: z.boolean().optional(),
        })
        .optional(),
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
      extraction: z
        .object({
          primaryNodeModel: z.enum(["page-title"]).optional(),
          profile: z.enum(["wiki", "code", "deep"]).optional(),
          scope: z.enum(["wiki", "wiki+raw"]).optional(),
          maxNodesPerLeaf: z.number().int().min(1).max(100_000).optional(),
          maxConceptsPerSource: z.number().int().min(1).max(10_000).optional(),
          minConfidence: z.number().min(0).max(1).optional(),
          includeRationaleNodes: z.boolean().optional(),
          includeSemanticSimilarity: z.boolean().optional(),
          includeHyperedges: z.boolean().optional(),
          dropIsolatedDerivedNodes: z.boolean().optional(),
          proseEdges: z.enum(["explicit", "explicit+semantic"]).optional(),
          facetEdges: z.boolean().optional(),
          semanticMinConfidence: z.number().min(0).max(1).optional(),
          codeModel: z.enum(["per-project-graphify-out"]).optional(),
          projectsDir: z.string().optional(),
          projectAnalysisDir: z.string().optional(),
        })
        .optional(),
      autoUpdateOnIngest: z.boolean(),
      autoUpdateStrategy: z
        .enum(["auto", "finalOnly", "partialAndFinal"])
        .optional(),
      partialThresholds: z
        .object({
          minLeaves: z.number().int().min(1).max(10_000).optional(),
          minFiles: z.number().int().min(1).max(1_000_000).optional(),
          minBytes: z.number().int().min(1).max(1024 * 1024 * 1024).optional(),
          minSubChunks: z.number().int().min(1).max(1_000_000).optional(),
        })
        .optional(),
    })
    .optional(),
  search: z
    .object({
      qmd: z.object({
        enabled: z.boolean(),
        autoUpdateOnWikiChange: z.boolean(),
        scope: z.enum(["wiki", "wiki+raw"]),
        defaultNoRerank: z.boolean(),
        embedEnabled: z.boolean(),
      }),
    })
    .optional(),
  ui: z
    .object({
      language: z.enum(SUPPORTED_LANGUAGES),
      theme: z.enum(["default", "light", "dark"]),
      appSubtitle: z.string().max(80).optional(),
      defaultTab: z.enum(["chat", "explorer", "graph", "automations", "settings"]),
      agentEdgePanelEnabled: z.boolean(),
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
  publicQuery: z
    .object({
      enabled: z.boolean(),
      allowExternalLookup: z.boolean(),
      sandboxEnabled: z.boolean(),
      sandboxReadOnlyHomePaths: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  autoIngest: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(["watch", "schedule"]),
      watch: z.object({
        debounceMs: z.number().int().min(1000).max(60_000),
      }),
      schedule: z.object({
        intervalMinutes: z.number().int().min(1).max(1440),
      }),
      skipIfBusy: z.boolean(),
    })
    .optional(),
  autoLint: z
    .object({
      enabled: z.boolean(),
      counter: z.object({
        threshold: z.number().int().min(1).max(1000),
      }),
      cron: z.object({
        enabled: z.boolean(),
        preset: z.enum(["daily", "weekly", "monthly"]),
        time: z.object({
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
        }),
        dayOfWeek: z.number().int().min(0).max(6),
        dayOfMonth: z.number().int().min(1).max(28),
      }),
      fix: z.boolean(),
      skipIfBusy: z.boolean(),
    })
    .optional(),
});

function normalizePaths(paths: z.infer<typeof AgentPaths>) {
  return {
    codex: paths.codex?.trim() ?? "",
    claude: paths.claude?.trim() ?? "",
    agy: paths.agy?.trim() ?? "",
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
      graph: parsed.data.graph
        ? {
            ...current.graph,
            ...parsed.data.graph,
            extraction: {
              ...current.graph.extraction,
              ...parsed.data.graph.extraction,
            },
            partialThresholds: {
              ...current.graph.partialThresholds,
              ...parsed.data.graph.partialThresholds,
            },
          }
        : undefined,
      search: parsed.data.search
        ? {
            ...current.search,
            qmd: {
              ...current.search.qmd,
              ...parsed.data.search.qmd,
            },
          }
        : undefined,
      ui: parsed.data.ui
        ? {
            ...current.ui,
            ...parsed.data.ui,
            appSubtitle:
              parsed.data.ui.appSubtitle == null
                ? current.ui.appSubtitle
                : parsed.data.ui.appSubtitle.trim(),
          }
        : undefined,
      auth: parsed.data.auth
        ? {
            ...current.auth,
            sessionTtlSec: parsed.data.auth.sessionTtlSec,
          }
        : undefined,
      publicQuery: parsed.data.publicQuery
        ? {
            ...current.publicQuery,
            ...parsed.data.publicQuery,
          }
        : undefined,
      cli: parsed.data.cli
        ? {
            ...current.cli,
            streamTokens: parsed.data.cli.streamTokens,
            ingestLoop: {
              ...current.cli.ingestLoop,
              ...(parsed.data.cli.ingestLoop ?? {}),
            },
          }
        : undefined,
      autoIngest: parsed.data.autoIngest,
      autoLint: parsed.data.autoLint,
    } satisfies Partial<Config>;
    await patchLocalConfig(patch);
    // Agent paths can change which binaries resolve; drop the detection cache
    // so the response reflects the new config rather than a stale probe.
    invalidateDetectionCache();
    if (parsed.data.autoIngest) {
      // Rebooting the watcher/scheduler is cheap; do it whenever the user
      // touches auto-ingest so the new mode / debounce / interval takes
      // effect immediately without a server restart.
      await getAutoIngestManager().restart();
    }
    if (parsed.data.autoLint) {
      await getAutoLintManager().restart();
    }
    return NextResponse.json(await readSettingsState());
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
