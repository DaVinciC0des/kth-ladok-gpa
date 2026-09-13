import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { dateKeyForDate, upsertHistoryEntry, sparklinePoints } = require_("../content.js");

describe("dateKeyForDate", () => {
  it("formats a date as YYYY-MM-DD in local time", () => {
    expect(dateKeyForDate(new Date(2026, 8, 13))).toBe("2026-09-13"); // month is 0-indexed
  });

  it("zero-pads single-digit months and days", () => {
    expect(dateKeyForDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("upsertHistoryEntry", () => {
  it("appends a new entry for a new date", () => {
    const entries = [{ date: "2026-09-01", weightedGPA: 4.0 }];
    const updated = upsertHistoryEntry(entries, "2026-09-02", { weightedGPA: 4.2 });
    expect(updated).toEqual([
      { date: "2026-09-01", weightedGPA: 4.0 },
      { date: "2026-09-02", weightedGPA: 4.2 },
    ]);
  });

  it("replaces the existing entry for the same date rather than duplicating it", () => {
    const entries = [{ date: "2026-09-01", weightedGPA: 4.0 }];
    const updated = upsertHistoryEntry(entries, "2026-09-01", { weightedGPA: 4.3 });
    expect(updated).toEqual([{ date: "2026-09-01", weightedGPA: 4.3 }]);
  });

  it("keeps the result sorted by date regardless of insertion order", () => {
    const entries = [
      { date: "2026-09-05", weightedGPA: 4.1 },
      { date: "2026-09-01", weightedGPA: 4.0 },
    ];
    const updated = upsertHistoryEntry(entries, "2026-09-03", { weightedGPA: 4.05 });
    expect(updated.map((e) => e.date)).toEqual(["2026-09-01", "2026-09-03", "2026-09-05"]);
  });

  it("never mutates the input array", () => {
    const entries = [{ date: "2026-09-01", weightedGPA: 4.0 }];
    upsertHistoryEntry(entries, "2026-09-02", { weightedGPA: 4.2 });
    expect(entries.length).toBe(1);
  });

  it("caps the result at 365 entries, dropping the oldest", () => {
    const entries = Array.from({ length: 365 }, (_, i) => ({
      date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      weightedGPA: 4.0,
    })).sort((a, b) => a.date.localeCompare(b.date));
    const updated = upsertHistoryEntry(entries, "2099-01-01", { weightedGPA: 4.5 });
    expect(updated.length).toBe(365);
    expect(updated[updated.length - 1].date).toBe("2099-01-01");
  });
});

describe("sparklinePoints", () => {
  it("returns one centered point for a single value", () => {
    expect(sparklinePoints([4.0], 100, 50)).toEqual([[50, 25]]);
  });

  it("returns an empty list for no values", () => {
    expect(sparklinePoints([], 100, 50)).toEqual([]);
  });

  it("maps the lowest value to the bottom and the highest to the top", () => {
    const points = sparklinePoints([3.0, 5.0], 100, 50, 0);
    const [, lowY] = points[0];
    const [, highY] = points[1];
    expect(highY).toBeLessThan(lowY); // SVG y grows downward, so a higher value has a smaller y
  });

  it("spreads x coordinates evenly from 0 to width", () => {
    const points = sparklinePoints([1, 2, 3], 100, 50, 0);
    expect(points.map(([x]) => x)).toEqual([0, 50, 100]);
  });

  it("doesn't divide by zero when every value is identical", () => {
    const points = sparklinePoints([4.0, 4.0, 4.0], 100, 50);
    expect(points.every(([, y]) => Number.isFinite(y))).toBe(true);
  });
});
