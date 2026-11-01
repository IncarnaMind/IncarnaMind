import { getSchema } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import { ANSWER_BLOCK, CITATION_NODE, type CitationAttributes } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

// The module reads the bridge at load: nothing here reaches the core.
vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => {} },
  files: {},
}));

const { figuresOf, sourceOf, uncheckedFigureDecorations } = await import(
  "../../src/renderer/src/editor/uncheckedFigures"
);

/** A Citation of a scanned page, with the words its reading may have misread. */
const scan = (quote: string, unsure: string[], pageChecked = false): CitationAttributes => ({
  passageId: "p1",
  documentId: "d1",
  documentName: "Agreement.pdf",
  contentHash: "h1",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "page", from: 1, to: 1 },
  quote,
  check: "cant-check",
  checkReason: "unsure-word",
  unsure,
  ...(pageChecked && { pageChecked: true }),
});

test("a figure is a scan's when its numeral lies whole in the quote's unsure word", () => {
  expect(sourceOf("61,200", [scan("against (61,200) a year earlier", ["61,200"])])).toMatchObject({
    word: "61,200",
  });
});

test("a figure the word reads as, a letter standing for its digit, is the scan's", () => {
  expect(sourceOf("7,450", [scan("read 7a;45o at the harbour", ["7a;45o"])])).toMatchObject({
    word: "7a;45o",
  });
});

test("an unsure word that holds no digit never claims a figure", () => {
  expect(sourceOf("1", [scan("The 1 claim with a receipt", ["with"])])).toBeNull();
  // The recognizer's letters alone are not digits: "April" is not 11, and "fell" is not 11.
  expect(sourceOf("11", [scan("In April the rate fell", ["April", "fell"])])).toBeNull();
});

test("a figure that is part of a longer number isn't the scan's", () => {
  expect(sourceOf("2", [scan("in 2o25 it rose", ["2o25"])])).toBeNull();
});

test("a page the User checked settles the word, so its figure stops being unchecked", () => {
  expect(sourceOf("61,200", [scan("against 61,200 a year earlier", ["61,200"], true)])).toBeNull();
});

test("the memo keeps each Citation's Document and version, not only its words", () => {
  const text = "It read 7,450 at the harbour.";
  const [first] = figuresOf(text, [
    { at: 10, attributes: scan("read 7a;45o at the harbour", ["7a;45o"]) },
  ]);
  expect(first?.source.citation.documentId).toBe("d1");
  const [second] = figuresOf(text, [
    {
      at: 10,
      attributes: {
        ...scan("read 7a;45o at the harbour", ["7a;45o"]),
        documentId: "d2",
        contentHash: "h2",
      },
    },
  ]);
  expect(second?.source.citation.documentId).toBe("d2");
});

test("the editor's wash and ? go in place once the page is checked", () => {
  const schema = getSchema(noteExtensions());
  const answer = (pageChecked: boolean) =>
    schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: ANSWER_BLOCK,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "It read 7,450 at the harbour." },
                {
                  type: CITATION_NODE,
                  attrs: {
                    passageId: "p1",
                    documentId: "d1",
                    documentName: "Agreement.pdf",
                    contentHash: "h1",
                    pageFrom: 1,
                    pageTo: 1,
                    quote: "read 7a;45o at the harbour",
                    check: "cant-check",
                    checkReason: "unsure-word",
                    unsure: ["7a;45o"],
                    ...(pageChecked && { pageChecked: true }),
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  // The wash and its "?".
  expect(uncheckedFigureDecorations(answer(false))).toHaveLength(2);
  expect(uncheckedFigureDecorations(answer(true))).toEqual([]);
});
