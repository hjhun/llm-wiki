import { describe, expect, it } from "vitest";
import { publicQueryAccessAllowed } from "./public-access";

describe("publicQueryAccessAllowed", () => {
  it("allows everything when no passphrase is configured", () => {
    expect(publicQueryAccessAllowed(null, undefined)).toBe(true);
    expect(publicQueryAccessAllowed(null, "anything")).toBe(true);
    expect(publicQueryAccessAllowed("", "anything")).toBe(true);
  });

  it("requires a matching passphrase when one is configured", () => {
    expect(publicQueryAccessAllowed("s3cret", "s3cret")).toBe(true);
    expect(publicQueryAccessAllowed("s3cret", "wrong")).toBe(false);
  });

  it("rejects missing or empty provided values when a passphrase is set", () => {
    expect(publicQueryAccessAllowed("s3cret", undefined)).toBe(false);
    expect(publicQueryAccessAllowed("s3cret", null)).toBe(false);
    expect(publicQueryAccessAllowed("s3cret", "")).toBe(false);
  });

  it("rejects a value that only shares a prefix (length mismatch)", () => {
    expect(publicQueryAccessAllowed("s3cret", "s3c")).toBe(false);
    expect(publicQueryAccessAllowed("s3cret", "s3cretXYZ")).toBe(false);
  });

  it("handles unicode passphrases", () => {
    expect(publicQueryAccessAllowed("비밀번호", "비밀번호")).toBe(true);
    expect(publicQueryAccessAllowed("비밀번호", "비밀")).toBe(false);
  });
});
