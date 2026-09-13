import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const {
  parseRequirementFromPage,
  parsePartnerLinks,
  parseHubTable,
  normalizeProgramText,
  guessSchoolForProgram,
  computeRequiredAverage,
  closestGradeLabel,
} = require_("../content.js");

// These fixtures mirror the "Betygskrav: ... Söktryck: ... Läs mer om
// söktryck till KTH:s partneruniversitet" structure documented in the
// README/architecture notes for KTH's partner-university pages.

function page(body) {
  return `<html><body>${body}</body></html>`;
}

describe("parseRequirementFromPage", () => {
  it("reads a bare-number Betygskrav", () => {
    const html = page(
      "Utbytesmöjligheter Betygskrav: 4,5 Söktryck: Högt söktryck. Läs mer om söktryck till KTH:s partneruniversitet här."
    );
    const { value, snippet } = parseRequirementFromPage(html);
    expect(value).toBe(4.5);
    expect(snippet).toContain("Betygskrav: 4,5");
    expect(snippet).toContain("Söktryck: Högt söktryck.");
  });

  it("reads a 'minimikrav på X,X' Betygskrav", () => {
    const html = page(
      "Betygskrav: minimikrav på 4,0 (se även antagningskrav) Söktryck: Lägre söktryck. Läs mer om söktryck till KTH:s partneruniversitet"
    );
    expect(parseRequirementFromPage(html).value).toBe(4.0);
  });

  it("returns null value for 'Nej' with no de-facto number in Söktryck", () => {
    const html = page(
      "Betygskrav: Nej Söktryck: Lägre söktryck. Läs mer om söktryck till KTH:s partneruniversitet"
    );
    const { value, snippet } = parseRequirementFromPage(html);
    expect(value).toBeNull();
    expect(snippet).toContain("Betygskrav: Nej");
  });

  it("falls back to a snittbetyg number embedded in Söktryck when Betygskrav gives none", () => {
    const html = page(
      "Betygskrav: Nej Söktryck: Krävs ofta höga snittbetyg (4,5 eller högre) för att antas. Läs mer om söktryck till KTH:s partneruniversitet"
    );
    expect(parseRequirementFromPage(html).value).toBe(4.5);
  });

  it("never lets an unrelated number elsewhere in Betygskrav's text be mistaken for the requirement", () => {
    // e.g. a Swedish upper-secondary English-course grade requirement
    // mentioned in the same block as a real "Nej" - only a number that
    // appears essentially right after "Betygskrav:" should count.
    const html = page(
      "Betygskrav: Nej, men Engelska 6 krävs Söktryck: Lägre söktryck. Läs mer om söktryck till KTH:s partneruniversitet"
    );
    expect(parseRequirementFromPage(html).value).toBeNull();
  });

  it("returns nulls when the page doesn't use this structure at all", () => {
    const html = page("Den här sidan har inget krav-avsnitt alls.");
    const { value, snippet } = parseRequirementFromPage(html);
    expect(value).toBeNull();
    expect(snippet).toBeNull();
  });
});

describe("parsePartnerLinks", () => {
  it("extracts partner-university links, skipping nav-item and index/hub links", () => {
    const html = `<html><body>
      <a class="nav-item" href="/student/studier/utlandsstudier/utbyte/ansokan-1.1">Ansökan</a>
      <a href="/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-eecs-1.900169">EECS-skolan</a>
      <a href="/student/studier/utlandsstudier/utbyte/utbytesuniversitet-1.590677">Hub</a>
      <a href="/student/studier/utlandsstudier/utbyte/eth-zurich-1.2.3">ETH Zürich</a>
      <a href="/student/studier/utlandsstudier/utbyte/tu-delft-1.4.5">TU Delft</a>
    </body></html>`;
    const links = parsePartnerLinks(html);
    expect(links.map((l) => l.name)).toEqual(["ETH Zürich", "TU Delft"]);
    expect(links[0].url).toBe("https://www.kth.se/student/studier/utlandsstudier/utbyte/eth-zurich-1.2.3");
  });

  it("skips anchors with empty text", () => {
    const html = `<html><body><a href="/student/studier/utlandsstudier/utbyte/blank-1.1"></a></body></html>`;
    expect(parsePartnerLinks(html)).toEqual([]);
  });
});

describe("parseHubTable", () => {
  it("parses the 3-column Swedish table (Typ/Program/Skola)", () => {
    const html = `<table><tr><td>Civilingenjör</td><td>Datateknik</td><td>EECS</td></tr></table>`;
    expect(parseHubTable(html)).toEqual([{ typ: "Civilingenjör", program: "Datateknik", skola: "EECS" }]);
  });

  it("parses the 2-column English table (Programme/School) with an empty typ", () => {
    const html = `<table><tr><td>Computer Science</td><td>EECS</td></tr></table>`;
    expect(parseHubTable(html)).toEqual([{ typ: "", program: "Computer Science", skola: "EECS" }]);
  });

  it("ignores rows with an unexpected number of columns", () => {
    const html = `<table><tr><td>Only one cell</td></tr></table>`;
    expect(parseHubTable(html)).toEqual([]);
  });
});

describe("normalizeProgramText", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeProgramText("Civilingenjör  Datateknik,  Master.")).toBe(
      "civilingenjör datateknik master"
    );
  });

  it("handles null/undefined without throwing", () => {
    expect(normalizeProgramText(null)).toBe("");
    expect(normalizeProgramText(undefined)).toBe("");
  });
});

describe("guessSchoolForProgram", () => {
  const rows = [
    { typ: "Civilingenjör", program: "Datateknik", skola: "EECS" },
    { typ: "Civilingenjör", program: "Elektroteknik", skola: "EECS" },
    { typ: "Högskoleingenjör", program: "Datateknik", skola: "EECS" },
    { typ: "Civilingenjör", program: "Maskinteknik", skola: "ITM" },
  ];

  it("returns the matching school for a program label containing a known program name", () => {
    expect(guessSchoolForProgram("Civilingenjörsprogrammet i Datateknik", rows)).toBe("EECS");
  });

  it("returns null when nothing matches at all", () => {
    expect(guessSchoolForProgram("Något helt okänt program", rows)).toBeNull();
  });

  it("returns null for an empty label", () => {
    expect(guessSchoolForProgram("", rows)).toBeNull();
  });

  it("prefers a match on both typ and program when several program-only matches disagree on school", () => {
    // "Datateknik" alone matches two rows, both EECS here, so this doesn't
    // exercise disagreement, but confirms the typ-matching path doesn't
    // break a same-school case.
    expect(guessSchoolForProgram("Högskoleingenjör Datateknik", rows)).toBe("EECS");
  });

  it("falls back to the most specific (longest) program match when schools disagree and typ doesn't disambiguate", () => {
    const disagreeing = [
      { typ: "", program: "Teknik", skola: "ITM" },
      { typ: "", program: "Informationsteknik", skola: "EECS" },
    ];
    expect(guessSchoolForProgram("Civilingenjör Informationsteknik", disagreeing)).toBe("EECS");
  });
});

describe("computeRequiredAverage", () => {
  it("computes the average needed on remaining hp to reach a target overall", () => {
    // Already have 90 hp at weighted sum 360 (avg 4.0). Want to reach 4.2
    // overall across 90 + 30 = 120 hp total.
    const required = computeRequiredAverage(360, 90, 30, 4.2);
    // (4.2*120 - 360) / 30 = 4.8
    expect(required).toBeCloseTo(4.8);
  });

  it("returns null when there's no remaining hp", () => {
    expect(computeRequiredAverage(360, 90, 0, 4.2)).toBeNull();
    expect(computeRequiredAverage(360, 90, -5, 4.2)).toBeNull();
  });
});

describe("closestGradeLabel", () => {
  it("returns the lowest grade letter whose points meet or exceed the average", () => {
    expect(closestGradeLabel(3.5)).toBe("D");
    expect(closestGradeLabel(5)).toBe("A");
    expect(closestGradeLabel(0)).toBe("F");
  });

  it("returns null when the average is unachievable (higher than an A)", () => {
    expect(closestGradeLabel(5.1)).toBeNull();
  });
});
