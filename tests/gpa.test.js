import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { gradePoints, calculateGPA, rankRetakeCandidates } = require_("../content.js");

describe("gradePoints", () => {
  it("maps KTH's official letter grades to points", () => {
    expect(gradePoints("A")).toBe(5);
    expect(gradePoints("B")).toBe(4.5);
    expect(gradePoints("C")).toBe(4);
    expect(gradePoints("D")).toBe(3.5);
    expect(gradePoints("E")).toBe(3);
    expect(gradePoints("F")).toBe(0);
    expect(gradePoints("FX")).toBe(0);
  });

  it("is case-insensitive, since Ladok's API casing isn't guaranteed", () => {
    expect(gradePoints("a")).toBe(5);
    expect(gradePoints("Fx")).toBe(0);
  });

  it("returns undefined for unrecognized or missing codes", () => {
    expect(gradePoints("P")).toBeUndefined();
    expect(gradePoints("X")).toBeUndefined();
    expect(gradePoints(null)).toBeUndefined();
    expect(gradePoints(undefined)).toBeUndefined();
    expect(gradePoints("")).toBeUndefined();
  });
});

describe("calculateGPA", () => {
  it("computes weighted and unweighted GPA from graded courses", () => {
    const courses = [
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
      { kurskod: "BBB", betyg: "C", hp: 7.5 },
    ];
    const r = calculateGPA(courses);
    // weighted: (5*7.5 + 4*7.5) / 15 = 4.5
    expect(r.weightedGPA).toBeCloseTo(4.5);
    // unweighted: (5 + 4) / 2 = 4.5
    expect(r.unweightedGPA).toBeCloseTo(4.5);
    expect(r.totalHp).toBe(15);
    expect(r.gradedCount).toBe(2);
  });

  it("weights by hp, so a heavier course pulls the average toward it", () => {
    const courses = [
      { kurskod: "AAA", betyg: "A", hp: 30 },
      { kurskod: "BBB", betyg: "F", hp: 7.5 },
    ];
    const r = calculateGPA(courses);
    // weighted: (5*30 + 0*7.5) / 37.5 = 4
    expect(r.weightedGPA).toBeCloseTo(4);
    // unweighted ignores hp entirely: (5 + 0) / 2 = 2.5
    expect(r.unweightedGPA).toBeCloseTo(2.5);
  });

  it("counts F/FX as completed courses (0 points), not as failures excluded from the average", () => {
    const r = calculateGPA([{ kurskod: "AAA", betyg: "F", hp: 7.5 }]);
    expect(r.gradedCount).toBe(1);
    expect(r.weightedGPA).toBe(0);
  });

  it("excludes Pass/Fail (P) courses from both GPA figures but counts them separately", () => {
    const r = calculateGPA([
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
      { kurskod: "BBB", betyg: "P", hp: 7.5 },
    ]);
    expect(r.gradedCount).toBe(1);
    expect(r.passCount).toBe(1);
    expect(r.totalHp).toBe(7.5);
  });

  it("excludes ongoing courses (no grade yet) from the average and tracks their hp separately", () => {
    const r = calculateGPA([
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
      { kurskod: "BBB", betyg: null, hp: 15 },
    ]);
    expect(r.gradedCount).toBe(1);
    expect(r.ongoingCount).toBe(1);
    expect(r.ongoingHp).toBe(15);
  });

  it("keeps courses whose grade fetch failed separate as errors, not as ongoing", () => {
    const r = calculateGPA([{ kurskod: "AAA", betyg: null, hp: 7.5, status: "error" }]);
    expect(r.errorCount).toBe(1);
    expect(r.ongoingCount).toBe(0);
  });

  it("surfaces an unrecognized grade code instead of silently dropping it", () => {
    const r = calculateGPA([{ kurskod: "AAA", betyg: "Z", hp: 7.5 }]);
    expect(r.unknownCount).toBe(1);
    expect(r.gradedCount).toBe(0);
  });

  it("returns null GPAs (not NaN or 0) when there are no graded courses", () => {
    const r = calculateGPA([{ kurskod: "AAA", betyg: null, hp: 7.5 }]);
    expect(r.weightedGPA).toBeNull();
    expect(r.unweightedGPA).toBeNull();
  });

  it("returns the same totalCount as the input course list length", () => {
    const courses = [
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
      { kurskod: "BBB", betyg: "P", hp: 7.5 },
      { kurskod: "CCC", betyg: null, hp: 7.5 },
    ];
    expect(calculateGPA(courses).totalCount).toBe(3);
  });
});

describe("rankRetakeCandidates", () => {
  it("ranks by potential GPA gain from retaking for an A, highest first", () => {
    const courses = [
      { kurskod: "SMALL", betyg: "B", hp: 3 },
      { kurskod: "BIG", betyg: "E", hp: 15 },
    ];
    // totalHp must reflect the overall weighted denominator, not just these two
    const ranked = rankRetakeCandidates(courses, 18);
    expect(ranked.map((r) => r.kurskod)).toEqual(["BIG", "SMALL"]);
  });

  it("excludes courses already at an A, since there's nothing to gain", () => {
    const courses = [{ kurskod: "AAA", betyg: "A", hp: 7.5 }];
    expect(rankRetakeCandidates(courses, 7.5)).toEqual([]);
  });

  it("excludes Pass/Fail and errored courses, which have no letter grade to raise", () => {
    const courses = [
      { kurskod: "PPP", betyg: "P", hp: 7.5 },
      { kurskod: "ERR", betyg: null, hp: 7.5, status: "error" },
    ];
    expect(rankRetakeCandidates(courses, 15)).toEqual([]);
  });

  it("returns an empty list when there is no GPA denominator yet", () => {
    expect(rankRetakeCandidates([{ kurskod: "AAA", betyg: "C", hp: 7.5 }], 0)).toEqual([]);
  });

  it("caps the result at 5 candidates", () => {
    const courses = Array.from({ length: 10 }, (_, i) => ({
      kurskod: `C${i}`,
      betyg: "E",
      hp: 7.5,
    }));
    expect(rankRetakeCandidates(courses, 75).length).toBe(5);
  });
});
