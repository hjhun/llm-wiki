import { describe, expect, it } from "vitest";
import { detectCallout } from "./markdown-callout";

describe("detectCallout", () => {
  it("recognizes the CLAUDE.md contradiction marker as a warning", () => {
    expect(detectCallout("⚠️ Conflicts with [[wiki/sources/bar]]: ...")).toBe(
      "warning",
    );
  });

  it("recognizes plain 'Conflicts' wording as a warning", () => {
    expect(detectCallout("Conflicts with the earlier source")).toBe("warning");
  });

  it("recognizes danger markers and keywords", () => {
    expect(detectCallout("🚨 시스템 위험")).toBe("danger");
    expect(detectCallout("Danger: do not run this")).toBe("danger");
  });

  it("recognizes info/note markers and keywords", () => {
    expect(detectCallout("ℹ️ 참고 사항")).toBe("info");
    expect(detectCallout("Note: cached for 5 minutes")).toBe("info");
    expect(detectCallout("💡 Tip")).toBe("info");
  });

  it("recognizes Korean warning keywords", () => {
    expect(detectCallout("주의: 되돌릴 수 없습니다")).toBe("warning");
  });

  it("returns null for ordinary quotes and empty input", () => {
    expect(detectCallout("As the author wrote, ...")).toBeNull();
    expect(detectCallout("   ")).toBeNull();
  });

  it("prefers danger over warning when both could match", () => {
    expect(detectCallout("⛔ 위험: 경고도 포함")).toBe("danger");
  });
});
