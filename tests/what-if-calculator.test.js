import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { currentGradeLabel, applyWhatIfOverrides, calculateGPA } = require_("../content.js");

describe("currentGradeLabel", () => {
  it("returns the grade itself when one exists, letter or Pass", () => {
    expect(currentGradeLabel({ betyg: "C" })).toBe("C");
    expect(currentGradeLabel({ betyg: "P" })).toBe("P");
  });

  it("returns 'pågående' for a course with no grade yet", () => {
    expect(currentGradeLabel({ betyg: null })).toBe("pågående");
  });

  it("returns 'kunde inte hämtas' for a course whose grade fetch failed, even if betyg is set", () => {
    expect(currentGradeLabel({ betyg: null, status: "error" })).toBe("kunde inte hämtas");
  });
});

describe("applyWhatIfOverrides", () => {
  const courses = [
    { kurskod: "AAA", betyg: "C", hp: 7.5 },
    { kurskod: "BBB", betyg: null, hp: 15 }, // ongoing
    { kurskod: "CCC", betyg: null, hp: 7.5, status: "error" },
  ];

  it("replaces the grade of the matching course only", () => {
    const result = applyWhatIfOverrides(courses, [{ kurskod: "AAA", betyg: "A" }]);
    expect(result.find((c) => c.kurskod === "AAA").betyg).toBe("A");
    expect(result.find((c) => c.kurskod === "BBB").betyg).toBeNull();
  });

  it("applies a hypothetical grade to an ongoing course", () => {
    const result = applyWhatIfOverrides(courses, [{ kurskod: "BBB", betyg: "B" }]);
    expect(result.find((c) => c.kurskod === "BBB").betyg).toBe("B");
  });

  it("clears a fetch-error status when overriding that course, so it counts toward the GPA", () => {
    const result = applyWhatIfOverrides(courses, [{ kurskod: "CCC", betyg: "A" }]);
    const overridden = result.find((c) => c.kurskod === "CCC");
    expect(overridden.betyg).toBe("A");
    expect(overridden.status).toBeNull();
  });

  it("applies multiple overrides at once", () => {
    const result = applyWhatIfOverrides(courses, [
      { kurskod: "AAA", betyg: "A" },
      { kurskod: "BBB", betyg: "A" },
    ]);
    expect(result.find((c) => c.kurskod === "AAA").betyg).toBe("A");
    expect(result.find((c) => c.kurskod === "BBB").betyg).toBe("A");
  });

  it("ignores incomplete override entries (missing kurskod or betyg)", () => {
    const result = applyWhatIfOverrides(courses, [{ kurskod: "AAA", betyg: null }, { kurskod: null, betyg: "A" }]);
    expect(result).toEqual(courses);
  });

  it("returns the original array reference when there are no valid overrides", () => {
    expect(applyWhatIfOverrides(courses, [])).toBe(courses);
    expect(applyWhatIfOverrides(courses, undefined)).toBe(courses);
  });

  it("never mutates the input course objects", () => {
    const original = { kurskod: "AAA", betyg: "C", hp: 7.5 };
    applyWhatIfOverrides([original], [{ kurskod: "AAA", betyg: "A" }]);
    expect(original.betyg).toBe("C");
  });

  it("feeds cleanly into calculateGPA to project a resulting GPA", () => {
    const hypothetical = applyWhatIfOverrides(courses, [
      { kurskod: "BBB", betyg: "A" },
      { kurskod: "CCC", betyg: "A" },
    ]);
    const result = calculateGPA(hypothetical);
    // AAA=C(4)*7.5 + BBB=A(5)*15 + CCC=A(5)*7.5, over 30 hp
    expect(result.weightedGPA).toBeCloseTo((4 * 7.5 + 5 * 15 + 5 * 7.5) / 30);
    expect(result.ongoingCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });
});
