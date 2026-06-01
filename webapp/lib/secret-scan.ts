/**
 * Deterministic high-confidence secret scanner used as a fail-closed gate at
 * the wiki-answer save boundary. This is the code-enforced second layer behind
 * wiki-query's prompt-level guidance (public-query.ts): even if the LLM misses
 * a credential, an obvious secret must never be written into wiki/answers/.
 *
 * Scope decision: high-confidence patterns only (fixed prefixes / structural
 * markers). Entropy-based and generic key=value heuristics are intentionally
 * excluded to keep false positives near zero — masking a legitimate answer is
 * a worse failure mode here than missing a low-signal secret, which the LLM
 * layer is still asked to catch. See CLAUDE.md §9.
 *
 * Findings never carry the matched secret material: only the rule `kind` is
 * recorded, so downstream lint reports cannot themselves leak the value.
 */

export type SecretKind =
  | "private-key"
  | "jwt"
  | "aws-access-key"
  | "github-token"
  | "google-api-key"
  | "slack-token"
  | "slack-webhook"
  | "stripe-secret-key"
  | "openai-key"
  | "bearer-token";

export type SecretFinding = {
  kind: SecretKind;
};

type SecretRule = {
  kind: SecretKind;
  /** Must be a global (`g`) regex so all matches are replaced. */
  re: RegExp;
  /**
   * Optional custom replacement. Receives the full match and capture groups;
   * returns the redacted string. Defaults to `[REDACTED:<kind>]`. Used by the
   * bearer rule to preserve the `Bearer ` prefix while masking the token.
   */
  redact?: (match: string, ...groups: string[]) => string;
};

const placeholder = (kind: SecretKind): string => `[REDACTED:${kind}]`;

/**
 * Order matters: multiline blocks and structured tokens are matched before
 * narrower prefix rules so a later rule never bites into an already-inserted
 * placeholder. The `[REDACTED:...]` placeholder contains no secret-shaped
 * substring, so re-matching is not a concern in practice.
 */
const RULES: SecretRule[] = [
  {
    kind: "private-key",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    kind: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]+/g,
  },
  {
    kind: "stripe-secret-key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    kind: "openai-key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "bearer-token",
    re: /\b(Bearer)\s+([A-Za-z0-9._-]{20,})/g,
    redact: (_match, prefix) => `${prefix} [REDACTED:bearer-token]`,
  },
];

export type RedactResult = {
  /** Input with every detected secret replaced by a `[REDACTED:<kind>]` tag. */
  redacted: string;
  /** One entry per replaced secret. Carries only the rule kind. */
  findings: SecretFinding[];
};

/**
 * Replace every high-confidence secret in `input` with a redaction tag.
 * Pure function — safe to call on any user/LLM-produced text before persisting.
 */
export function redactSecrets(input: string): RedactResult {
  const findings: SecretFinding[] = [];
  let text = input;
  for (const rule of RULES) {
    // Reset lastIndex defensively; these literals are not shared across calls
    // but re-running on the same RegExp object requires a clean index.
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (match: string, ...rest: unknown[]) => {
      findings.push({ kind: rule.kind });
      if (rule.redact) {
        const groups = rest.filter((g): g is string => typeof g === "string");
        return rule.redact(match, ...groups);
      }
      return placeholder(rule.kind);
    });
  }
  return { redacted: text, findings };
}

/**
 * Aggregate findings into `kind -> count`, preserving rule order for stable
 * lint output.
 */
export function summarizeFindings(
  findings: SecretFinding[],
): Array<{ kind: SecretKind; count: number }> {
  const counts = new Map<SecretKind, number>();
  for (const f of findings) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  return RULES.filter((r) => counts.has(r.kind)).map((r) => ({
    kind: r.kind,
    count: counts.get(r.kind) as number,
  }));
}
