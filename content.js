// KTH Ladok GPA extension
// Content script that runs on student.ladok.se and calculates the user's GPA
// based on completed courses within a program of the user's choosing. Basår
// (preparatory year) is excluded by default but can be picked explicitly, or
// combined with the rest via the "Alla program (inkl. basår)" option.

(function () {
  "use strict";

  // Matches internal Ladok API URLs that contain the logged-in student's UID,
  // e.g. ".../studentinformation/internal/student/{uid}" or
  // ".../studiedeltagande/internal/tillfallesdeltagande/kurstillfallesdeltagande/student/{uid}"
  const STUDENT_UID_REGEX =
    /\/(?:studentinformation|studiedeltagande)\/internal\/(?:tillfallesdeltagande\/kurstillfallesdeltagande\/student|student)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Matches the same-origin proxy id Ladok's own web app uses, e.g.
  // "/student/proxy/29/..." - discovered dynamically instead of hardcoded,
  // so this isn't tied to one specific institution's routing number.
  const PROXY_REGEX = /\/student\/proxy\/(\d+)\//;

  // KTH's official GPA scale. A course with a final grade (A-F) counts as
  // completed regardless of pass/fail - only "P" (ungraded pass) and courses
  // still in progress are excluded from the average.
  const GRADE_POINTS = { A: 5, B: 4.5, C: 4, D: 3.5, E: 3, F: 0, FX: 0 };

  // Looks up a grade case-insensitively, since we don't fully control the
  // casing Ladok's API returns (e.g. "FX" vs "Fx"). Returns undefined for
  // any code we don't recognize, so callers can surface it instead of
  // silently dropping the course from every counter.
  function gradePoints(betyg) {
    if (!betyg) return undefined;
    const key = Object.keys(GRADE_POINTS).find(
      (k) => k.toLowerCase() === String(betyg).toLowerCase()
    );
    return key !== undefined ? GRADE_POINTS[key] : undefined;
  }

  const STORAGE_KEY = "kthGpaSelectedProgramId";

  let widgetEl = null;
  let currentProxyId = null;
  let currentOptions = [];
  let currentCourses = [];
  let currentResult = null;
  let currentProgramLabel = "";
  let currentSelectedProgramId = null; // the picker option id (Utbildningskod, or "__all__") - keys the GPA history
  let currentProgramCode = null; // Ladok Utbildningskod, e.g. "CDATE" - null for combined/basår options
  let currentAdmissionTerm = null; // e.g. "20242", inferred from your earliest course's start date

  // The whole-programme curriculum fetched from KTH's public course catalog
  // (kth.se/student/kurser/program/...), used to auto-compute "hp kvar" for
  // the exchange-target calculator instead of only counting already-started
  // courses.
  let futureCurriculum = null; // { term, sourceUrl, owningSchool, courses: [{kod,hp}] }
  let futureCurriculumLoading = false;
  let futureCurriculumKey = null; // `${programCode}:${admissionTerm}` this result is for
  let futureCurriculumError = null;

  // "Effektivisera ditt GPA" panel state, kept across re-renders so the
  // panel's open/closed state and the user's in-progress exchange-school
  // selection survive a program switch.
  let efficiencyPanelOpen = false;
  // Per-course breakdown panel state, kept across re-renders like
  // efficiencyPanelOpen above so it stays open across a program switch.
  let courseBreakdownOpen = false;
  // GPA-history panel state, same lifecycle as the two above.
  let historyPanelOpen = false;

  // "Vad-om"-calculator state: a small list of (course, hypothetical grade)
  // rows the student is trying out. Reset whenever the selected program
  // changes, since the course list underneath no longer applies.
  let whatIfRows = []; // [{ id, kurskod, betyg }]
  let whatIfNextRowId = 1;
  let exchangeSchoolMap = null; // [{typ, program, skola}] from KTH's hub table
  let exchangeSchoolMapLoading = false;
  let exchangeSchools = null; // partner-university list for exchangeSelection.skola
  let exchangeSchoolsForSkola = null;
  let exchangeSchoolsLoading = false;
  const exchangeSelection = {
    skola: null, // ABE / CBH / EECS / ITM / SCI - which of your program is under
    skolaAutoDetected: false,
    skolaOverrideOpen: false, // true once the student clicks "byt manuellt"
    schoolUrl: "",
    target: null,
    snippet: null,
    error: null, // set on a genuine fetch failure, separate from "nothing found on the page"
    loadingRequirement: false,
    hpOverride: null,
  };

  // --- Helpers to discover session-specific values from the page's own network traffic ---
  // We never guess or construct login/session data ourselves; we only read
  // URLs the page has already requested using the user's existing session.

  function findFromPerformanceEntries(regex) {
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      const match = entry.name.match(regex);
      if (match) return match[1];
    }
    return null;
  }

  function waitForValue(regex, { timeoutMs = 15000, intervalMs = 500 } = {}) {
    return new Promise((resolve) => {
      const existing = findFromPerformanceEntries(regex);
      if (existing) return resolve(existing);

      const start = Date.now();
      const timer = setInterval(() => {
        const found = findFromPerformanceEntries(regex);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  // --- Ladok API calls (all routed through the same-origin proxy to satisfy CSP) ---

  async function fetchJson(url, mediaType) {
    const res = await fetch(url, {
      headers: { Accept: `application/vnd.ladok-${mediaType}+json` },
      credentials: "include",
    });
    if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
    return res.json();
  }

  function toProxyUrl(apiUrl, service, proxyId) {
    return apiUrl.replace(
      `https://api.ladok.se:443/${service}`,
      `https://student.ladok.se/student/proxy/${proxyId}/${service}`
    );
  }

  async function fetchStudiestruktur(studentUID, proxyId) {
    const url = `https://student.ladok.se/student/proxy/${proxyId}/studiedeltagande/internal/studiestruktur/student/${studentUID}`;
    return fetchJson(url, "studiedeltagande");
  }

  // Basår (preparatory year) structures use education codes starting with
  // TBASE/FUP. We still list them as a selectable program (some students
  // want to include them), we just don't default to them - the default
  // selection prefers a non-basår program when one exists.
  function findAllPrograms(structData) {
    const structs = structData.Studiestrukturer || [];
    return structs
      .filter((s) => s.Utbildningsinformation?.Utbildningskod)
      .map((node, idx) => {
        const kod = node.Utbildningsinformation.Utbildningskod;
        const isBasar = kod.startsWith("TBASE") || kod.startsWith("FUP");
        return {
          id: kod || `program-${idx}`,
          label: programLabel(node) + (isBasar ? " (basår)" : ""),
          node,
          isBasar,
        };
      });
  }

  // Builds the list of choices shown in the picker: one entry per program,
  // plus - when the student has both a basår and at least one other program
  // - an extra combined option that counts every course from every program.
  function buildSelectableOptions(allPrograms) {
    const options = allPrograms.map((p) => ({
      id: p.id,
      label: p.label,
      nodes: [p.node],
    }));

    const hasBasar = allPrograms.some((p) => p.isBasar);
    const hasNonBasar = allPrograms.some((p) => !p.isBasar);
    if (hasBasar && hasNonBasar) {
      options.push({
        id: "__all__",
        label: "Alla program (inkl. basår)",
        nodes: allPrograms.map((p) => p.node),
      });
    }

    return options;
  }

  function programLabel(node) {
    const info = node.Utbildningsinformation || {};
    const benamning = info.Benamning;
    if (typeof benamning === "string" && benamning) return benamning;
    if (benamning && typeof benamning === "object") {
      const val = benamning.sv || benamning.en || Object.values(benamning)[0];
      if (val) return val;
    }
    return info.Utbildningskod || "Okänt program";
  }

  function getDefaultProgramId(allPrograms) {
    const nonBasar = allPrograms.find((p) => !p.isBasar);
    return (nonBasar || allPrograms[0]).id;
  }

  function getStoredProgramId(options, defaultId) {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // localStorage may be unavailable (e.g. blocked); just fall back.
    }
    if (stored && options.some((o) => o.id === stored)) return stored;
    return defaultId;
  }

  function setStoredProgramId(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {
      // Ignore - remembering the choice is a nice-to-have, not essential.
    }
  }

  async function fetchProgramCourses(programNode, proxyId) {
    const link = programNode.link.find((l) => l.rel.includes("paborjade_kurser"));
    if (!link) {
      throw new Error("Could not find the 'paborjade_kurser' link on the program node.");
    }
    const url = toProxyUrl(link.uri, "studiedeltagande", proxyId);
    return fetchJson(url, "studiedeltagande");
  }

  async function fetchGradeForCourse(kurs, proxyId) {
    const kurskod = kurs.Utbildningsinformation.Utbildningskod;
    const link = kurs.link.find((l) => l.rel.includes("egenkursinformation"));
    if (!link) return { kurskod, betyg: null, hp: null, status: "no-link" };

    try {
      const url = toProxyUrl(link.uri, "resultat", proxyId);
      const data = await fetchJson(url, "resultat");
      const kv = data.Kursversioner?.[0];
      const betyg =
        kv?.VersionensKurs?.ResultatPaUtbildning?.SenastAttesteradeResultat?.Betygsgradsobjekt
          ?.Kod ?? null;
      const hp = kv?.VersionensKurs?.Omfattning ?? null;
      return { kurskod, betyg, hp };
    } catch (e) {
      return { kurskod, betyg: null, hp: null, status: "error" };
    }
  }

  // Infers which KTH curriculum edition (e.g. "20242" for a student admitted
  // for HT2024) applies to the student, from the earliest start date among
  // their own course registrations - Ladok doesn't expose an explicit
  // "admission term" field we've found, but every started course carries its
  // own Studieperiod.Startdatum. KTH's engineering/bachelor/master
  // programmes are (almost) always admitted in the autumn, so a course
  // starting Jan-Jun is treated as still belonging to the previous autumn's
  // cohort/curriculum edition.
  function inferAdmissionTerm(kurser) {
    let earliest = null;
    for (const k of kurser) {
      if (k.Aterbud) continue;
      const startStr = k.Utbildningsinformation?.Studieperiod?.Startdatum;
      if (!startStr) continue;
      const d = new Date(startStr);
      if (Number.isNaN(d.getTime())) continue;
      if (!earliest || d < earliest) earliest = d;
    }
    if (!earliest) return null;
    const year = earliest.getMonth() < 6 ? earliest.getFullYear() - 1 : earliest.getFullYear();
    return `${year}2`;
  }

  // --- GPA calculation ---
  // KTH's official grade-point scale. A course with any final grade A-F
  // counts as completed and enters the average (F/Fx as 0 points) - only
  // "P" (ungraded pass) courses and courses still in progress are excluded
  // from the average (shown as separate counters instead). Courses whose
  // grade couldn't be fetched are also kept separate, as errors rather than
  // silently lumped in with "ongoing".

  function calculateGPA(courses) {
    let weightedSum = 0;
    let totalHp = 0;
    let unweightedSum = 0;
    let gradedCount = 0;
    let passCount = 0;
    let ongoingCount = 0;
    let ongoingHp = 0;
    let errorCount = 0;
    let unknownCount = 0;

    for (const c of courses) {
      const hp = parseFloat(c.hp) || 0;

      if (c.status) {
        errorCount++;
        continue;
      }
      if (!c.betyg) {
        ongoingCount++;
        ongoingHp += hp;
        continue;
      }
      if (c.betyg === "P") {
        passCount++;
        continue;
      }
      const points = gradePoints(c.betyg);
      if (points !== undefined) {
        weightedSum += points * hp;
        totalHp += hp;
        unweightedSum += points;
        gradedCount++;
      } else {
        // A grade code we don't recognize - surface it explicitly rather
        // than silently dropping the course from every counter.
        unknownCount++;
      }
    }

    return {
      weightedGPA: totalHp > 0 ? weightedSum / totalHp : null,
      unweightedGPA: gradedCount > 0 ? unweightedSum / gradedCount : null,
      totalHp,
      gradedCount,
      passCount,
      ongoingCount,
      ongoingHp,
      errorCount,
      unknownCount,
      totalCount: courses.length,
    };
  }

  // --- GPA history/trend ---
  // Snapshots the computed GPA into localStorage each time the widget runs,
  // keyed per program (so switching programs doesn't mix their trends) and
  // per calendar day (so recalculating on every page load of the same day
  // doesn't spam the history with near-duplicate points - only the latest
  // value for a given day is kept).

  const GPA_HISTORY_STORAGE_KEY = "kthGpaHistory";
  const GPA_HISTORY_MAX_ENTRIES = 365; // ~a year of daily points per program, plenty for a trend

  function dateKeyForDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // Adds/replaces the entry for `dateKey`, keeps the list sorted by date,
  // and caps its length - all without mutating the input array.
  function upsertHistoryEntry(entries, dateKey, snapshot) {
    const withoutSameDay = entries.filter((e) => e.date !== dateKey);
    const updated = [...withoutSameDay, { date: dateKey, ...snapshot }];
    updated.sort((a, b) => a.date.localeCompare(b.date));
    return updated.slice(-GPA_HISTORY_MAX_ENTRIES);
  }

  function readGpaHistoryStore() {
    try {
      return JSON.parse(localStorage.getItem(GPA_HISTORY_STORAGE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function writeGpaHistoryStore(store) {
    try {
      localStorage.setItem(GPA_HISTORY_STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      // Ignore - history is a nice-to-have, not essential.
    }
  }

  // Nothing meaningful to plot yet if there's no weighted GPA at all (e.g.
  // only ongoing courses so far) - skip recording rather than storing a
  // point that would just read as "0".
  function recordGpaHistoryEntry(programId, result) {
    if (!programId || !result || result.weightedGPA === null) return;
    const store = readGpaHistoryStore();
    const entries = store[programId] || [];
    const snapshot = {
      weightedGPA: round2(result.weightedGPA),
      unweightedGPA: result.unweightedGPA !== null ? round2(result.unweightedGPA) : null,
      totalHp: result.totalHp,
    };
    store[programId] = upsertHistoryEntry(entries, dateKeyForDate(new Date()), snapshot);
    writeGpaHistoryStore(store);
  }

  // Maps GPA values to (x, y) coordinates for a simple sparkline, scaled to
  // fill the given box. Pulled out from the SVG-building code so the actual
  // math is testable without a DOM.
  function sparklinePoints(values, width, height, padding = 2) {
    if (!values.length) return [];
    if (values.length === 1) return [[width / 2, height / 2]];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1; // avoid a divide-by-zero when every value is identical
    const usableW = width - padding * 2;
    const usableH = height - padding * 2;
    return values.map((v, i) => {
      const x = padding + (i / (values.length - 1)) * usableW;
      const y = padding + usableH - ((v - min) / range) * usableH;
      return [x, y];
    });
  }

  // --- "Most efficient way to raise your GPA" (existing courses) ---
  // Swedish universities (KTH included) commonly let you sit an exam again
  // for a higher grade on a course you've already passed, subject to that
  // course's own rules. This ranks your completed courses by how much
  // re-examining each one for an A would move your overall weighted GPA -
  // computed purely from data already fetched, nothing new to hardcode.
  function rankRetakeCandidates(courses, totalHp) {
    if (!totalHp) return [];
    return courses
      .filter((c) => !c.status && c.betyg && c.betyg !== "P")
      .map((c) => {
        const points = gradePoints(c.betyg);
        if (points === undefined || points >= GRADE_POINTS.A) return null;
        const hp = parseFloat(c.hp) || 0;
        const potentialGain = ((GRADE_POINTS.A - points) * hp) / totalHp;
        return { kurskod: c.kurskod, betyg: c.betyg, hp, potentialGain };
      })
      .filter((r) => r && r.potentialGain > 0)
      .sort((a, b) => b.potentialGain - a.potentialGain)
      .slice(0, 5);
  }

  // --- "Vad-om"-calculator (generalizes the retake ranking above) ---
  // Rather than only asking "what if I retook this course for an A", lets
  // the student try any hypothetical grade on any course - already graded
  // (simulating a retake) or still ongoing (simulating the exam result) -
  // and see the resulting whole-programme GPA, not just that one course's
  // isolated impact.

  // Human-readable label for what a course's grade currently is, used in
  // the course picker so the student can see what they'd be overriding.
  function currentGradeLabel(course) {
    if (course.status) return "kunde inte hämtas";
    if (!course.betyg) return "pågående";
    return course.betyg;
  }

  // Returns a new course list with the given (kurskod -> hypothetical
  // grade) overrides applied, leaving every other course untouched. A
  // course being overridden also has any fetch-error status cleared, so a
  // hypothetical grade on it actually counts toward the recalculated GPA
  // instead of still being treated as "couldn't be fetched". Never mutates
  // the input list.
  function applyWhatIfOverrides(courses, overrides) {
    const byKurskod = new Map();
    for (const o of overrides || []) {
      if (o && o.kurskod && o.betyg) byKurskod.set(o.kurskod, o.betyg);
    }
    if (!byKurskod.size) return courses;
    return courses.map((c) =>
      byKurskod.has(c.kurskod) ? { ...c, betyg: byKurskod.get(c.kurskod), status: null } : c
    );
  }

  // --- Exchange-studies comparison ---
  // KTH doesn't publish a fixed GPA/meritvärde cutoff per partner university
  // - exchange places are allocated by relative ranking of that year's
  // applicants, not a fixed threshold. But each partner university's own KTH
  // page often states a rough guideline in prose (e.g. "Kräver ofta höga
  // snittbetyg (4,5 eller högre)"). We fetch that live and quote it verbatim
  // with a source link rather than hardcoding any number ourselves, since it
  // varies by school and changes over time.

  const KTH_ORIGIN = "https://www.kth.se";

  // KTH's 5 schools - a stable part of KTH's organizational structure (unlike
  // any numeric requirement), so safe to name directly. Every KTH program
  // belongs to exactly one of these, and exchange places are allocated
  // per school - a program under EECS can't apply to an ABE-only partner
  // and vice versa, so we must filter the partner list by school.
  const KTH_SCHOOL_NAMES = {
    ABE: "Arkitektur och samhällsbyggnad",
    CBH: "Kemi, bioteknologi och hälsa",
    EECS: "Elektroteknik och datavetenskap",
    ITM: "Industriell teknik och management",
    SCI: "Teknikvetenskap",
  };

  const KTH_SCHOOL_INDEX_URLS = {
    ABE:
      KTH_ORIGIN +
      "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-arkitektur-och-samhallsbyggnad-1.590672",
    CBH:
      KTH_ORIGIN +
      "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-kemi-bioteknologi-och-halsa-1.900125",
    EECS:
      KTH_ORIGIN +
      "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-elektroteknik-och-datavetenskap-1.900169",
    ITM:
      KTH_ORIGIN +
      "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-industriell-teknik-och-management-1.590726",
    SCI:
      KTH_ORIGIN +
      "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-skolan-for-teknikvetenskap-1.590700",
  };

  const KTH_EXCHANGE_HUB_URL =
    KTH_ORIGIN + "/student/studier/utlandsstudier/utbyte/utbytesuniversitet-1.590677";

  const EXCHANGE_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const PROGRAM_SCHOOL_MAP_CACHE_KEY = "kthGpaProgramSchoolMap";

  // Fetched via the background service worker rather than directly here -
  // a content script's own fetches run inside student.ladok.se's execution
  // context and are subject to Ladok's Content-Security-Policy, which can
  // silently block a cross-origin request to kth.se. The service worker
  // isn't part of any page and isn't bound by any page's CSP.
  function fetchKthPage(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchKthPage", url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || "Unknown fetch error"));
          return;
        }
        resolve(response.html);
      });
    });
  }

  // Extracts every link to an individual partner-university page from one
  // school's index page. General informational pages (FAQ, application
  // process, funding, ...) share the same URL family but live in the site's
  // nav menu (class "nav-item") rather than the actual university list, so
  // excluding that class is far more robust than trying to enumerate every
  // non-university slug by hand. The school-index and hub pages themselves
  // are excluded separately since a locale-switch link to them isn't
  // nav-item classed.
  function parsePartnerLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = doc.querySelectorAll(
      "a[href*='/student/studier/utlandsstudier/utbyte/']"
    );
    const results = [];
    for (const a of anchors) {
      if (a.classList.contains("nav-item")) continue;
      const href = a.getAttribute("href") || "";
      if (href.includes("utbytesuniversitet-skolan-for")) continue;
      if (href.includes("utbytesuniversitet-1.590677")) continue;
      const name = a.textContent.trim();
      if (!name) continue;
      const url = href.startsWith("http") ? href : KTH_ORIGIN + href;
      results.push({ name, url });
    }
    return results;
  }

  async function loadExchangeSchoolList(skola) {
    const cacheKey = `kthGpaExchangeSchools:${skola}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.timestamp < EXCHANGE_LIST_CACHE_TTL_MS) {
        return cached.schools;
      }
    } catch (e) {
      // Ignore corrupt/unavailable cache - just re-fetch.
    }

    const html = await fetchKthPage(KTH_SCHOOL_INDEX_URLS[skola]);
    const schools = parsePartnerLinks(html).sort((a, b) => a.name.localeCompare(b.name, "sv"));

    try {
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), schools }));
    } catch (e) {
      // Ignore - caching is a nice-to-have.
    }

    return schools;
  }

  const KTH_EXCHANGE_HUB_URL_EN =
    KTH_ORIGIN + "/en/student/studier/utlandsstudier/utbyte/utbytesuniversitet-1.590677";

  function parseHubTable(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [];
    for (const tr of doc.querySelectorAll("table tr")) {
      const cells = tr.querySelectorAll("td");
      // The Swedish table has 3 columns (Typ/Program/Skola), the English one
      // only 2 (Programme/School - it only lists English-taught master's
      // programmes, KTH's bachelor/civilingenjör programmes have no English
      // name). A 2-column row just gets an empty typ.
      if (cells.length === 3) {
        rows.push({
          typ: cells[0].textContent.trim(),
          program: cells[1].textContent.trim(),
          skola: cells[2].textContent.trim(),
        });
      } else if (cells.length === 2) {
        rows.push({ typ: "", program: cells[0].textContent.trim(), skola: cells[1].textContent.trim() });
      }
    }
    return rows;
  }

  // Parses KTH's program→school table(s) that map every KTH program to one
  // of the 5 schools, so we can figure out which school's partner list
  // actually applies to the student's own program. Fetches both the Swedish
  // and English versions since Ladok may display a program's name in either
  // language depending on the student's chosen display language.
  async function loadProgramSchoolMap() {
    try {
      const cached = JSON.parse(
        localStorage.getItem(PROGRAM_SCHOOL_MAP_CACHE_KEY) || "null"
      );
      if (cached && Date.now() - cached.timestamp < EXCHANGE_LIST_CACHE_TTL_MS) {
        return cached.rows;
      }
    } catch (e) {
      // Ignore corrupt/unavailable cache - just re-fetch.
    }

    const [svHtml, enHtml] = await Promise.all([
      fetchKthPage(KTH_EXCHANGE_HUB_URL),
      fetchKthPage(KTH_EXCHANGE_HUB_URL_EN).catch(() => null),
    ]);
    const rows = parseHubTable(svHtml);
    if (enHtml) rows.push(...parseHubTable(enHtml));

    try {
      localStorage.setItem(
        PROGRAM_SCHOOL_MAP_CACHE_KEY,
        JSON.stringify({ timestamp: Date.now(), rows })
      );
    } catch (e) {
      // Ignore - caching is a nice-to-have.
    }

    return rows;
  }

  function normalizeProgramText(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Best-effort guess at which of the 5 schools the given Ladok program
  // label belongs to, by matching KTH's table against it. Only returns null
  // when nothing at all matches - when several rows match but disagree on
  // school, it trusts the most specific (longest) program-name match rather
  // than giving up, so the student isn't asked to pick manually unless we
  // truly have nothing to go on. The UI still lets them correct a wrong
  // guess, so a confident-but-wrong pick is always recoverable.
  function guessSchoolForProgram(programLabelText, rows) {
    const label = normalizeProgramText(programLabelText);
    if (!label) return null;

    let matches = rows.filter((r) => label.includes(normalizeProgramText(r.program)));
    if (!matches.length) return null;

    if (matches.length > 1) {
      const byType = matches.filter((r) => r.typ && label.includes(normalizeProgramText(r.typ)));
      if (byType.length) matches = byType;
    }

    const uniqueSchools = new Set(matches.map((m) => m.skola));
    if (uniqueSchools.size === 1) return matches[0].skola;

    matches.sort((a, b) => b.program.length - a.program.length);
    return matches[0].skola;
  }

  function firstSentence(text, maxLen) {
    if (!text) return null;
    const idx = text.indexOf(". ");
    const cut = idx === -1 ? text : text.slice(0, idx + 1);
    return cut.length > maxLen ? cut.slice(0, maxLen).trim() + "…" : cut.trim();
  }

  // Every partner-university page KTH publishes has a structured
  // "Betygskrav: ... Söktryck: ..." pair under "Utbytesmöjligheter" - e.g.
  // "Betygskrav: 4,5" / "Betygskrav: minimikrav på 4,0 (...)" / "Betygskrav:
  // Nej" paired with "Söktryck: Högt söktryck. ...". We read those two
  // fields directly rather than hunting for the word "snittbetyg" anywhere
  // on the page, since most pages state their requirement without ever
  // using that word. This is KTH's own wording, not a guaranteed cutoff -
  // we quote it and link back to the source instead of presenting it as an
  // official number.
  function parseRequirementFromPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = doc.body ? doc.body.textContent : "";
    const normalized = text.replace(/\s+/g, " ");

    const betygskravMatch = normalized.match(/Betygskrav:?\s*(.*?)\s*Söktryck:/i);
    const soktryckMatch = normalized.match(/Söktryck:?\s*(.*?)\s*Läs mer om söktryck/i);
    const betygskravRaw = betygskravMatch ? betygskravMatch[1].trim() : null;
    const soktryckRaw = soktryckMatch ? soktryckMatch[1].trim() : null;

    // Only trust a number that appears essentially right after "Betygskrav:"
    // (allowing for a "(" or a "minimikrav på/om" prefix) - some pages say
    // "Betygskrav: Nej" but go on to mention an unrelated number further
    // into the same field (e.g. a Swedish upper-secondary English grade),
    // which we must not mistake for a GPA requirement.
    let value = null;
    if (betygskravRaw) {
      const numMatch = betygskravRaw.match(
        /^\(?\s*(?:minimikrav\s+(?:p[åa]|om)\s*)?([0-9]+(?:[.,][0-9]+)?)/i
      );
      if (numMatch) value = parseFloat(numMatch[1].replace(",", "."));
    }

    // When there's no formal Betygskrav number, some competitive schools
    // still mention a de-facto grade average within the Söktryck text
    // itself (e.g. "Krävs ofta höga snittbetyg (4,5 eller högre)") - use
    // that as a fallback guideline, never overriding a real Betygskrav.
    if (value === null && soktryckRaw) {
      const soktryckNum = soktryckRaw.match(/snittbetyg[^0-9]{0,20}([0-9]+(?:[.,][0-9]+)?)/i);
      if (soktryckNum) value = parseFloat(soktryckNum[1].replace(",", "."));
    }

    const parts = [];
    if (betygskravRaw) parts.push(`Betygskrav: ${firstSentence(betygskravRaw, 120)}`);
    if (soktryckRaw) parts.push(`Söktryck: ${firstSentence(soktryckRaw, 160)}`);

    return {
      value: Number.isFinite(value) ? value : null,
      snippet: parts.length ? parts.join(" · ") : null,
    };
  }

  async function fetchExchangeRequirement(url) {
    const html = await fetchKthPage(url);
    return parseRequirementFromPage(html);
  }

  // Required average grade on the remaining hp to land on `target` overall,
  // given what's already banked (weightedSum / totalHp so far).
  function computeRequiredAverage(weightedSum, totalHp, remainingHp, target) {
    if (!remainingHp || remainingHp <= 0) return null;
    return (target * (totalHp + remainingHp) - weightedSum) / remainingHp;
  }

  function closestGradeLabel(avg) {
    const entries = Object.entries(GRADE_POINTS)
      .filter(([k]) => k !== "FX")
      .sort((a, b) => a[1] - b[1]);
    for (const [label, points] of entries) {
      if (points >= avg) return label;
    }
    return null; // higher than an A - not achievable
  }

  // --- Whole-programme curriculum (for an automatic "hp kvar") ---
  // KTH's public course catalog (kth.se/student/kurser/program/{code}/{term})
  // embeds a JSON blob (window.__compressedApplicationStore__, URL-encoded)
  // with the full curriculum for that programme/admission-year edition. We
  // only count mandatory ("Valvillkor": "O") courses - electives are a
  // personal choice we have no way to predict from the generic curriculum.
  //
  // The embedded course list comes in two different shapes depending on the
  // edition: newer editions give a structured array per study year, while
  // older ones (observed for 2024 and earlier admissions) give a raw HTML
  // fragment per study year instead - a "Obligatoriska kurser" table under
  // an <h4 id="...obligatoriska...">. Both are handled below.

  function extractApplicationStore(html) {
    const m = html.match(/window\.__compressedApplicationStore__ = "(.*?)";/s);
    if (!m) return null;
    try {
      return JSON.parse(decodeURIComponent(m[1]));
    } catch (e) {
      return null;
    }
  }

  function parseMandatoryCoursesFromHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    // Anchored with "^=" rather than "*=" so a hypothetical "ickeobligatoriska"
    // (non-mandatory) heading id can never match this and get miscounted.
    const heading = doc.querySelector('[id^="obligatoriska"]');
    if (!heading) return [];
    let table = heading.nextElementSibling;
    while (table && table.tagName !== "TABLE") table = table.nextElementSibling;
    if (!table) return [];

    const courses = [];
    for (const tr of table.querySelectorAll("tbody tr")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 3) continue;
      const kod = cells[0].textContent.trim();
      const hp = parseFloat(cells[2].textContent.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (kod) courses.push({ kod, hp: Number.isFinite(hp) ? hp : 0 });
    }
    return courses;
  }

  function extractMandatoryCourses(studyYear) {
    const courses = studyYear.courses;
    if (Array.isArray(courses)) {
      return courses
        .filter((c) => c && c.kod && c.Valvillkor === "O")
        .map((c) => ({ kod: c.kod, hp: (c.omfattning && c.omfattning.number) || 0 }));
    }
    if (typeof courses === "string") return parseMandatoryCoursesFromHtml(courses);
    return [];
  }

  // Some published curriculum editions don't yet exist for a given
  // programme (e.g. a brand new admission year) - fall back to the closest
  // edition that isn't newer than the student's own, using the programme's
  // own list of published terms rather than guessing blindly.
  async function resolveAdmissionTerm(programCode, preferredTerm) {
    const cacheKey = `kthGpaProgramTerms:${programCode}`;
    let terms = null;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.timestamp < EXCHANGE_LIST_CACHE_TTL_MS) {
        terms = cached.terms;
      }
    } catch (e) {
      // Ignore corrupt/unavailable cache - just re-fetch.
    }

    if (!terms) {
      const html = await fetchKthPage(`${KTH_ORIGIN}/student/kurser/program/${encodeURIComponent(programCode)}`);
      const store = extractApplicationStore(html);
      terms = (store && store.programmeTerms) || []; // newest first
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), terms }));
      } catch (e) {
        // Ignore - caching is a nice-to-have.
      }
    }

    if (!terms.length) return preferredTerm;
    if (!preferredTerm) return terms[0]; // no admission-year signal at all - default to the newest edition
    if (terms.includes(preferredTerm)) return preferredTerm;
    const numeric = (t) => parseInt(t, 10);
    const notNewer = terms.filter((t) => numeric(t) <= numeric(preferredTerm));
    return notNewer[0] || terms[terms.length - 1];
  }

  async function fetchFutureCurriculum(programCode, preferredTerm) {
    const term = await resolveAdmissionTerm(programCode, preferredTerm);
    const cacheKey = `kthGpaCurriculum:${programCode}:${term}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.timestamp < EXCHANGE_LIST_CACHE_TTL_MS) {
        return cached.data;
      }
    } catch (e) {
      // Ignore corrupt/unavailable cache - just re-fetch.
    }

    const sourceUrl = `${KTH_ORIGIN}/student/kurser/program/${encodeURIComponent(programCode)}/${term}`;
    const html = await fetchKthPage(sourceUrl);
    const store = extractApplicationStore(html);
    if (!store || !Array.isArray(store.curriculums) || !store.curriculums.length) {
      throw new Error("Kunde inte tolka utbildningsplanen på kth.se");
    }

    // Only the first (common/default) curriculum track is used - a program
    // with multiple named specializations may have more than one, but we
    // have no way to know which one the student will actually follow.
    const curriculum = store.curriculums[0];
    const byKod = new Map();
    for (const studyYear of curriculum.studyYears || []) {
      for (const c of extractMandatoryCourses(studyYear)) {
        if (!byKod.has(c.kod)) byKod.set(c.kod, c.hp);
      }
    }

    const courses = Array.from(byKod, ([kod, hp]) => ({ kod, hp }));
    if (!courses.length) {
      // A real curriculum always has some mandatory courses (at least in
      // year 1) - an empty result means our parsing didn't recognize this
      // page's structure, not that there's genuinely nothing left. Treat it
      // as a failure rather than silently reporting "0 hp kvar".
      throw new Error("Hittade inga obligatoriska kurser i utbildningsplanen");
    }

    const data = {
      term,
      sourceUrl,
      owningSchool: (store.owningSchoolCode || "").split("/")[0] || null,
      courses,
    };

    try {
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
    } catch (e) {
      // Ignore - caching is a nice-to-have.
    }

    return data;
  }

  // Total hp in the curriculum's mandatory courses the student hasn't
  // already started (matched by course code against their own Ladok
  // course list) - i.e. what's actually still ahead of them.
  function remainingCurriculumHp(curriculum, startedCourseCodes) {
    if (!curriculum) return null;
    let total = 0;
    for (const c of curriculum.courses) {
      if (!startedCourseCodes.has(c.kod)) total += c.hp;
    }
    return total;
  }

  // --- Widget UI ---

  function buildProgramPicker(programs, selectedId, disabled) {
    const select = document.createElement("select");
    select.className = "kgw-picker";
    select.disabled = !!disabled;
    for (const p of programs) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.label; // textContent - never trust API text as HTML
      if (p.id === selectedId) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => selectProgram(select.value));
    return select;
  }

  function renderWidget(state) {
    if (!widgetEl) {
      widgetEl = document.createElement("div");
      widgetEl.id = "kth-gpa-widget";
      document.body.appendChild(widgetEl);
    }

    const showPicker = state.programs && state.programs.length > 1;

    widgetEl.innerHTML = `
      <div class="kgw-card">
        <div class="kgw-title">Ditt GPA</div>
        <div class="kgw-picker-slot"></div>
        <div class="kgw-body"></div>
        <div class="kgw-breakdown-slot"></div>
        <div class="kgw-history-slot"></div>
        <div class="kgw-efficiency-slot"></div>
      </div>
    `;

    if (showPicker) {
      const slot = widgetEl.querySelector(".kgw-picker-slot");
      slot.appendChild(
        buildProgramPicker(state.programs, state.selectedId, state.status === "loading")
      );
    }

    const body = widgetEl.querySelector(".kgw-body");

    if (state.status === "loading") {
      body.innerHTML = '<div class="kgw-loading">Räknar ut...</div>';
      return;
    }

    if (state.status === "error") {
      const err = document.createElement("div");
      err.className = "kgw-error";
      err.textContent = state.message;
      body.innerHTML = "";
      body.appendChild(err);
      return;
    }

    const r = state.result;
    const weighted = r.weightedGPA !== null ? r.weightedGPA.toFixed(2) : "–";
    const unweighted = r.unweightedGPA !== null ? r.unweightedGPA.toFixed(2) : "–";

    const metaParts = [`${r.gradedCount} avklarade kurser`, `${r.totalHp} hp`];
    if (r.passCount) metaParts.push(`${r.passCount} Pass`);
    if (r.ongoingCount) metaParts.push(`${r.ongoingCount} pågående`);
    if (r.errorCount) metaParts.push(`${r.errorCount} kunde inte hämtas`);
    if (r.unknownCount) metaParts.push(`${r.unknownCount} okänd betygskod`);

    body.innerHTML = `
      <div class="kgw-row"><span>Viktat</span><strong>${weighted}</strong></div>
      <div class="kgw-row"><span>Oviktat</span><strong>${unweighted}</strong></div>
      <div class="kgw-meta">${metaParts.join(" · ")}</div>
    `;

    renderCourseBreakdown(widgetEl.querySelector(".kgw-breakdown-slot"));
    renderGpaHistory(widgetEl.querySelector(".kgw-history-slot"));
    renderEfficiencySection(widgetEl.querySelector(".kgw-efficiency-slot"));
  }

  // --- Per-course breakdown ---
  // Lists every course counted (or not counted, with why) in the GPA, and
  // for graded courses, exactly how much of the weighted average it
  // contributes - these contributions sum to the weighted GPA shown above,
  // by construction.

  function buildCourseBreakdown(courses, totalHp) {
    return courses
      .map((c) => {
        const hp = parseFloat(c.hp) || 0;
        let kind;
        let contribution = null;

        if (c.status) {
          kind = "error";
        } else if (!c.betyg) {
          kind = "ongoing";
        } else if (c.betyg === "P") {
          kind = "pass";
        } else {
          const points = gradePoints(c.betyg);
          if (points === undefined) {
            kind = "unknown";
          } else {
            kind = "graded";
            contribution = totalHp > 0 ? (points * hp) / totalHp : null;
          }
        }

        return { kurskod: c.kurskod, betyg: c.betyg, hp, kind, contribution };
      })
      .sort((a, b) => a.kurskod.localeCompare(b.kurskod, "sv"));
  }

  function describeBreakdownItem(c) {
    const hpText = `${c.hp} hp`;
    switch (c.kind) {
      case "graded":
        return `${c.kurskod} — ${c.betyg} (${hpText}) — bidrar med ${c.contribution.toFixed(
          3
        )} till viktat snitt`;
      case "pass":
        return `${c.kurskod} — P (${hpText}) — räknas inte in i snittet`;
      case "ongoing":
        return `${c.kurskod} — pågående (${hpText})`;
      case "unknown":
        return `${c.kurskod} — okänd betygskod (${c.betyg}, ${hpText})`;
      case "error":
        return `${c.kurskod} — kunde inte hämta betyget`;
      default:
        return c.kurskod;
    }
  }

  function renderCourseBreakdown(slot) {
    if (!slot) return;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "kgw-toggle";
    toggle.textContent = courseBreakdownOpen ? "▾ Kursuppdelning" : "▸ Kursuppdelning";
    toggle.addEventListener("click", () => {
      courseBreakdownOpen = !courseBreakdownOpen;
      renderCourseBreakdown(slot);
    });

    slot.innerHTML = "";
    slot.appendChild(toggle);

    if (!courseBreakdownOpen) return;

    const panel = document.createElement("div");
    panel.className = "kgw-breakdown-panel";
    slot.appendChild(panel);

    const breakdown = buildCourseBreakdown(
      currentCourses,
      currentResult ? currentResult.totalHp : 0
    );

    if (!breakdown.length) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent = "Inga kurser hittades.";
      panel.appendChild(p);
      return;
    }

    const list = document.createElement("ul");
    list.className = "kgw-breakdown-list";
    for (const c of breakdown) {
      const li = document.createElement("li");
      li.textContent = describeBreakdownItem(c); // textContent - never trust API text as HTML
      list.appendChild(li);
    }
    panel.appendChild(list);
  }

  // --- GPA-history panel ---

  function buildSparklineSvg(entries) {
    const width = 220;
    const height = 50;
    const values = entries.map((e) => e.weightedGPA);
    const points = sparklinePoints(values, width, height);

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(height));
    svg.classList.add("kgw-sparkline");

    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#1954a6");
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);

    const [lastX, lastY] = points[points.length - 1];
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", String(lastX));
    dot.setAttribute("cy", String(lastY));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", "#1954a6");
    svg.appendChild(dot);

    return svg;
  }

  function renderGpaHistory(slot) {
    if (!slot) return;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "kgw-toggle";
    toggle.textContent = historyPanelOpen ? "▾ GPA-historik" : "▸ GPA-historik";
    toggle.addEventListener("click", () => {
      historyPanelOpen = !historyPanelOpen;
      renderGpaHistory(slot);
    });

    slot.innerHTML = "";
    slot.appendChild(toggle);

    if (!historyPanelOpen) return;

    const panel = document.createElement("div");
    panel.className = "kgw-history-panel";
    slot.appendChild(panel);

    const store = readGpaHistoryStore();
    const entries = store[currentSelectedProgramId] || [];

    if (entries.length < 2) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent =
        "Ditt snitt sparas en gång per dag för det här programmet - kom tillbaka en annan dag för att se en trend.";
      panel.appendChild(p);
      return;
    }

    panel.appendChild(buildSparklineSvg(entries));

    const list = document.createElement("ul");
    list.className = "kgw-history-list";
    for (const e of entries.slice(-10).reverse()) {
      const li = document.createElement("li");
      li.textContent =
        e.unweightedGPA !== null
          ? `${e.date}: viktat ${e.weightedGPA.toFixed(2)}, oviktat ${e.unweightedGPA.toFixed(2)}`
          : `${e.date}: viktat ${e.weightedGPA.toFixed(2)}`;
      list.appendChild(li);
    }
    panel.appendChild(list);
  }

  // --- "Effektivisera ditt GPA" panel ---

  function renderEfficiencySection(slot) {
    if (!slot) return;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "kgw-toggle";
    toggle.textContent = efficiencyPanelOpen
      ? "▾ Effektivisera ditt GPA"
      : "▸ Effektivisera ditt GPA";
    toggle.addEventListener("click", () => {
      efficiencyPanelOpen = !efficiencyPanelOpen;
      renderEfficiencySection(slot);
    });

    slot.innerHTML = "";
    slot.appendChild(toggle);

    if (!efficiencyPanelOpen) return;

    const panel = document.createElement("div");
    panel.className = "kgw-efficiency-panel";
    slot.appendChild(panel);

    renderRetakeList(panel);
    renderWhatIfCalculator(panel);
    renderExchangeComparison(panel);
  }

  function renderRetakeList(panel) {
    const section = document.createElement("div");
    section.className = "kgw-subsection";

    const heading = document.createElement("div");
    heading.className = "kgw-subheading";
    heading.textContent = "Mest effektiva omtentor";
    section.appendChild(heading);

    const candidates = rankRetakeCandidates(
      currentCourses,
      currentResult ? currentResult.totalHp : 0
    );

    if (!candidates.length) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent = "Inga kurser under högsta betyg hittades att räkna på.";
      section.appendChild(p);
    } else {
      const list = document.createElement("ul");
      list.className = "kgw-retake-list";
      for (const c of candidates) {
        const li = document.createElement("li");
        li.textContent = `${c.kurskod} (${c.betyg}, ${c.hp} hp) — högre betyg (A) ger +${c.potentialGain.toFixed(
          3
        )} i viktat snitt`;
        list.appendChild(li);
      }
      section.appendChild(list);

      const note = document.createElement("div");
      note.className = "kgw-hint";
      note.textContent =
        "Förutsätter att kursen tillåter omexamination för högre betyg - kolla kursplanen/examinatorn för just den kursen.";
      section.appendChild(note);
    }

    panel.appendChild(section);
  }

  function renderWhatIfCalculator(panel) {
    const slot = panel.parentElement;
    const section = document.createElement("div");
    section.className = "kgw-subsection";

    const heading = document.createElement("div");
    heading.className = "kgw-subheading";
    heading.textContent = "Vad-om-kalkylator";
    section.appendChild(heading);

    const hint = document.createElement("div");
    hint.className = "kgw-hint";
    hint.textContent = "Testa hypotetiska betyg på valfria kurser och se hur ditt snitt påverkas.";
    section.appendChild(hint);

    const eligibleCourses = currentCourses.filter((c) => c.kurskod);
    const usedElsewhere = (excludeId) =>
      new Set(
        whatIfRows.filter((r) => r.id !== excludeId && r.kurskod).map((r) => r.kurskod)
      );

    for (const row of whatIfRows) {
      const rowEl = document.createElement("div");
      rowEl.className = "kgw-whatif-row";

      const used = usedElsewhere(row.id);
      const courseSelect = document.createElement("select");
      courseSelect.className = "kgw-whatif-course";
      const coursePlaceholder = document.createElement("option");
      coursePlaceholder.value = "";
      coursePlaceholder.textContent = "Välj kurs";
      courseSelect.appendChild(coursePlaceholder);
      for (const c of eligibleCourses) {
        if (used.has(c.kurskod)) continue;
        const opt = document.createElement("option");
        opt.value = c.kurskod;
        opt.textContent = `${c.kurskod} (nu: ${currentGradeLabel(c)})`; // textContent - never trust API text as HTML
        if (c.kurskod === row.kurskod) opt.selected = true;
        courseSelect.appendChild(opt);
      }
      courseSelect.addEventListener("change", () => {
        row.kurskod = courseSelect.value || null;
        renderEfficiencySection(slot);
      });
      rowEl.appendChild(courseSelect);

      const gradeSelect = document.createElement("select");
      gradeSelect.className = "kgw-whatif-grade";
      const gradePlaceholder = document.createElement("option");
      gradePlaceholder.value = "";
      gradePlaceholder.textContent = "Betyg";
      gradeSelect.appendChild(gradePlaceholder);
      for (const g of ["A", "B", "C", "D", "E", "F"]) {
        const opt = document.createElement("option");
        opt.value = g;
        opt.textContent = g;
        if (g === row.betyg) opt.selected = true;
        gradeSelect.appendChild(opt);
      }
      gradeSelect.addEventListener("change", () => {
        row.betyg = gradeSelect.value || null;
        renderEfficiencySection(slot);
      });
      rowEl.appendChild(gradeSelect);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "kgw-whatif-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", "Ta bort");
      removeBtn.addEventListener("click", () => {
        whatIfRows = whatIfRows.filter((r) => r.id !== row.id);
        renderEfficiencySection(slot);
      });
      rowEl.appendChild(removeBtn);

      section.appendChild(rowEl);
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "kgw-link-button";
    addBtn.textContent = "+ Lägg till kurs";
    addBtn.disabled = whatIfRows.length >= eligibleCourses.length;
    addBtn.addEventListener("click", () => {
      whatIfRows.push({ id: whatIfNextRowId++, kurskod: null, betyg: null });
      renderEfficiencySection(slot);
    });
    section.appendChild(addBtn);

    const activeOverrides = whatIfRows.filter((r) => r.kurskod && r.betyg);
    if (activeOverrides.length && currentResult) {
      const hypResult = calculateGPA(applyWhatIfOverrides(currentCourses, activeOverrides));
      const weightedText = hypResult.weightedGPA !== null ? hypResult.weightedGPA.toFixed(2) : "–";
      const unweightedText =
        hypResult.unweightedGPA !== null ? hypResult.unweightedGPA.toFixed(2) : "–";

      let deltaText = "";
      if (currentResult.weightedGPA !== null && hypResult.weightedGPA !== null) {
        const delta = hypResult.weightedGPA - currentResult.weightedGPA;
        deltaText = ` (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`;
      }

      const result = document.createElement("div");
      result.className = "kgw-result";
      result.textContent = `Nytt snitt om detta slår in: viktat ${weightedText}${deltaText}, oviktat ${unweightedText}`;
      section.appendChild(result);
    }

    panel.appendChild(section);
  }

  function renderExchangeComparison(panel) {
    const slot = panel.parentElement;
    const section = document.createElement("div");
    section.className = "kgw-subsection";

    const heading = document.createElement("div");
    heading.className = "kgw-subheading";
    heading.textContent = "Mål: utbytesstudier";
    section.appendChild(heading);

    // Figures out which of the 5 KTH schools the current program belongs to
    // - only that school's partner universities are actually selectable for
    // exchange, so we filter before showing any of them. The curriculum
    // fetch (below) states this directly and exactly, so it's the only
    // source used whenever it's available; the name-matching guess is only
    // a fallback for when the curriculum can't be found at all (e.g. a
    // combined/basår option with no single program code). We deliberately
    // never apply the weaker guess while the curriculum fetch is still
    // in flight - showing it and then silently swapping to a different
    // school once the real answer arrives would leave a university already
    // picked for the wrong school still selected.
    const applySkola = (skola) => {
      if (exchangeSelection.skola && !exchangeSelection.skolaAutoDetected) return; // never override a manual choice
      if (skola === exchangeSelection.skola) return;
      exchangeSelection.skola = skola;
      exchangeSelection.skolaAutoDetected = true;
      exchangeSelection.schoolUrl = "";
      exchangeSelection.target = null;
      exchangeSelection.snippet = null;
      exchangeSelection.error = null;
      exchangeSchools = null;
      exchangeSchoolsForSkola = null;
    };

    const curriculumKey = currentProgramCode ? `${currentProgramCode}:${currentAdmissionTerm}` : null;
    const curriculumSettled = !curriculumKey || futureCurriculumKey === curriculumKey;
    const curriculumGaveNoSchool = curriculumSettled && !(futureCurriculum && futureCurriculum.owningSchool);

    if (
      !exchangeSelection.skola &&
      curriculumGaveNoSchool &&
      !exchangeSchoolMap &&
      !exchangeSchoolMapLoading
    ) {
      exchangeSchoolMapLoading = true;
      loadProgramSchoolMap()
        .then((rows) => {
          exchangeSchoolMap = rows;
          if (!exchangeSelection.skola) {
            const guess = guessSchoolForProgram(currentProgramLabel, rows);
            if (guess) applySkola(guess);
          }
        })
        .catch((e) => {
          exchangeSchoolMap = [];
          console.error("[KTH GPA widget] Could not load KTH's program→school table", e);
        })
        .finally(() => {
          exchangeSchoolMapLoading = false;
          renderEfficiencySection(slot);
        });
    }

    // Also fetch the whole-programme curriculum (used below for an
    // automatic "hp kvar"), which is also the authoritative source for the
    // school above.
    if (curriculumKey && futureCurriculumKey !== curriculumKey && !futureCurriculumLoading) {
      futureCurriculumLoading = true;
      futureCurriculumError = null;
      fetchFutureCurriculum(currentProgramCode, currentAdmissionTerm)
        .then((data) => {
          futureCurriculum = data;
          futureCurriculumKey = curriculumKey;
          if (data.owningSchool) applySkola(data.owningSchool);
        })
        .catch((e) => {
          futureCurriculum = null;
          futureCurriculumKey = curriculumKey;
          futureCurriculumError = e.message;
          console.error("[KTH GPA widget] Could not load future curriculum", e);
        })
        .finally(() => {
          futureCurriculumLoading = false;
          renderEfficiencySection(slot);
        });
    }

    const awaitingAuthoritativeSkola = !exchangeSelection.skola && !curriculumSettled;

    // While the authoritative (curriculum-based) answer is still in flight
    // and we have no school yet, just say so - showing the weaker guess
    // here, only to swap it out a moment later, is exactly the confusing
    // "it keeps picking different schools" behavior this is meant to avoid.
    if (awaitingAuthoritativeSkola) {
      const waitingMsg = document.createElement("div");
      waitingMsg.className = "kgw-hint";
      waitingMsg.textContent = "Kollar vilken skola ditt program tillhör...";
      section.appendChild(waitingMsg);
      panel.appendChild(section);
      return;
    }

    // Once a school is known (auto-detected or manually chosen), show it as
    // a fixed line rather than an always-editable dropdown - it's
    // determined by your program, not a free choice. A small link reveals
    // the dropdown only if you actually need to override it.
    if (exchangeSelection.skola && !exchangeSelection.skolaOverrideOpen) {
      const line = document.createElement("div");
      line.className = "kgw-hint";
      const schoolText = `${exchangeSelection.skola} – ${KTH_SCHOOL_NAMES[exchangeSelection.skola] || ""}`;
      line.textContent = exchangeSelection.skolaAutoDetected
        ? `Din skola (utifrån ditt program): ${schoolText}`
        : `Vald skola: ${schoolText}`;
      section.appendChild(line);

      const overrideLink = document.createElement("button");
      overrideLink.type = "button";
      overrideLink.className = "kgw-link-button";
      overrideLink.textContent = "Fel skola? Byt manuellt";
      overrideLink.addEventListener("click", () => {
        exchangeSelection.skolaOverrideOpen = true;
        renderEfficiencySection(slot);
      });
      section.appendChild(overrideLink);
    } else {
      const skolaSelect = document.createElement("select");
      skolaSelect.className = "kgw-picker";

      const skolaPlaceholder = document.createElement("option");
      skolaPlaceholder.value = "";
      skolaPlaceholder.textContent = "Välj din KTH-skola";
      skolaSelect.appendChild(skolaPlaceholder);

      for (const code of Object.keys(KTH_SCHOOL_NAMES)) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = `${code} – ${KTH_SCHOOL_NAMES[code]}`;
        if (code === exchangeSelection.skola) opt.selected = true;
        skolaSelect.appendChild(opt);
      }

      skolaSelect.addEventListener("change", () => {
        exchangeSelection.skola = skolaSelect.value || null;
        exchangeSelection.skolaAutoDetected = false;
        exchangeSelection.skolaOverrideOpen = false;
        // A new school means the previously chosen partner university (if
        // any) no longer applies - reset everything downstream of it.
        exchangeSelection.schoolUrl = "";
        exchangeSelection.target = null;
        exchangeSelection.snippet = null;
        exchangeSelection.error = null;
        exchangeSchools = null;
        exchangeSchoolsForSkola = null;
        renderEfficiencySection(slot);
      });
      section.appendChild(skolaSelect);
    }

    if (!exchangeSelection.skola) {
      panel.appendChild(section);
      return;
    }

    // Step 2: now that we know the school, load and show only its partner
    // universities (never the other 4 schools' lists).
    const select = document.createElement("select");
    select.className = "kgw-picker";
    const schoolsLoading =
      exchangeSchoolsLoading && exchangeSchoolsForSkola !== exchangeSelection.skola;
    select.disabled = schoolsLoading;

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = schoolsLoading
      ? "Laddar skolor från kth.se..."
      : "Välj utbytesskola (valfritt)";
    select.appendChild(placeholder);

    if (exchangeSchools && exchangeSchoolsForSkola === exchangeSelection.skola) {
      for (const s of exchangeSchools) {
        const opt = document.createElement("option");
        opt.value = s.url;
        opt.textContent = s.name; // textContent - never trust fetched text as HTML
        if (s.url === exchangeSelection.schoolUrl) opt.selected = true;
        select.appendChild(opt);
      }
    }

    select.addEventListener("change", () => {
      exchangeSelection.schoolUrl = select.value;
      exchangeSelection.snippet = null;
      exchangeSelection.error = null;
      if (!select.value) {
        renderEfficiencySection(slot);
        return;
      }
      exchangeSelection.loadingRequirement = true;
      renderEfficiencySection(slot);
      fetchExchangeRequirement(select.value)
        .then(({ value, snippet }) => {
          exchangeSelection.target = value;
          exchangeSelection.snippet = snippet;
        })
        .catch((e) => {
          exchangeSelection.target = null;
          exchangeSelection.snippet = null;
          exchangeSelection.error = e.message;
          console.error("[KTH GPA widget] Could not fetch/parse", select.value, e);
        })
        .finally(() => {
          exchangeSelection.loadingRequirement = false;
          renderEfficiencySection(slot);
        });
    });
    section.appendChild(select);

    if (
      (!exchangeSchools || exchangeSchoolsForSkola !== exchangeSelection.skola) &&
      !exchangeSchoolsLoading
    ) {
      const skolaAtRequestTime = exchangeSelection.skola;
      exchangeSchoolsLoading = true;
      loadExchangeSchoolList(skolaAtRequestTime)
        .then((schools) => {
          exchangeSchools = schools;
          exchangeSchoolsForSkola = skolaAtRequestTime;
        })
        .catch((e) => {
          exchangeSchools = [];
          exchangeSchoolsForSkola = skolaAtRequestTime;
          console.error("[KTH GPA widget] Could not load partner list for", skolaAtRequestTime, e);
        })
        .finally(() => {
          exchangeSchoolsLoading = false;
          renderEfficiencySection(slot);
        });
    }

    if (exchangeSelection.loadingRequirement) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent = "Hämtar riktvärde från KTHs sida...";
      section.appendChild(p);
    } else if (exchangeSelection.schoolUrl) {
      const info = document.createElement("div");
      info.className = "kgw-hint";
      if (exchangeSelection.error) {
        info.textContent = `Kunde inte hämta sidan från kth.se (${exchangeSelection.error}) - ange ett eget mål nedan, eller försök igen.`;
      } else {
        info.textContent = exchangeSelection.snippet
          ? `Enligt KTH: ${exchangeSelection.snippet}`
          : "Inget angivet riktvärde hittades på KTHs sida för denna skola - ange ett eget mål nedan.";
      }
      section.appendChild(info);

      const link = document.createElement("a");
      link.href = exchangeSelection.schoolUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "kgw-source-link";
      link.textContent = "Källa på kth.se ↗";
      section.appendChild(link);
    }

    const targetRow = document.createElement("label");
    targetRow.className = "kgw-field";
    targetRow.appendChild(document.createTextNode("Mål-snitt (0-5): "));
    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.step = "0.1";
    targetInput.min = "0";
    targetInput.max = "5";
    targetInput.className = "kgw-input";
    if (exchangeSelection.target !== null && exchangeSelection.target !== undefined) {
      targetInput.value = exchangeSelection.target;
    }
    targetInput.addEventListener("change", () => {
      const v = parseFloat(targetInput.value.replace(",", "."));
      exchangeSelection.target = Number.isFinite(v) ? v : null;
      renderEfficiencySection(slot);
    });
    targetRow.appendChild(targetInput);
    section.appendChild(targetRow);

    const startedCourseCodes = new Set(currentCourses.map((c) => c.kurskod));
    const curriculumHp =
      futureCurriculum && futureCurriculumKey === curriculumKey
        ? remainingCurriculumHp(futureCurriculum, startedCourseCodes)
        : null;
    const ongoingHp = currentResult ? currentResult.ongoingHp : 0;
    const autoHp = curriculumHp !== null ? curriculumHp : ongoingHp;
    const autoHpLabel =
      curriculumHp !== null
        ? `enligt utbildningsplanen`
        : `${ongoingHp} pågående`;

    const hpRow = document.createElement("label");
    hpRow.className = "kgw-field";
    hpRow.appendChild(document.createTextNode(`Hp kvar (auto: ${autoHp} ${autoHpLabel}): `));
    const hpInput = document.createElement("input");
    hpInput.type = "number";
    hpInput.min = "0";
    hpInput.step = "1";
    hpInput.className = "kgw-input";
    hpInput.placeholder = String(autoHp);
    if (exchangeSelection.hpOverride !== null && exchangeSelection.hpOverride !== undefined) {
      hpInput.value = exchangeSelection.hpOverride;
    }
    hpInput.addEventListener("change", () => {
      const v = parseFloat(hpInput.value);
      exchangeSelection.hpOverride = Number.isFinite(v) && v > 0 ? v : null;
      renderEfficiencySection(slot);
    });
    hpRow.appendChild(hpInput);
    section.appendChild(hpRow);

    if (futureCurriculumLoading) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent = "Hämtar din utbildningsplan från kth.se...";
      section.appendChild(p);
    } else if (curriculumHp !== null) {
      const info = document.createElement("div");
      info.className = "kgw-hint";
      info.textContent = `Baserat på KTHs offentliga utbildningsplan (antagning ${futureCurriculum.term}) minus dina redan påbörjade kurser - obligatoriska kurser räknas, valfria inte. Kan skilja sig något från din egen plan.`;
      section.appendChild(info);

      const curriculumLink = document.createElement("a");
      curriculumLink.href = futureCurriculum.sourceUrl;
      curriculumLink.target = "_blank";
      curriculumLink.rel = "noopener noreferrer";
      curriculumLink.className = "kgw-source-link";
      curriculumLink.textContent = "Utbildningsplan på kth.se ↗";
      section.appendChild(curriculumLink);
    } else if (futureCurriculumError) {
      const p = document.createElement("div");
      p.className = "kgw-hint";
      p.textContent = `Kunde inte hämta hela utbildningsplanen (${futureCurriculumError}) - endast pågående kurser räknas automatiskt ovan.`;
      section.appendChild(p);
    }

    const result = document.createElement("div");
    result.className = "kgw-result";

    if (currentResult && exchangeSelection.target !== null && exchangeSelection.target !== undefined) {
      const remainingHp = exchangeSelection.hpOverride || autoHp;
      if (!remainingHp) {
        result.textContent =
          "Inga pågående kurser hittades och inget eget hp-värde är angivet - fyll i \"Hp kvar\" för att räkna.";
      } else {
        const weightedSum = (currentResult.weightedGPA || 0) * currentResult.totalHp;
        const required = computeRequiredAverage(
          weightedSum,
          currentResult.totalHp,
          remainingHp,
          exchangeSelection.target
        );
        if (required <= 0) {
          result.textContent = `Du når redan målet (${exchangeSelection.target}) även med lägsta godkända betyg på återstoden.`;
        } else if (required > GRADE_POINTS.A) {
          result.textContent = `Inte möjligt att nå ${exchangeSelection.target} på bara ${remainingHp} hp - det skulle kräva snitt ${required.toFixed(
            2
          )}, högre än A (5.0). Fler hp eller ett bättre nuvarande snitt behövs.`;
        } else {
          const label = closestGradeLabel(required);
          result.textContent = `Du behöver i snitt minst ${required.toFixed(
            2
          )} (≈ betyg ${label}) på dina återstående ${remainingHp} hp för att nå ${exchangeSelection.target}.`;
        }
      }
    } else if (currentResult) {
      result.textContent = "Ange ett mål-snitt ovan för att räkna ut vägen dit.";
    }
    section.appendChild(result);

    panel.appendChild(section);
  }

  // --- Main flow ---

  // Bumped on every selectProgram call so a slower, stale in-flight request
  // (e.g. from a program the user already switched away from) can detect
  // it's no longer current and skip rendering its result over a newer one.
  let selectionToken = 0;

  async function selectProgram(programId) {
    const option = currentOptions.find((o) => o.id === programId) || currentOptions[0];
    setStoredProgramId(option.id);

    const token = ++selectionToken;
    renderWidget({ status: "loading", programs: currentOptions, selectedId: option.id });

    try {
      const courseDataList = await Promise.all(
        option.nodes.map((node) => fetchProgramCourses(node, currentProxyId))
      );
      const kurser = courseDataList.flatMap((cd) => cd.Tillfallesdeltaganden || []);
      const gradePromises = kurser.map((k) => fetchGradeForCourse(k, currentProxyId));
      const courses = await Promise.all(gradePromises);
      const result = calculateGPA(courses);
      if (token !== selectionToken) return; // a newer selection has since started
      currentCourses = courses;
      currentResult = result;
      currentSelectedProgramId = option.id;
      recordGpaHistoryEntry(option.id, result);
      if (currentProgramLabel !== option.label) {
        // A different program means the previously guessed/chosen KTH
        // school (and everything picked under it) no longer applies.
        currentProgramLabel = option.label;
        currentProgramCode =
          option.nodes.length === 1 ? option.nodes[0].Utbildningsinformation.Utbildningskod : null;
        currentAdmissionTerm = currentProgramCode ? inferAdmissionTerm(kurser) : null;
        exchangeSelection.skola = null;
        exchangeSelection.skolaAutoDetected = false;
        exchangeSelection.skolaOverrideOpen = false;
        exchangeSelection.schoolUrl = "";
        exchangeSelection.target = null;
        exchangeSelection.snippet = null;
        exchangeSchools = null;
        exchangeSchoolsForSkola = null;
        futureCurriculum = null;
        futureCurriculumKey = null;
        futureCurriculumError = null;
        whatIfRows = [];
      }
      renderWidget({
        status: "done",
        result,
        programs: currentOptions,
        selectedId: option.id,
      });
    } catch (e) {
      if (token !== selectionToken) return;
      renderWidget({
        status: "error",
        message: "Något gick fel: " + e.message,
        programs: currentOptions,
        selectedId: option.id,
      });
    }
  }

  async function run() {
    renderWidget({ status: "loading" });

    try {
      const studentUID = await waitForValue(STUDENT_UID_REGEX);
      if (!studentUID) {
        renderWidget({
          status: "error",
          message: "Kunde inte hitta ditt studentUID. Ladda om sidan och försök igen.",
        });
        return;
      }

      const proxyId = await waitForValue(PROXY_REGEX);
      if (!proxyId) {
        renderWidget({
          status: "error",
          message: "Kunde inte hitta Ladoks proxy-id. Ladda om sidan och försök igen.",
        });
        return;
      }
      currentProxyId = proxyId;

      const structData = await fetchStudiestruktur(studentUID, proxyId);
      const allPrograms = findAllPrograms(structData);
      if (!allPrograms.length) {
        renderWidget({ status: "error", message: "Kunde inte hitta något program." });
        return;
      }
      currentOptions = buildSelectableOptions(allPrograms);

      const defaultId = getDefaultProgramId(allPrograms);
      await selectProgram(getStoredProgramId(currentOptions, defaultId));
    } catch (e) {
      renderWidget({ status: "error", message: "Något gick fel: " + e.message });
    }
  }

  // Only run on the "Min utbildning" pages, and re-run if the single-page
  // app navigates there later without a full page reload.
  function shouldRun() {
    return location.pathname.includes("min-utbildning");
  }

  let lastPath = location.pathname;
  if (shouldRun()) run();

  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (shouldRun()) run();
    }
  }, 1000);

  // Exposed for the test suite only - `module` doesn't exist when this file
  // is loaded as a browser content script, so this branch never runs there.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      gradePoints,
      calculateGPA,
      rankRetakeCandidates,
      dateKeyForDate,
      upsertHistoryEntry,
      sparklinePoints,
      currentGradeLabel,
      applyWhatIfOverrides,
      buildCourseBreakdown,
      describeBreakdownItem,
      computeRequiredAverage,
      closestGradeLabel,
      parseRequirementFromPage,
      firstSentence,
      parsePartnerLinks,
      parseHubTable,
      normalizeProgramText,
      guessSchoolForProgram,
      parseMandatoryCoursesFromHtml,
      extractMandatoryCourses,
      extractApplicationStore,
      remainingCurriculumHp,
      inferAdmissionTerm,
      programLabel,
      findAllPrograms,
      buildSelectableOptions,
      getDefaultProgramId,
    };
  }
})();
