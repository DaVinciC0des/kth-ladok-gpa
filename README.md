# KTH Ladok GPA

[![Tests](https://github.com/DaVinciC0des/kth-ladok-gpa/actions/workflows/test.yml/badge.svg)](https://github.com/DaVinciC0des/kth-ladok-gpa/actions/workflows/test.yml)

A browser extension (Manifest V3) that shows your weighted and unweighted GPA
directly on Ladok's "Min utbildning" page, based on completed courses in a
program you choose.

## What it does

- Lists your programs and lets you pick which one to calculate GPA for if
  you're enrolled in more than one; your choice is remembered for next time.
  Basår (preparatory year) is excluded by default, but shows up as its own
  choice, and - when you also have another program - as an
  "Alla program (inkl. basår)" option that combines everything into one GPA.
- Fetches your grades for every course in the selected program via Ladok's
  internal API, routed through the same same-origin proxy Ladok's own web
  app uses (so it respects Ladok's Content Security Policy and never
  bypasses any authentication - it only reads data for the session you're
  already logged into, with MFA completed as normal).
- Calculates GPA using KTH's official grade-point scale (A=5, B=4.5, C=4,
  D=3.5, E=3, F=0). Any final grade A-F counts as a completed course; only
  Pass/Fail ("P") courses and courses still in progress are excluded from
  the average. Courses whose grade couldn't be fetched are also shown
  separately, as errors, rather than being counted as ongoing.
- Shows the result as a small floating widget on the page.
- Under "GPA-historik" (collapsed by default): snapshots your weighted and
  unweighted GPA into `localStorage` each time the widget runs, keyed per
  program and capped to one point per calendar day (so recalculating
  several times in one day just updates that day's point instead of
  spamming the trend), and plots the weighted GPA as a small sparkline plus
  a list of the last 10 recorded days. Needs at least two different days of
  data before there's anything to show.
- Under "Kursuppdelning" (collapsed by default): lists every course counted
  (or not, with why - Pass, ongoing, couldn't be fetched, or an unrecognized
  grade code) with its grade and hp, and for each graded course, exactly how
  much of the weighted GPA it contributes (these contributions sum to the
  weighted GPA shown above, by construction).
- Under "Effektivisera ditt GPA" (collapsed by default):
  - Ranks your already-completed courses by how much re-examining each one
    for an A would move your overall weighted GPA - highest hp × biggest
    grade gap first. This assumes the course allows re-examination for a
    higher grade, which is common at KTH but not guaranteed for every
    course - check the course's own rules before counting on it.
  - A "Vad-om"-calculator generalizes this to any hypothetical grade on any
    course - already graded (simulating a retake) or still ongoing
    (simulating the upcoming exam result) - letting you add several at once
    and see the resulting whole-programme weighted/unweighted GPA live,
    alongside the change from your current GPA.
  - First figures out which of KTH's 5 schools (ABE/CBH/EECS/ITM/SCI) your
    program belongs to - by matching your program's name against KTH's own
    published program→school tables (fetched live, in both Swedish and
    English so it recognizes a program label in either) - since exchange
    places are allocated per school and a program under one school can't
    apply to another school's partner universities. Only asks you to pick
    your school yourself when nothing at all matches; when a name matches
    more than one row it trusts the most specific one rather than giving
    up. You can always correct the guess.
  - Lets you pick a KTH exchange partner university from *only your
    school's* real partner list (fetched live from KTH's own site) and see
    the grade-average guideline stated on
    *that university's own KTH page*, quoted verbatim with a source link -
    never a hardcoded number, since KTH doesn't publish a fixed cutoff per
    school (exchange places are allocated by relative ranking of that
    year's applicants, not a fixed threshold). If no guideline is found on
    the page, or you'd rather use your own number, you can type in a target
    manually. Given that target and your remaining hp, it tells you the
    average grade you'd need on the rest to get there.
  - "Hp kvar" is auto-filled from your *whole remaining curriculum*, not
    just courses you've already started: it fetches your programme's public
    curriculum from KTH's course catalog (kth.se/student/kurser/program/...),
    sums the mandatory ("obligatoriska") courses across every study year,
    and subtracts the ones you've already started - electives are left out
    since we can't predict which ones you'll pick. It figures out your own
    admission-year curriculum edition from the earliest start date among
    your started courses (no manual input needed), and falls back to the
    closest older published edition if yours isn't available yet. You can
    still type your own number over it. This also states the programme's
    owning school directly, which is used (and preferred over the
    name-matching guess above) when available.

## How it works technically

The extension never touches your password, MFA code, or any credentials. It
runs as a content script inside the page you're already logged into, and
only calls the same internal REST endpoints the Ladok web app itself calls -
using your existing session cookie, exactly like a normal page request.

Your student UID and the institution's internal proxy id are both discovered
automatically from requests the page itself has already made (via the
`Performance` API), so nothing is hardcoded to one specific student or
institution.

The exchange-studies comparison additionally fetches public pages from
`www.kth.se` (no credentials sent) to get the real, current list of partner
universities and each one's own stated guideline text - this is the only
part of the extension that talks to a site other than Ladok, which is why
`https://www.kth.se/*` is a separate host permission. That HTML structure
isn't officially documented, so if KTH redesigns those pages this feature
may need updating (the GPA calculation itself is unaffected).

These kth.se fetches run in a small background service worker
(`background.js`) rather than directly in the content script. A content
script's own network requests execute inside Ladok's page and are subject
to Ladok's Content-Security-Policy (the same reason the Ladok API calls
themselves are routed through the same-origin proxy), which silently blocks
a direct cross-origin fetch to kth.se. The service worker isn't part of any
page and isn't bound by any page's CSP, so it does the fetch and hands the
HTML back to the content script over `chrome.runtime.sendMessage`.

## Install (development / unpacked)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable "Developer mode".
3. Click "Load unpacked" and select this folder.
4. Open Ladok and go to "Min utbildning" - the widget should appear in the
   bottom-right corner within a few seconds.

## Known limitations (v0.1)

- Only tested against KTH's Ladok instance so far.
- If the student UID or the proxy id isn't found within ~15 seconds each
  (e.g. a very fast page load before any relevant request has fired yet),
  the widget shows an error asking the user to reload.
- No caching yet - recalculates on every page load, and again whenever you
  switch program in the picker.
- Programs are shown even if they're no longer your "active" one (Ladok's
  API doesn't reliably expose that), so old/finished programs may appear in
  the picker alongside your current one.
- The exchange guideline is read from the "Betygskrav:" / "Söktryck:" fields
  every partner university's KTH page states under "Utbytesmöjligheter" -
  shown together (e.g. "Betygskrav: Nej · Söktryck: Lägre söktryck."), with
  a number taken from Betygskrav when it gives one, or otherwise from a
  grade average mentioned in the Söktryck text itself (e.g. "Krävs ofta
  höga snittbetyg (4,5 eller högre)"). A page that doesn't use this exact
  wording will just show no guideline was found (use the manual target
  field in that case). The partner-university list itself is cached for
  24h in `localStorage` to avoid re-fetching KTH's pages on every load.
- The program→school auto-detection matches against KTH's published Swedish
  and English program names; it only gives up (asking you to pick your
  school) when your program's label doesn't resemble either. When several
  rows match, it goes with the most specific one rather than asking - this
  is usually right but isn't guaranteed, so double-check the "vald
  automatiskt"-hint's pick if something looks off.
- The whole-curriculum "hp kvar" only counts the *first* listed curriculum
  track for your programme - some programmes branch into several named
  specializations with different electives in later years, and we have no
  way to know which one you'll follow, so a program like that may show a
  mandatory-course total that doesn't quite match your own path. It also
  reads an internal, undocumented data blob KTH's course-catalog pages embed
  (`window.__compressedApplicationStore__`) in one of two shapes depending
  on the admission year (a structured list for newer editions, an HTML
  table for editions from 2024 and earlier) - if KTH changes this, the
  feature may silently fall back to "no curriculum found" until updated.

## Testing

A [Vitest](https://vitest.dev) suite covers the GPA math and the KTH/Ladok
parsing logic (grade-point scale, weighted/unweighted GPA, retake ranking,
the what-if calculator's grade-override logic, the per-course breakdown's
contribution math and text formatting, the GPA-history date-keying/upsert
logic and sparkline coordinate math, the
"Betygskrav"/"Söktryck" exchange-requirement parser, program→school
table parsing, curriculum-page parsing, admission-term inference, and the
program picker's basår/combined-option logic). `content.js` exports these
pure functions to `module.exports` in a block that only runs under Node
(`typeof module !== "undefined"`), so it's a no-op when loaded as a browser
content script.

```
npm install
npm test          # run once
npm run test:watch  # re-run on file changes
```

This doesn't cover the widget's DOM rendering or the live `fetch`/`chrome.runtime`
calls - those still need manual testing against a real Ladok/kth.se session.

## Roadmap

Next up (highest value for the effort, discussed 2026-09-13):

- [x] A small test suite (e.g. Vitest) for the GPA math and the KTH/Ladok
      parsing logic, so regressions get caught automatically instead of by
      hand like during development so far.
- [x] Per-course breakdown in the widget (expandable) - list every course
      with grade/hp and its contribution to the GPA.

Also discussed, not yet prioritized:

- [x] "Vad-om"-calculator - let the student type hypothetical grades for
      specific upcoming courses and see the resulting GPA live, generalizing
      the existing retake-impact ranking.
- [x] GPA history/trend - snapshot the computed GPA (in `localStorage`) each
      time the widget runs, and plot it over time.
- [x] CI (GitHub Actions) running the test suite on every push/PR to `main`.
- [ ] README screenshots/GIF of the widget in action.
- [ ] Publish to the Chrome Web Store (even unlisted) instead of only
      "load unpacked".
- [ ] Cache results (with a manual refresh button) to avoid re-fetching on
      every load.
- [ ] Settings: choose which GPA definition to show (KTH-official vs.
      completed-only, weighted vs. unweighted).
- [ ] Test against other Ladok institutions.
- [ ] TypeScript conversion - would have caught several of the shape
      mismatches (Ladok/KTH's nested JSON) hit during development.
