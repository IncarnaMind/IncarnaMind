import { describe, expect, test } from "vitest";
import { createCalculationSession } from "../../src/core/answers/calculations";
import { createCitationSession } from "../../src/core/answers/citations";

/* A table's cells (#1459): a number's unit cell is its own row's. */

const LANGUAGES = [
  {
    language: "en" as const,
    unit: "thousand tonnes",
    scale: 1000,
    revenue: "Revenue",
    people: "People",
  },
  {
    language: "zh-CN" as const,
    unit: "万元",
    scale: 10_000,
    revenue: "收入",
    people: "人数",
  },
];

describe("a quoted row's unit cell", () => {
  // protects=a unit cell states only its own row's unit: a headcount quoted under a row in thousand tonnes is never read as 7,000 tonnes, while the row's own 100 still is 100,000 (#1459), in English and Chinese; fails_when=another row's unit scales the 7; no_claim=how the model is asked for a unit line.
  test.each(LANGUAGES)(
    "is never another row's ($language)",
    ({ language, unit, scale, revenue, people }) => {
      const body = `Item\tValue\tUnit\n${revenue}\t100\t${unit}\n${people}\t7\t`;
      const source = {
        passageId: "passage-1",
        documentId: "document-1",
        documentName: "Facts.pdf",
        documentKind: "pdf" as const,
        contentHash: "hash-1",
        text: body,
        pageFrom: 1,
        pageTo: 1,
        documentDeleted: false,
        notCited: false,
        yourNoteAt: null,
      };
      const shown = { ...source, seq: 1, position: 0, windowFrom: 0, windowTo: 0 };
      const documents = {
        searchableCount: () => 1,
        search: async () => [shown],
        citationSource: (id: string) => (id === source.passageId ? source : null),
        pageTexts: () => [{ page: 1, text: body, kind: "page" as const, label: null }],
        documentDate: () => null,
      };
      const quotes = createCitationSession(documents, { onRecord: () => undefined });
      quotes.show([shown]);
      const calculations = createCalculationSession({ documents, quotes: quotes.quotes, language });
      const read = (number: string) =>
        calculations.number({ name: "n", passage: "P1", location: "p. 1", quote: body, number });

      expect(read("100")).toMatchObject({ input: { number: { value: 100 * scale } } });
      expect(read("7")).not.toMatchObject({ input: { number: { value: 7 * scale } } });
    },
  );
});
