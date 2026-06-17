/**
 * Per-role coding-agent resolution.
 *
 * The wiki can run maintenance operations (ingest, ingest-loop, lint,
 * preprocess, graph) on a different host coding-agent CLI than read-only query
 * operations (chat /query and the public /clio query). The selection lives in
 * `config.agent.roles`; each role is nullable and falls back to
 * `config.agent.default`, so the single-agent default behavior is preserved
 * when the role overrides are left empty.
 *
 * Keep the kind→role mapping here so every entry point (chat/send, auto-ingest,
 * auto-lint, public-query, graph) resolves the agent the same way.
 */
import type { Config } from "./config";
import type { CliName } from "./cli";
import type { ChatKindInput } from "./chat/send-helpers";

export type AgentRole = "maintenance" | "query";

/**
 * Map a chat operation kind to the agent role that should run it. Returns null
 * for kinds that are not role-specialized (plain `chat`); callers fall back to
 * `agent.default` in that case.
 */
export function roleForKind(kind: ChatKindInput): AgentRole | null {
  switch (kind) {
    case "ingest":
    case "ingest-loop":
    case "lint":
    case "preprocess":
    case "graph":
      return "maintenance";
    case "query":
      return "query";
    case "chat":
    default:
      return null;
  }
}

/** Resolve the CLI for a role: the role override, else `agent.default`. */
export function resolveAgentForRole(
  cfg: Config,
  role: AgentRole,
): CliName | null {
  const override = cfg.agent.roles[role] as CliName | null;
  return override ?? (cfg.agent.default as CliName | null);
}

/**
 * Resolve the CLI for a chat operation kind. Role-specialized kinds use their
 * role override (falling back to `agent.default`); other kinds use
 * `agent.default` directly.
 */
export function resolveAgentForKind(
  cfg: Config,
  kind: ChatKindInput,
): CliName | null {
  const role = roleForKind(kind);
  if (!role) return cfg.agent.default as CliName | null;
  return resolveAgentForRole(cfg, role);
}
