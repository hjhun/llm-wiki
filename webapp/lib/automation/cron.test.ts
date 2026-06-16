import { describe, expect, it } from "vitest";
import { nextCronFires } from "./cron";

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
