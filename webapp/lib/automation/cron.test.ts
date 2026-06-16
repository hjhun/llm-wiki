import { describe, expect, it } from "vitest";
import {
  computeNextAutomationFire,
  nextCronFires,
  validateCronExpression,
} from "./cron";

type Schedule = Parameters<typeof computeNextAutomationFire>[1];

function schedule(over: Partial<Schedule>): Schedule {
  return {
    mode: "cron",
    preset: "daily",
    cron: "0 9 * * *",
    time: { hour: 9, minute: 0 },
    dayOfWeek: 1,
    dayOfMonth: 1,
    timezone: "",
    ...over,
  } as Schedule;
}

describe("nextCronFires", () => {
  it("returns the next N distinct fire times in order", () => {
    const from = new Date("2026-06-16T08:00:00");
    const fires = nextCronFires("0 9 * * *", 3, from); // daily 09:00
    expect(fires).toHaveLength(3);
    expect(fires[0].toISOString()).toBe(new Date("2026-06-16T09:00:00").toISOString());
    expect(fires[1].toISOString()).toBe(new Date("2026-06-17T09:00:00").toISOString());
    expect(fires[2].toISOString()).toBe(new Date("2026-06-18T09:00:00").toISOString());
  });
  it("returns an empty array for an invalid cron", () => {
    expect(nextCronFires("not a cron", 3)).toEqual([]);
  });
});

describe("step (*/N) expressions", () => {
  it("accepts a */N minute step", () => {
    expect(validateCronExpression("*/10 * * * *")).toBeNull();
  });
  it("accepts a */N hour step", () => {
    expect(validateCronExpression("30 */2 * * *")).toBeNull();
  });
  it("computes fire times for a */N minute step", () => {
    const from = new Date("2026-06-16T08:03:00");
    const fires = nextCronFires("*/10 * * * *", 3, from);
    const hm = fires.map(
      (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`,
    );
    expect(hm).toEqual(["8:10", "8:20", "8:30"]);
  });
});

describe("timezone-aware scheduling", () => {
  // Absolute UTC instant so assertions do not depend on the host timezone.
  const from = new Date("2026-06-15T20:00:00Z"); // 05:00 KST / 16:00 EDT

  it("fires a daily cron at the wall-clock time of the target zone", () => {
    // 09:00 Asia/Seoul (UTC+9) on 2026-06-16 == 00:00Z.
    expect(
      nextCronFires("0 9 * * *", 1, from, "Asia/Seoul")[0].toISOString(),
    ).toBe("2026-06-16T00:00:00.000Z");
    // 09:00 America/New_York (EDT, UTC-4 in June) == 13:00Z.
    expect(
      nextCronFires("0 9 * * *", 1, from, "America/New_York")[0].toISOString(),
    ).toBe("2026-06-16T13:00:00.000Z");
  });

  it("treats whole-hour interval crons as timezone-independent", () => {
    const seoul = nextCronFires("*/10 * * * *", 3, from, "Asia/Seoul");
    const ny = nextCronFires("*/10 * * * *", 3, from, "America/New_York");
    expect(seoul.map((d) => d.toISOString())).toEqual(
      ny.map((d) => d.toISOString()),
    );
  });

  it("computeNextAutomationFire honors schedule.timezone for cron mode", () => {
    expect(
      computeNextAutomationFire(
        from,
        schedule({ mode: "cron", cron: "0 9 * * *", timezone: "America/New_York" }),
      ).toISOString(),
    ).toBe("2026-06-16T13:00:00.000Z");
  });

  it("computeNextAutomationFire honors schedule.timezone for preset mode", () => {
    expect(
      computeNextAutomationFire(
        from,
        schedule({
          mode: "preset",
          preset: "daily",
          time: { hour: 9, minute: 0 },
          timezone: "America/New_York",
        }),
      ).toISOString(),
    ).toBe("2026-06-16T13:00:00.000Z");
  });

  it("falls back to a different zone giving a different instant", () => {
    const seoul = computeNextAutomationFire(
      from,
      schedule({ cron: "0 9 * * *", timezone: "Asia/Seoul" }),
    ).toISOString();
    const ny = computeNextAutomationFire(
      from,
      schedule({ cron: "0 9 * * *", timezone: "America/New_York" }),
    ).toISOString();
    expect(seoul).not.toBe(ny);
  });
});
