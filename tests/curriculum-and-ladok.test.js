import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const {
  parseMandatoryCoursesFromHtml,
  extractMandatoryCourses,
  extractApplicationStore,
  remainingCurriculumHp,
  inferAdmissionTerm,
  programLabel,
  findAllPrograms,
  buildSelectableOptions,
  getDefaultProgramId,
} = require_("../content.js");

describe("parseMandatoryCoursesFromHtml (older curriculum editions, HTML-table shape)", () => {
  it("reads course code and hp from the 'Obligatoriska kurser' table", () => {
    const html = `
      <h4 id="obligatoriska-kurser-ar-1">Obligatoriska kurser år 1</h4>
      <table><tbody>
        <tr><td>SF1624</td><td>Algebra</td><td>7,5 hp</td></tr>
        <tr><td>SF1625</td><td>Envariabelanalys</td><td>7,5 hp</td></tr>
      </tbody></table>
    `;
    expect(parseMandatoryCoursesFromHtml(html)).toEqual([
      { kod: "SF1624", hp: 7.5 },
      { kod: "SF1625", hp: 7.5 },
    ]);
  });

  it("returns an empty list when there's no matching heading", () => {
    expect(parseMandatoryCoursesFromHtml("<p>Inga obligatoriska kurser här.</p>")).toEqual([]);
  });

  it("never matches a hypothetical 'ickeobligatoriska' (non-mandatory) heading", () => {
    const html = `
      <h4 id="ickeobligatoriska-kurser">Valfria kurser</h4>
      <table><tbody><tr><td>XX1111</td><td>Valfri kurs</td><td>7,5 hp</td></tr></tbody></table>
    `;
    expect(parseMandatoryCoursesFromHtml(html)).toEqual([]);
  });

  it("skips rows with fewer than 3 cells", () => {
    const html = `
      <h4 id="obligatoriska-kurser">Obligatoriska</h4>
      <table><tbody><tr><td>SF1624</td><td>Algebra</td></tr></tbody></table>
    `;
    expect(parseMandatoryCoursesFromHtml(html)).toEqual([]);
  });
});

describe("extractMandatoryCourses (dispatches by studyYear.courses shape)", () => {
  it("filters a structured array by Valvillkor === 'O'", () => {
    const studyYear = {
      courses: [
        { kod: "AAA", Valvillkor: "O", omfattning: { number: 7.5 } },
        { kod: "BBB", Valvillkor: "V", omfattning: { number: 7.5 } },
      ],
    };
    expect(extractMandatoryCourses(studyYear)).toEqual([{ kod: "AAA", hp: 7.5 }]);
  });

  it("parses an HTML-string shape via parseMandatoryCoursesFromHtml", () => {
    const studyYear = {
      courses: `<h4 id="obligatoriska">Ob.</h4><table><tbody><tr><td>CCC</td><td>Kurs</td><td>15 hp</td></tr></tbody></table>`,
    };
    expect(extractMandatoryCourses(studyYear)).toEqual([{ kod: "CCC", hp: 15 }]);
  });

  it("returns an empty list for an unrecognized shape", () => {
    expect(extractMandatoryCourses({ courses: null })).toEqual([]);
    expect(extractMandatoryCourses({})).toEqual([]);
  });
});

describe("extractApplicationStore", () => {
  it("decodes and parses the embedded, URL-encoded JSON blob", () => {
    const payload = encodeURIComponent(JSON.stringify({ programmeTerms: ["20242", "20232"] }));
    const html = `<script>window.__compressedApplicationStore__ = "${payload}";</script>`;
    expect(extractApplicationStore(html)).toEqual({ programmeTerms: ["20242", "20232"] });
  });

  it("returns null when the blob is missing", () => {
    expect(extractApplicationStore("<html><body>nothing here</body></html>")).toBeNull();
  });

  it("returns null when the blob can't be parsed as JSON", () => {
    const html = `<script>window.__compressedApplicationStore__ = "not-json";</script>`;
    expect(extractApplicationStore(html)).toBeNull();
  });
});

describe("remainingCurriculumHp", () => {
  it("sums hp for mandatory courses not already started", () => {
    const curriculum = { courses: [{ kod: "AAA", hp: 7.5 }, { kod: "BBB", hp: 15 }] };
    expect(remainingCurriculumHp(curriculum, new Set(["AAA"]))).toBe(15);
  });

  it("returns null when there's no curriculum yet", () => {
    expect(remainingCurriculumHp(null, new Set())).toBeNull();
  });

  it("returns 0 when every mandatory course has already been started", () => {
    const curriculum = { courses: [{ kod: "AAA", hp: 7.5 }] };
    expect(remainingCurriculumHp(curriculum, new Set(["AAA"]))).toBe(0);
  });
});

describe("inferAdmissionTerm", () => {
  it("treats a spring-starting course as belonging to the previous autumn's cohort", () => {
    const kurser = [
      { Utbildningsinformation: { Studieperiod: { Startdatum: "2025-01-15" } } },
    ];
    expect(inferAdmissionTerm(kurser)).toBe("20242");
  });

  it("treats an autumn-starting course as that same autumn's cohort", () => {
    const kurser = [
      { Utbildningsinformation: { Studieperiod: { Startdatum: "2024-09-01" } } },
    ];
    expect(inferAdmissionTerm(kurser)).toBe("20242");
  });

  it("uses the earliest start date across all courses", () => {
    const kurser = [
      { Utbildningsinformation: { Studieperiod: { Startdatum: "2025-09-01" } } },
      { Utbildningsinformation: { Studieperiod: { Startdatum: "2023-09-01" } } },
    ];
    expect(inferAdmissionTerm(kurser)).toBe("20232");
  });

  it("skips withdrawn (Aterbud) courses", () => {
    const kurser = [
      { Aterbud: true, Utbildningsinformation: { Studieperiod: { Startdatum: "2020-09-01" } } },
      { Utbildningsinformation: { Studieperiod: { Startdatum: "2024-09-01" } } },
    ];
    expect(inferAdmissionTerm(kurser)).toBe("20242");
  });

  it("returns null when no course has a usable start date", () => {
    expect(inferAdmissionTerm([{ Utbildningsinformation: {} }])).toBeNull();
  });
});

describe("programLabel", () => {
  it("returns a plain string Benamning as-is", () => {
    expect(programLabel({ Utbildningsinformation: { Benamning: "Civilingenjör Datateknik" } })).toBe(
      "Civilingenjör Datateknik"
    );
  });

  it("prefers the Swedish label from a localized Benamning object", () => {
    expect(
      programLabel({ Utbildningsinformation: { Benamning: { sv: "Datateknik", en: "Computer Science" } } })
    ).toBe("Datateknik");
  });

  it("falls back to Utbildningskod, then a placeholder", () => {
    expect(programLabel({ Utbildningsinformation: { Utbildningskod: "CDATE" } })).toBe("CDATE");
    expect(programLabel({ Utbildningsinformation: {} })).toBe("Okänt program");
  });
});

describe("findAllPrograms / buildSelectableOptions / getDefaultProgramId", () => {
  const structData = {
    Studiestrukturer: [
      { Utbildningsinformation: { Utbildningskod: "CDATE", Benamning: "Datateknik" }, link: [] },
      { Utbildningsinformation: { Utbildningskod: "TBASE1", Benamning: "Basår" }, link: [] },
    ],
  };

  it("flags basår programs by their education code prefix", () => {
    const programs = findAllPrograms(structData);
    expect(programs.find((p) => p.id === "TBASE1").isBasar).toBe(true);
    expect(programs.find((p) => p.id === "CDATE").isBasar).toBe(false);
    expect(programs.find((p) => p.id === "TBASE1").label).toBe("Basår (basår)");
  });

  it("adds a combined 'Alla program' option only when both basår and a non-basår program exist", () => {
    const programs = findAllPrograms(structData);
    const options = buildSelectableOptions(programs);
    expect(options.map((o) => o.id)).toEqual(["CDATE", "TBASE1", "__all__"]);
    expect(options.find((o) => o.id === "__all__").nodes.length).toBe(2);
  });

  it("doesn't add a combined option when there's no basår", () => {
    const nonBasarOnly = { Studiestrukturer: [structData.Studiestrukturer[0]] };
    const options = buildSelectableOptions(findAllPrograms(nonBasarOnly));
    expect(options.map((o) => o.id)).toEqual(["CDATE"]);
  });

  it("defaults to a non-basår program when one exists", () => {
    const programs = findAllPrograms(structData);
    expect(getDefaultProgramId(programs)).toBe("CDATE");
  });

  it("falls back to the only program when it's basår-only", () => {
    const basarOnly = { Studiestrukturer: [structData.Studiestrukturer[1]] };
    const programs = findAllPrograms(basarOnly);
    expect(getDefaultProgramId(programs)).toBe("TBASE1");
  });
});
