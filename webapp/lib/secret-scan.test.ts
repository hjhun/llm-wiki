import { describe, expect, it } from "vitest";
import { redactSecrets, summarizeFindings } from "./secret-scan";

/**
 * secret-scan is the fail-closed gate behind the wiki-answer save boundary
 * (CLAUDE.md §9). These tests pin every rule's positive match and a few
 * realistic negatives so a regex regression can never silently let a
 * credential through unmasked.
 *
 * Test fixtures are assembled from non-contiguous parts (prefix + body) on
 * purpose: a literal like `sk_live_…` in source trips GitHub push protection
 * and provider secret scanners even though it is a dummy. Concatenation keeps
 * the runtime string identical (so the regexes are exercised exactly) while
 * leaving no scannable token literal in the committed file.
 */

const FILLER = "1234567890abcdefghijklmnopqrstuvwxyz";

// Each sample is built so the contiguous secret only exists at runtime.
const SAMPLES = {
  "private-key":
    "-----BEGIN RSA PRIVATE KEY-----\n" + FILLER + "\n-----END RSA PRIVATE KEY-----",
  jwt: ["eyJ" + FILLER.slice(0, 12), "eyJ" + FILLER.slice(0, 12), FILLER.slice(0, 16)].join("."),
  "aws-access-key": "AK" + "IA" + "IOSFODNN7EXAMPLE",
  "github-token": "ghp" + "_" + FILLER + "1234",
  "google-api-key": "AIza" + "Sy" + FILLER.slice(0, 33),
  "slack-token": "xox" + "b-" + "123456789012-abcdefghij",
  "slack-webhook": "https://hooks.slack.com/services/T0/B0/" + FILLER.slice(0, 16),
  "stripe-secret-key": "sk" + "_" + "live" + "_" + FILLER.slice(0, 20),
  "openai-key": "sk" + "-" + "proj-" + FILLER.slice(0, 24),
  "bearer-token": "Authorization: Bearer " + FILLER.slice(0, 30),
} as const;

describe("redactSecrets — per-rule positive matches", () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    it(`masks ${kind}`, () => {
      const { redacted, findings } = redactSecrets(sample);
      expect(findings.some((f) => f.kind === kind)).toBe(true);
      // The raw secret material must not survive in the output. For the
      // bearer case the prefix word "Bearer" stays but the token is gone.
      if (kind === "bearer-token") {
        expect(redacted).toContain("Bearer [REDACTED:bearer-token]");
        expect(redacted).not.toContain(FILLER.slice(0, 30));
      } else {
        expect(redacted).toMatch(/\[REDACTED:[a-z-]+\]/);
        expect(redacted).not.toContain(sample);
      }
    });
  }
});

describe("redactSecrets — negatives (no false positives)", () => {
  const benign = [
    "이 문서는 비밀이 없습니다. just a normal sentence.",
    "The function returns a value of type string.",
    "version 4.8.0 and commit 0513f09 landed today",
    "email me at user@example.com about the topic", // ordinary prose
  ];
  for (const text of benign) {
    it(`leaves benign text untouched: ${text.slice(0, 24)}…`, () => {
      const { redacted, findings } = redactSecrets(text);
      expect(findings).toHaveLength(0);
      expect(redacted).toBe(text);
    });
  }
});

describe("redactSecrets — robustness", () => {
  it("masks multiple secrets in one input", () => {
    const input = `key1 ${SAMPLES["aws-access-key"]} and key2 ${SAMPLES["github-token"]}`;
    const { redacted, findings } = redactSecrets(input);
    expect(findings).toHaveLength(2);
    expect(redacted).not.toContain(SAMPLES["aws-access-key"]);
    expect(redacted).not.toContain(SAMPLES["github-token"]);
  });

  it("is idempotent — re-scanning a redacted string finds nothing new", () => {
    const once = redactSecrets(`token ${SAMPLES["github-token"]}`);
    const twice = redactSecrets(once.redacted);
    expect(twice.findings).toHaveLength(0);
    expect(twice.redacted).toBe(once.redacted);
  });

  it("returns input unchanged when there is nothing to mask", () => {
    const { redacted, findings } = redactSecrets("");
    expect(redacted).toBe("");
    expect(findings).toHaveLength(0);
  });
});

describe("summarizeFindings", () => {
  it("counts by kind in stable rule order", () => {
    const input = `${SAMPLES["aws-access-key"]} ${SAMPLES["aws-access-key"]} ${SAMPLES["github-token"]}`;
    const { findings } = redactSecrets(input);
    const summary = summarizeFindings(findings);
    expect(summary).toEqual([
      { kind: "aws-access-key", count: 2 },
      { kind: "github-token", count: 1 },
    ]);
  });

  it("returns empty for no findings", () => {
    expect(summarizeFindings([])).toEqual([]);
  });
});
