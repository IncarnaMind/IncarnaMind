import { describe, expect, test } from "vitest";
import {
  locateQuote,
  matchingOf,
  quoteElsewhere,
  type RecheckDocuments,
  sharedQuoteLooks,
  windowsOf,
} from "../../src/core/answers/citations";
import type { PageText } from "../../src/core/documents/passages";
import { locationOf, quoteInUnits } from "../../src/shared/locations";

/**
 * Where a quote that isn't at its cited Units stands in its Document's current version (#3041),
 * looked for with the check's own matcher a window of text at a time, so a long Document never holds
 * the app up: at one place a Citation could cite, one Unit or two that run on, its Location; in
 * several, or across more Units, no Location; nowhere, null. A window's edge never makes a quote the
 * version holds read as nowhere.
 */

const QUOTE = "Spring tides happen at new moon and at full moon.";

/** Thirty lines of words to a page: about 3,000 characters, so twenty pages read in several windows. */
const filler = (page: number) =>
  Array.from(
    { length: 30 },
    (_, line) =>
      `Harbour log ${page}-${line}: the pilot boarded vessel ${page * 31 + line} near buoy ${line * 7 + page}.`,
  ).join("\n");

const pagesOf = (count: number, kind: PageText["kind"] = "page"): PageText[] =>
  Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    text: filler(index + 1),
    kind,
  }));

/** The version's pages with `text` put at the end of each page in `on`, and the start of the next. */
function withQuote(units: readonly PageText[], on: Record<number, string>): PageText[] {
  return units.map((unit) => {
    const at = on[unit.page ?? 0];
    return at === undefined ? unit : { ...unit, text: `${unit.text}\n${at}` };
  });
}

/** The Units held as a Document's one current version, counting each time a look reads it all. */
function documentsOf(units: readonly PageText[]) {
  const reads = { whole: 0 };
  const documents: RecheckDocuments = {
    currentVersion: () => "v2",
    documentName: () => "Tides.pdf",
    pageTexts: (_id, _hash, from, to) => {
      if (from === null || to === null) {
        reads.whole++;
        return [...units];
      }
      return units.filter((unit) => unit.page !== null && unit.page >= from && unit.page <= to);
    },
    passagesCovering: () => [],
  };
  return { documents, reads };
}

/** What one match over the whole version says, for the rows where the two agree. */
function inOnePass(units: readonly PageText[], quote: string) {
  const matching = matchingOf(units);
  const at = locateQuote(units, quote, matching);
  if (!at) return quoteInUnits(units, quote, matching) ? { location: null } : null;
  const { pageFrom, pageTo } = at;
  const covered = units.filter(
    (unit) =>
      unit.page !== null &&
      pageFrom !== null &&
      pageTo !== null &&
      unit.page >= pageFrom &&
      unit.page <= pageTo,
  );
  return { location: locationOf(covered, quoteInUnits(covered, quote, matching)) };
}

const cited = { documentId: "tides", pageFrom: 1, pageTo: 1, location: null };

async function lookedFor(units: readonly PageText[], quote = QUOTE) {
  const { documents } = documentsOf(units);
  return quoteElsewhere(documents, { ...cited, quote }, "v2");
}

describe("where a quote stands, looked for a window at a time (#3041)", () => {
  // protects=a quote on any one page of a version long enough to be read in several windows, and one across any page break, window edges among them, is found at its page or pages, with its Location; fails_when=a window's edge loses a quote, or a quote across a page break reads as nowhere or as in another place; no_claim=how long a window takes (the pull request's timing).
  test("finds a quote on any page, and across any page break, with its Location", async () => {
    const pages = pagesOf(20);
    for (let page = 1; page <= 20; page++) {
      const units = withQuote(pages, { [page]: QUOTE });
      expect(await lookedFor(units)).toEqual(inOnePass(units, QUOTE));
      expect(await lookedFor(units)).toEqual({ location: { kind: "page", from: page, to: page } });
    }
    const [head, tail] = ["Spring tides happen at new moon", "and at full moon."];
    for (let page = 1; page < 20; page++) {
      const units = pages.map((unit) =>
        unit.page === page
          ? { ...unit, text: `${unit.text}\n${head}` }
          : unit.page === page + 1
            ? { ...unit, text: `${tail}\n${unit.text}` }
            : unit,
      );
      expect(await lookedFor(units)).toEqual(inOnePass(units, QUOTE));
      expect(await lookedFor(units)).toEqual({
        location: { kind: "page", from: page, to: page + 1 },
      });
    }
  });

  // protects=a quote in two places, in one window or in windows far apart, reads as in another place with no Location, and one in no place as nowhere, in English and Chinese text alike; fails_when=one of two places is taken for the quote's, or a quote nowhere reads as found; no_claim=the words the line says (tests/shared/citations.test.ts).
  test("says a quote in several places has no one Location, and one nowhere is nowhere", async () => {
    const pages = pagesOf(20);
    const cases = [
      withQuote(pages, { 3: QUOTE, 4: QUOTE }),
      withQuote(pages, { 2: QUOTE, 19: QUOTE }),
      withQuote(pages, { 7: `${QUOTE} ${QUOTE}` }),
      pages,
      withQuote(pages, { 12: "大潮出现在新月和满月之时。" }),
    ];
    for (const units of cases) {
      expect(await lookedFor(units)).toEqual(inOnePass(units, QUOTE));
    }
    expect(await lookedFor(cases[0] as PageText[])).toEqual({ location: null });
    expect(await lookedFor(cases[1] as PageText[])).toEqual({ location: null });
    expect(await lookedFor(cases[2] as PageText[])).toEqual({ location: null });
    expect(await lookedFor(pages)).toBeNull();
    const chinese = cases[4] as PageText[];
    expect(await lookedFor(chinese, "大潮出现在新月和满月之时。")).toEqual({
      location: { kind: "page", from: 12, to: 12 },
    });
    expect(await lookedFor(chinese, "大潮出现在新月和满月之时。")).toEqual(
      inOnePass(chinese, "大潮出现在新月和满月之时。"),
    );
  });

  // protects=the matcher's readings are tried in its order over the whole version: a quote found as written in one place stands there, though its letters with lost ligatures, or its number written another way, are in another place; fails_when=a window that hasn't the quote as written takes the other reading and the quote reads as in several places; no_claim=how the readings match (tests/shared/quoteMatch.test.ts).
  test("tries a later reading only when no window has the quote in the one before", async () => {
    // Many "f"s before a letter and none before "i" or "l": a text that lost its ligatures.
    const lost = (page: number) =>
      Array.from(
        { length: 30 },
        (_, line) =>
          `Fog report ${page}-${line}: a ferry from the fort found a few fathoms of water.`,
      ).join("\n");
    const pages: PageText[] = Array.from({ length: 20 }, (_, index) => ({
      page: index + 1,
      text: lost(index + 1),
      kind: "page",
    }));
    expect(matchingOf(pages).lostLigatures).toBe(true);
    const ligature = "The final figures were filed with the harbour office.";
    const both = withQuote(pages, {
      3: "The fnal fgures were fled with the harbour office.",
      17: ligature,
    });
    expect(await lookedFor(both, ligature)).toEqual(inOnePass(both, ligature));
    expect(await lookedFor(both, ligature)).toEqual({
      location: { kind: "page", from: 17, to: 17 },
    });
    const lostOnly = withQuote(pages, { 3: "The fnal fgures were fled with the harbour office." });
    expect(await lookedFor(lostOnly, ligature)).toEqual(inOnePass(lostOnly, ligature));
    expect(await lookedFor(lostOnly, ligature)).toEqual({
      location: { kind: "page", from: 3, to: 3 },
    });

    // A deck's numbers are matched as written first, and formatted only when that finds nothing.
    const slides = pagesOf(20, "slide");
    const figure = "Cargo handled reached 1,200 tonnes in March.";
    const decks = [
      withQuote(slides, { 2: "Cargo handled reached 1200 tonnes in March.", 18: figure }),
      withQuote(slides, { 2: "Cargo handled reached 1200 tonnes in March." }),
    ];
    for (const units of decks) {
      expect(await lookedFor(units, figure)).toEqual(inOnePass(units, figure));
    }
    expect(await lookedFor(decks[0] as PageText[], figure)).toEqual({
      location: { kind: "slide", from: 18, to: 18 },
    });
  });

  // protects=a quote with an ellipsis whose parts each stand in the new version, three or twenty pages apart, before or after each other, reads as in another place wherever it falls, never as nowhere; one whose part is gone reads as nowhere; fails_when=a window's edge between the parts makes the quote read as no longer in the new version; no_claim=when parts are long enough to count (tests/shared/quoteMatch.test.ts).
  test("a quote with an ellipsis whose parts stand far apart is in another place, wherever they fall", async () => {
    const [first, second] = ["Spring tides happen at new moon", "the harbour floods at dawn"];
    const quote = `${first} ... ${second}`;
    const pages = pagesOf(60);
    for (let page = 1; page <= 56; page++) {
      expect(
        await lookedFor(withQuote(pages, { [page]: first, [page + 3]: second }), quote),
      ).toEqual({ location: null });
    }
    for (const page of [2, 17, 33]) {
      const far = withQuote(pages, { [page]: second, [page + 20]: first });
      expect(await lookedFor(far, quote)).toEqual({ location: null });
    }
    expect(await lookedFor(withQuote(pages, { 12: first }), quote)).toBeNull();
  });

  // protects=a quote across three Units whose first is longer than a window and whose middle is shorter than the overlap is found, at several places in the version and with first Units of several lengths, and reads as in another place, no one Location naming three Units; fails_when=the windows step past the middle Unit and the quote reads as no longer in the new version; no_claim=the windows' own promise, held below.
  test("a quote across three Units after a Unit longer than a window is in another place", async () => {
    const long = (size: number) =>
      Array.from({ length: Math.ceil(size / 100) }, (_, line) =>
        `Long section line ${line}: the tide tables were copied out again for the record.`.padEnd(
          99,
          ".",
        ),
      ).join("\n");
    for (const size of [35_000, 45_000, 70_000]) {
      for (const at of [1, 4, 9]) {
        const units: PageText[] = pagesOf(12).map((unit) =>
          unit.page === at
            ? { ...unit, text: `${long(size)}\nSpring tides happen` }
            : unit.page === at + 1
              ? { ...unit, text: "at new moon" }
              : unit.page === at + 2
                ? { ...unit, text: `and at full moon.\n${unit.text}` }
                : unit,
        );
        expect(await lookedFor(units)).toEqual({ location: null });
      }
    }
  });
});

/** Text of Units joined as a version holds them: `lines` lines of about 100 characters each, or one line of `wide` characters. */
const textOf = (units: readonly ({ lines: number } | { wide: number })[]) =>
  units
    .map((unit, index) =>
      "lines" in unit
        ? Array.from({ length: unit.lines }, (_, line) =>
            `Unit ${index} line ${line}: the pilot boarded at slack water.`.padEnd(99, "."),
          ).join("\n")
        : "x".repeat(unit.wide),
    )
    .join("\n");

describe("the windows a version is read in (#3041)", () => {
  // protects=every stretch of a version's text shorter than the windows' overlap is whole in one window, for Units from one line to longer than a window, one line longer than a window among them, and the windows cover the text from its start to its end; fails_when=a stretch falls between two windows, so a quote there is never matched; no_claim=what a window matches (above).
  test("hold every stretch shorter than their overlap, over Units of any length", () => {
    const versions = [
      textOf(Array.from({ length: 400 }, () => ({ lines: 1 }))),
      textOf(Array.from({ length: 40 }, () => ({ lines: 30 }))),
      textOf([{ lines: 450 }, { lines: 1 }, { lines: 30 }, { lines: 30 }, { lines: 700 }]),
      textOf([{ lines: 30 }, { wide: 50_000 }, { lines: 1 }, { lines: 30 }]),
    ];
    for (const text of versions) {
      for (const overlap of [300, 700]) {
        const windows = [...windowsOf(text, overlap)];
        expect(windows[0]?.start).toBe(0);
        expect(windows.at(-1)?.end).toBe(text.length);
        for (let at = 0; at + overlap <= text.length; at += 97) {
          expect(
            windows.some((window) => window.start <= at && window.end >= at + overlap),
            `${overlap} at ${at}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("one look for each Citation at a time (#3041)", () => {
  // protects=a card and the viewer asking where the same Citation's quote stands while it is looked for share the one look, and once it ends nothing is kept, so a later ask reads the version again; fails_when=a second asker starts a second look, or a finished look is kept; no_claim=what the line says.
  test("a second ask while a look runs shares it, and a later one looks again", async () => {
    const { documents, reads } = documentsOf(withQuote(pagesOf(20), { 9: QUOTE }));
    const look = sharedQuoteLooks(documents);
    const asked = { ...cited, quote: QUOTE };
    const [card, viewer] = await Promise.all([look(asked, "v2"), look(asked, "v2")]);
    expect(reads.whole).toBe(1);
    expect(card).toEqual({ location: { kind: "page", from: 9, to: 9 } });
    expect(viewer).toEqual(card);
    // Another Citation, or another version, is its own look.
    await Promise.all([look({ ...asked, pageFrom: 2, pageTo: 2 }, "v2"), look(asked, "v3")]);
    expect(reads.whole).toBe(3);
    expect(await look(asked, "v2")).toEqual(card);
    expect(reads.whole).toBe(4);
  });
});
