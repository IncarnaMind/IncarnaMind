import { describe, expect, test } from "vitest";
import {
  locateQuote,
  matchingOf,
  quoteElsewhere,
  type RecheckDocuments,
  sharedQuoteLooks,
} from "../../src/core/answers/citations";
import type { PageText } from "../../src/core/documents/passages";
import { locationOf, quoteInUnits } from "../../src/shared/locations";

/**
 * Where a quote that isn't at its cited Units stands in its Document's current version (#3041),
 * looked for a window of Units at a time so a long Document never holds the app up: it says what one
 * match over the whole version says, the same matcher with the same readings, wherever the quote
 * falls against the windows.
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

/** What one match over the whole version says: the check's own `locateQuote` and `quoteInUnits`. */
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
  // protects=a quote on any one page of a version long enough to be read in several windows, and one across any page break, the last Unit of a window and the first of the next among them, is found where one match over the whole version finds it, with the same Location; fails_when=a window's edge loses a quote, or a quote across a page break reads as nowhere or as in another place; no_claim=how long a window takes (the pull request's timing).
  test("finds a quote on any page, and across any page break, where one pass over the whole version does", async () => {
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

  // protects=a quote in two places, in one window or in windows far apart, reads as in another place with no Location, and one in no place as nowhere, as one pass over the whole version says, in English and Chinese text alike; fails_when=one of two places is taken for the quote's, or a quote nowhere reads as found; no_claim=the words the line says (tests/shared/citations.test.ts).
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

  // protects=the matcher's readings are tried in its order over the whole version, as one pass does: a quote found as written in one place stands there, though its letters with lost ligatures, or its number written another way, are in another place; fails_when=a window that hasn't the quote as written takes the other reading and the quote reads as in several places; no_claim=how the readings match (tests/shared/quoteMatch.test.ts).
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
