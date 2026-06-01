import { describe, expect, it } from "vitest";
import {
  buildTelegramSessionEntry,
  type TelegramSessionLogInput,
} from "./session-log";

/**
 * The session audit trail under `sessions/` is append-only, so any secret a
 * user pastes into Telegram must be masked at write time — this is the P1
 * gap where `redactSecrets` previously only ran at the wiki/answers save
 * boundary. These tests pin that the persisted entry never carries raw
 * credential material in any free-text field.
 */

const NOW = new Date("2026-06-01T03:00:00.000Z");
const GH_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

function baseInput(
  overrides: Partial<TelegramSessionLogInput> = {},
): TelegramSessionLogInput {
  return {
    chatId: 100,
    chatKind: "private",
    chatLabel: "tester",
    kind: "query",
    rawMessage: "hello",
    ok: true,
    ...overrides,
  };
}

function entryJson(input: TelegramSessionLogInput): string {
  return JSON.stringify(buildTelegramSessionEntry(input, NOW));
}

describe("buildTelegramSessionEntry — secret masking", () => {
  it("masks a secret in the inbound message", () => {
    const json = entryJson(
      baseInput({ rawMessage: `my token is ${GH_TOKEN}` }),
    );
    expect(json).not.toContain(GH_TOKEN);
    expect(json).toContain("[REDACTED:github-token]");
  });

  it("masks secrets in question and answer fields", () => {
    const json = entryJson(
      baseInput({
        question: `rotate ${GH_TOKEN}?`,
        answer: `sure, the old one was ${GH_TOKEN}`,
      }),
    );
    expect(json).not.toContain(GH_TOKEN);
  });

  it("masks a secret that leaks into the error field", () => {
    const json = entryJson(
      baseInput({ ok: false, error: `failed with key ${GH_TOKEN}` }),
    );
    expect(json).not.toContain(GH_TOKEN);
  });

  it("leaves benign content untouched", () => {
    const entry = buildTelegramSessionEntry(
      baseInput({ rawMessage: "what is CLIO?" }),
      NOW,
    );
    const conversation = entry.conversation as { message: string };
    expect(conversation.message).toBe("what is CLIO?");
  });

  it("preserves null free-text fields as null", () => {
    const entry = buildTelegramSessionEntry(baseInput(), NOW);
    const conversation = entry.conversation as {
      question: string | null;
      answer: string | null;
    };
    expect(conversation.question).toBeNull();
    expect(conversation.answer).toBeNull();
  });
});
