import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import { classifyIncoming } from "./router";
import type { TelegramMessage } from "./types";

/**
 * Router classification is the access-control boundary for the bot: it
 * decides which chats are answered, which are rejected, and which commands
 * are privileged. These tests pin the security-relevant branches so a
 * refactor can't silently widen who the bot talks to.
 */

type TgConfig = Config["telegram"];

function makeConfig(overrides: Partial<TgConfig> = {}): TgConfig {
  return {
    enabled: true,
    notifyOnIngest: true,
    botToken: "test-token",
    mode: "polling",
    webhookPublicUrl: null,
    webhookSecret: null,
    allowlist: [],
    pending: [],
    rejectionMessage: "not approved",
    historyTurns: 6,
    replyMaxChars: 3500,
    allowExternalLookup: false,
    ...overrides,
  };
}

function approved(
  chatId: number,
  permission: "query" | "trusted" = "query",
): TgConfig["allowlist"][number] {
  return {
    chatId,
    kind: "private",
    label: "test",
    permission,
    approvedAt: "2026-06-01",
  };
}

function msg(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 100, type: "private" },
    date: 0,
    text: "hello",
    ...overrides,
  };
}

describe("classifyIncoming — access control", () => {
  it("rejects an unapproved private chat and records it pending", () => {
    const action = classifyIncoming(makeConfig(), msg({ text: "question?" }));
    expect(action.kind).toBe("reject");
    if (action.kind === "reject") {
      expect(action.text).toBe("not approved");
      expect(action.recordPending).toBe(true);
    }
  });

  it("does not re-record a chat that is already pending", () => {
    const cfg = makeConfig({
      pending: [
        {
          chatId: 100,
          kind: "private",
          label: "",
          firstSeenAt: "2026-06-01",
          lastMessagePreview: "",
        },
      ],
    });
    const action = classifyIncoming(cfg, msg({ text: "again?" }));
    expect(action.kind).toBe("reject");
    if (action.kind === "reject") expect(action.recordPending).toBe(false);
  });

  it("routes an approved chat's plain text to a query", () => {
    const cfg = makeConfig({ allowlist: [approved(100)] });
    const action = classifyIncoming(cfg, msg({ text: "what is CLIO?" }));
    expect(action.kind).toBe("query");
    if (action.kind === "query") {
      expect(action.question).toBe("what is CLIO?");
      expect(action.permission).toBe("query");
      expect(action.saveToWiki).toBe(false);
    }
  });

  it("answers /whoami even for an unapproved chat (so users can self-identify)", () => {
    const action = classifyIncoming(makeConfig(), msg({ text: "/whoami" }));
    expect(action.kind).toBe("whoami");
    if (action.kind === "whoami") expect(action.text).toContain("chat id: 100");
  });
});

describe("classifyIncoming — group gating", () => {
  const groupMsg = (text: string) =>
    msg({ chat: { id: 200, type: "group" }, text });

  it("ignores a group message with no mention and no slash command", () => {
    const cfg = makeConfig({ allowlist: [approved(200)] });
    const action = classifyIncoming(cfg, groupMsg("just chatting"), "cliobot");
    expect(action.kind).toBe("ignore");
  });

  it("responds to a group message that @mentions the bot", () => {
    const cfg = makeConfig({ allowlist: [approved(200)] });
    const action = classifyIncoming(
      cfg,
      groupMsg("@cliobot what is CLIO?"),
      "cliobot",
    );
    expect(action.kind).toBe("query");
    if (action.kind === "query") expect(action.question).toBe("what is CLIO?");
  });

  it("strips the @botusername suffix Telegram appends to group slash commands", () => {
    const cfg = makeConfig({ allowlist: [approved(200)] });
    const action = classifyIncoming(cfg, groupMsg("/help@cliobot"), "cliobot");
    expect(action.kind).toBe("static-help");
  });
});

describe("classifyIncoming — --save privilege", () => {
  it("blocks --save from a query-only chat", () => {
    const cfg = makeConfig({ allowlist: [approved(100, "query")] });
    const action = classifyIncoming(
      cfg,
      msg({ text: "/query --save remember this" }),
    );
    expect(action.kind).toBe("static-help");
    if (action.kind === "static-help") expect(action.text).toContain("trusted");
  });

  it("allows --save from a trusted chat", () => {
    const cfg = makeConfig({ allowlist: [approved(100, "trusted")] });
    const action = classifyIncoming(
      cfg,
      msg({ text: "/query --save remember this" }),
    );
    expect(action.kind).toBe("query");
    if (action.kind === "query") {
      expect(action.saveToWiki).toBe(true);
      expect(action.question).toBe("remember this");
    }
  });

  it("rejects an unknown slash command with help text", () => {
    const cfg = makeConfig({ allowlist: [approved(100)] });
    const action = classifyIncoming(cfg, msg({ text: "/delete everything" }));
    expect(action.kind).toBe("static-help");
    if (action.kind === "static-help")
      expect(action.text).toContain("지원되지 않습니다");
  });
});

describe("classifyIncoming — non-text", () => {
  it("acks a photo-only message without trying to ingest it", () => {
    const cfg = makeConfig({ allowlist: [approved(100)] });
    const action = classifyIncoming(
      cfg,
      msg({ text: undefined, photo: [{}] }),
    );
    expect(action.kind).toBe("non-text");
  });
});
