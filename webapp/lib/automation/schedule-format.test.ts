import { describe, expect, it } from "vitest";
import { friendlyToCron, cronToFriendly, describeCron, validateFriendly } from "./schedule-format";

describe("friendlyToCron", () => {
  it("every N minutes", () => {
    expect(friendlyToCron({ kind: "minutes", intervalMinutes: 10 })).toBe("*/10 * * * *");
  });
  it("hourly with interval 1 omits the step", () => {
    expect(friendlyToCron({ kind: "hourly", intervalHours: 1, minute: 30 })).toBe("30 * * * *");
  });
  it("hourly with interval N", () => {
    expect(friendlyToCron({ kind: "hourly", intervalHours: 2, minute: 30 })).toBe("30 */2 * * *");
  });
  it("daily", () => {
    expect(friendlyToCron({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
  });
  it("weekly sorts and joins weekdays", () => {
    expect(
      friendlyToCron({ kind: "weekly", hour: 9, minute: 0, weekdays: [4, 1] }),
    ).toBe("0 9 * * 1,4");
  });
  it("monthly", () => {
    expect(
      friendlyToCron({ kind: "monthly", hour: 9, minute: 0, dayOfMonth: 15 }),
    ).toBe("0 9 15 * *");
  });
  it("advanced passes the raw cron through trimmed", () => {
    expect(friendlyToCron({ kind: "advanced", cron: "  0 9 * * 1-5 " })).toBe("0 9 * * 1-5");
  });
});

describe("cronToFriendly", () => {
  it("parses every N minutes", () => {
    expect(cronToFriendly("*/10 * * * *")).toEqual({ kind: "minutes", intervalMinutes: 10 });
  });
  it("parses hourly (no step) as interval 1", () => {
    expect(cronToFriendly("30 * * * *")).toEqual({ kind: "hourly", intervalHours: 1, minute: 30 });
  });
  it("parses hourly with step", () => {
    expect(cronToFriendly("30 */2 * * *")).toEqual({ kind: "hourly", intervalHours: 2, minute: 30 });
  });
  it("parses daily", () => {
    expect(cronToFriendly("0 9 * * *")).toEqual({ kind: "daily", minute: 0, hour: 9 });
  });
  it("parses weekly with multiple days, sorted", () => {
    expect(cronToFriendly("0 9 * * 4,1")).toEqual({
      kind: "weekly", minute: 0, hour: 9, weekdays: [1, 4],
    });
  });
  it("parses monthly", () => {
    expect(cronToFriendly("0 9 15 * *")).toEqual({
      kind: "monthly", minute: 0, hour: 9, dayOfMonth: 15,
    });
  });
  it("falls back to advanced for ranges/unmatched", () => {
    expect(cronToFriendly("0 9 * * 1-5")).toEqual({ kind: "advanced", cron: "0 9 * * 1-5" });
    expect(cronToFriendly("bogus")).toEqual({ kind: "advanced", cron: "bogus" });
  });
  it("round-trips friendly -> cron -> friendly", () => {
    const cases = ["*/10 * * * *", "30 * * * *", "30 */2 * * *", "0 9 * * *", "0 9 * * 1,4", "0 9 15 * *"];
    for (const c of cases) expect(friendlyToCron(cronToFriendly(c))).toBe(c);
  });
});

describe("describeCron", () => {
  it("describes known kinds in Korean", () => {
    expect(describeCron("*/10 * * * *")).toBe("10분마다");
    expect(describeCron("30 * * * *")).toBe("매시간 30분");
    expect(describeCron("0 9 * * *")).toBe("매일 09:00");
    expect(describeCron("0 9 * * 1,4")).toBe("매주 월·목 09:00");
    expect(describeCron("0 9 15 * *")).toBe("매월 15일 09:00");
  });
  it("describes advanced as 사용자 지정", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("사용자 지정 (0 9 * * 1-5)");
  });
});

describe("validateFriendly", () => {
  it("ok for a normal minutes divisor", () => {
    expect(validateFriendly({ kind: "minutes", intervalMinutes: 10 })).toEqual({ error: null, warning: null });
  });
  it("warns (not errors) for a non-divisor minute interval", () => {
    const v = validateFriendly({ kind: "minutes", intervalMinutes: 7 });
    expect(v.error).toBeNull();
    expect(v.warning).toContain("60");
  });
  it("errors for out-of-range minute interval", () => {
    expect(validateFriendly({ kind: "minutes", intervalMinutes: 0 }).error).not.toBeNull();
  });
  it("errors when weekly has no weekdays", () => {
    expect(validateFriendly({ kind: "weekly", hour: 9, minute: 0, weekdays: [] }).error).not.toBeNull();
  });
  it("errors for monthly day out of 1–28", () => {
    expect(validateFriendly({ kind: "monthly", hour: 9, minute: 0, dayOfMonth: 30 }).error).not.toBeNull();
  });
  it("delegates advanced to cron validation", () => {
    expect(validateFriendly({ kind: "advanced", cron: "0 9 * * *" }).error).toBeNull();
    expect(validateFriendly({ kind: "advanced", cron: "nope" }).error).not.toBeNull();
  });
});
