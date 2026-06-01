import { describe, expect, it } from "vitest";
import {
  buildPublicSessionEntry,
  type PublicSessionEntryArgs,
} from "./public-session-log";

/**
 * The public endpoint is unauthenticated and its session log is append-only,
 * so any secret a visitor pastes must be masked at write time — the S2 gap
 * where redactSecrets ran on the Telegram path but not the public web path.
 */

const NOW = new Date("2026-06-02T03:00:00.000Z");
const GH_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

function args(
  overrides: Partial<PublicSessionEntryArgs> = {},
): PublicSessionEntryArgs {
  return {
    visitorId: "v1",
    conversationId: "c1",
    ip: "203.0.113.7",
    userAgent: "test-agent",
    referer: null,
    question: "what is CLIO?",
    ok: true,
    ...overrides,
  };
}

function entryJson(a: PublicSessionEntryArgs): string {
  return JSON.stringify(buildPublicSessionEntry(a, NOW));
}

describe("buildPublicSessionEntry — secret masking", () => {
  it("masks a secret in the inbound message", () => {
    const json = entryJson(args({ rawMessage: `token ${GH_TOKEN}` }));
    expect(json).not.toContain(GH_TOKEN);
    expect(json).toContain("[REDACTED:github-token]");
  });

  it("masks secrets in question and answer", () => {
    const json = entryJson(
      args({ question: `rotate ${GH_TOKEN}?`, answer: `old: ${GH_TOKEN}` }),
    );
    expect(json).not.toContain(GH_TOKEN);
  });

  it("masks a secret in the error field", () => {
    const json = entryJson(
      args({ ok: false, error: `failed ${GH_TOKEN}` }),
    );
    expect(json).not.toContain(GH_TOKEN);
  });

  it("defaults message to the question when rawMessage is absent, masked", () => {
    const entry = buildPublicSessionEntry(
      args({ question: `q ${GH_TOKEN}` }),
      NOW,
    );
    const conversation = entry.conversation as { message: string };
    expect(conversation.message).not.toContain(GH_TOKEN);
  });

  it("leaves benign content and request metadata untouched", () => {
    const entry = buildPublicSessionEntry(args(), NOW);
    const conversation = entry.conversation as { message: string };
    const request = entry.request as { ip: string };
    expect(conversation.message).toBe("what is CLIO?");
    expect(request.ip).toBe("203.0.113.7");
  });

  it("keeps a null answer null", () => {
    const entry = buildPublicSessionEntry(args(), NOW);
    const conversation = entry.conversation as { answer: string | null };
    expect(conversation.answer).toBeNull();
  });
});
