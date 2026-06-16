import { describe, expect, it } from "vitest";
import { friendlyToCron, cronToFriendly } from "./schedule-format";

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
