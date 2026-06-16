import { describe, expect, it } from "vitest";
import { nextCronFires, validateCronExpression } from "./cron";

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
