import { expect, test } from "bun:test";
import { addDays, addHours, formatWhen, nowLocal } from "../src/time";

test("formats timed and all-day events", () => {
  expect(formatWhen("2026-11-26T14:00", false)).toBe("Thu, Nov 26 · 2:00 PM");
  expect(formatWhen("2026-11-26T00:30", false)).toBe("Thu, Nov 26 · 12:30 AM");
  expect(formatWhen("2026-11-26", true)).toBe("Thu, Nov 26");
});

test("date math crosses month and year boundaries", () => {
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addHours("2026-11-26T23:00", 2)).toBe("2026-11-27T01:00");
});

test("nowLocal uses the family's timezone", () => {
  expect(nowLocal("America/New_York", new Date("2026-10-26T16:00:00Z"))).toBe("2026-10-26T12:00");
});
