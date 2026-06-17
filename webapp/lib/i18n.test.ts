import { describe, expect, it } from "vitest";
import {
  appDescription,
  formatDateTime,
  formatNumber,
  isLanguage,
  localeForLanguage,
  nextLanguage,
  normalizeLanguage,
  publicClioDisabledText,
} from "./i18n";

describe("i18n utilities", () => {
  it("normalizes unknown language values to the default language", () => {
    expect(isLanguage("ko")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("ko");
    expect(normalizeLanguage(null)).toBe("ko");
    expect(nextLanguage("ko")).toBe("en");
    expect(nextLanguage("en")).toBe("ko");
  });

  it("maps supported languages to stable browser locales", () => {
    expect(localeForLanguage("ko")).toBe("ko-KR");
    expect(localeForLanguage("en")).toBe("en-US");
  });

  it("formats dates and numbers using the selected language", () => {
    const date = new Date("2026-06-17T01:23:00.000Z");

    expect(formatDateTime(date, "en")).toContain("2026");
    expect(formatDateTime(null, "ko")).toBe("—");
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "ko")).toBe("1,234,567");
  });

  it("returns localized app metadata descriptions", () => {
    expect(appDescription("ko")).toContain("개인 지식베이스");
    expect(appDescription("en")).toContain("personal knowledge base");
    expect(publicClioDisabledText("ko").title).toContain("공개");
    expect(publicClioDisabledText("en").title).toContain("Public");
  });
});
