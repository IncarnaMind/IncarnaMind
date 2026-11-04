/**
 * Where a Citation points when the model names no page (#519): at the Unit
 * (or two) its quote is on, not the whole span of the Passage it came from.
 */
import { describe, expect, test } from "vitest";
import type { Citation } from "../../src/core";
import { createCitationSession } from "../../src/core/answers/citations";
import type { PageText } from "../../src/core/documents/passages";

const FIRST = "The harbour master logged 412 vessel calls during the year.";
const LAST = "The Kestrel Quay tide gauge went live on 3 March 2025.";
const SECOND = "Dredging resumed at the northern berth in the autumn.";

function cited(
  units: PageText[],
  quote: string,
  documentKind: "pdf" | "pptx" = "pdf",
  named: { pageFrom: number; pageTo: number } | null = null,
) {
  const first = units[0]?.page ?? 1;
  const last = units.at(-1)?.page ?? first;
  const source = {
    passageId: "p1",
    documentId: "d1",
    documentName: "Port report",
    contentHash: "v1",
    pageFrom: first,
    pageTo: last,
    text: units.map((unit) => unit.text).join("\n\n"),
  };
  let citation: Citation | null = null;
  const session = createCitationSession(
    {
      searchableCount: () => 1,
      search: async () => [
        {
          ...source,
          position: 0,
          seq: 0,
          documentKind,
          windowFrom: 0,
          windowTo: 0,
        },
      ],
      citationSource: () => ({
        ...source,
        documentKind,
        documentDeleted: false,
        notCited: false,
        yourNoteAt: null,
      }),
      pageTexts: (_id, _hash, from, to) =>
        units.filter(
          (unit) => unit.page !== null && unit.page >= (from ?? 0) && unit.page <= (to ?? 0),
        ),
      documentDate: () => null,
    },
    {
      onRecord: (_marker, each) => {
        citation = each;
      },
    },
  );
  return session.tools.searchDocuments("q").then(() => {
    session.tools.cite([{ marker: 1, passage: "P1", quote, ...named }]);
    return citation as Citation | null;
  });
}

const pages = (kind: "page" | "slide"): PageText[] => [
  { page: 1, kind, text: `${FIRST} ${LAST}` },
  { page: 2, kind, text: SECOND },
];

describe.each(["page", "slide"] as const)(
  "a quote in a Passage of two %ss, no page named",
  (kind) => {
    const documentKind = kind === "page" ? "pdf" : "pptx";

    test("the last sentence of the first Unit is cited there alone", async () => {
      const citation = await cited(pages(kind), LAST, documentKind);
      expect(citation?.location).toEqual({ kind, from: 1, to: 1 });
      expect([citation?.pageFrom, citation?.pageTo]).toEqual([1, 1]);
    });

    test("a sentence in the middle of the first Unit is cited there alone", async () => {
      const citation = await cited(pages(kind), FIRST, documentKind);
      expect(citation?.location).toEqual({ kind, from: 1, to: 1 });
    });

    test("a quote across the break keeps both", async () => {
      const citation = await cited(pages(kind), `${LAST} ${SECOND}`, documentKind);
      expect(citation?.location).toEqual({ kind, from: 1, to: 2 });
    });

    test("a quote that can't be located keeps the Passage's range", async () => {
      const citation = await cited(pages(kind), "The pilot boat was repainted.", documentKind);
      expect(citation?.location).toEqual({ kind, from: 1, to: 2 });
    });
  },
);

describe("a model that copies the Passage's two pages", () => {
  const both = { pageFrom: 1, pageTo: 2 };

  test("is cited on the one page its quote is on", async () => {
    const citation = await cited(pages("page"), LAST, "pdf", both);
    expect(citation?.location).toEqual({ kind: "page", from: 1, to: 1 });
  });

  test("keeps both for a quote across the break", async () => {
    const citation = await cited(pages("page"), `${LAST} ${SECOND}`, "pdf", both);
    expect(citation?.location).toEqual({ kind: "page", from: 1, to: 2 });
  });
});

test("a quote on page 3 of a Passage covering pages 1 to 4 is cited on page 3 (#67)", async () => {
  const units: PageText[] = [1, 2, 3, 4].map((page) => ({
    page,
    kind: "page",
    text: page === 3 ? LAST : `Filler for page ${page}.`,
  }));
  const citation = await cited(units, LAST);
  expect(citation?.location).toEqual({ kind: "page", from: 3, to: 3 });
});
