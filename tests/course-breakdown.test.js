import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { buildCourseBreakdown, describeBreakdownItem, calculateGPA } = require_("../content.js");

describe("buildCourseBreakdown", () => {
  it("computes each graded course's share of the weighted GPA, summing to the whole", () => {
    const courses = [
      { kurskod: "BBB", betyg: "C", hp: 7.5 },
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
    ];
    const { totalHp, weightedGPA } = calculateGPA(courses);
    const breakdown = buildCourseBreakdown(courses, totalHp);

    const contributions = breakdown.map((c) => c.contribution);
    const sum = contributions.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(weightedGPA);
  });

  it("sorts entries by course code", () => {
    const courses = [
      { kurskod: "ZZZ", betyg: "A", hp: 7.5 },
      { kurskod: "AAA", betyg: "A", hp: 7.5 },
    ];
    const breakdown = buildCourseBreakdown(courses, 15);
    expect(breakdown.map((c) => c.kurskod)).toEqual(["AAA", "ZZZ"]);
  });

  it("classifies Pass/Fail courses as 'pass' with no contribution", () => {
    const breakdown = buildCourseBreakdown([{ kurskod: "AAA", betyg: "P", hp: 7.5 }], 0);
    expect(breakdown[0]).toMatchObject({ kind: "pass", contribution: null });
  });

  it("classifies courses with no grade yet as 'ongoing'", () => {
    const breakdown = buildCourseBreakdown([{ kurskod: "AAA", betyg: null, hp: 7.5 }], 0);
    expect(breakdown[0].kind).toBe("ongoing");
  });

  it("classifies a fetch failure (status set) as 'error', even if betyg happens to be set", () => {
    const breakdown = buildCourseBreakdown(
      [{ kurskod: "AAA", betyg: null, hp: 0, status: "error" }],
      0
    );
    expect(breakdown[0].kind).toBe("error");
  });

  it("classifies an unrecognized grade code as 'unknown' with no contribution", () => {
    const breakdown = buildCourseBreakdown([{ kurskod: "AAA", betyg: "Z", hp: 7.5 }], 7.5);
    expect(breakdown[0]).toMatchObject({ kind: "unknown", contribution: null });
  });

  it("returns an empty list for no courses", () => {
    expect(buildCourseBreakdown([], 0)).toEqual([]);
  });
});

describe("describeBreakdownItem", () => {
  it("describes a graded course with its GPA contribution", () => {
    const text = describeBreakdownItem({ kurskod: "SF1624", betyg: "A", hp: 7.5, kind: "graded", contribution: 0.375 });
    expect(text).toBe("SF1624 — A (7.5 hp) — bidrar med 0.375 till viktat snitt");
  });

  it("describes a Pass course as not counted in the average", () => {
    const text = describeBreakdownItem({ kurskod: "AAA", betyg: "P", hp: 7.5, kind: "pass", contribution: null });
    expect(text).toContain("räknas inte in i snittet");
  });

  it("describes an ongoing course", () => {
    const text = describeBreakdownItem({ kurskod: "AAA", betyg: null, hp: 7.5, kind: "ongoing", contribution: null });
    expect(text).toContain("pågående");
  });

  it("describes an unknown grade code, including the code itself", () => {
    const text = describeBreakdownItem({ kurskod: "AAA", betyg: "Z", hp: 7.5, kind: "unknown", contribution: null });
    expect(text).toContain("okänd betygskod");
    expect(text).toContain("Z");
  });

  it("describes a fetch error without implying a grade exists", () => {
    const text = describeBreakdownItem({ kurskod: "AAA", betyg: null, hp: 0, kind: "error", contribution: null });
    expect(text).toContain("kunde inte hämta betyget");
  });

  it("describes a graded course with a null contribution (totalHp 0) instead of throwing", () => {
    const text = describeBreakdownItem({ kurskod: "AAA", betyg: "A", hp: 0, kind: "graded", contribution: null });
    expect(text).toContain("bidrar med 0.000 till viktat snitt");
  });
});
