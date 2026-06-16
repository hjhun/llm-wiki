import { describe, expect, it } from "vitest";
import { friendlyToCron } from "./schedule-format";

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
