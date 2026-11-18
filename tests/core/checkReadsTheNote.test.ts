import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { claimPrompt } from "../../src/core/answers/checks/prompt";
import { checkText, everySentence } from "../../src/core/answers/checks/sentences";
import { ANSWER_BLOCK, MIND_CONTENT_FIELD } from "../../src/core/api";

const words = (text: string): NodeJSON[] => [{ type: "text", text }];
const heading = (level: number, text: string): NodeJSON => ({
  type: "heading",
  attrs: { level },
  content: words(text),
});
const paragraph = (text: string): NodeJSON => ({ type: "paragraph", content: words(text) });
const list = (...items: string[]): NodeJSON => ({
  type: "bulletList",
  content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
});
const table: NodeJSON = {
  type: "table",
  content: [
    {
      type: "tableRow",
      content: [{ type: "tableCell", content: [paragraph("Vans in thousands")] }],
    },
  ],
};

/** What the check of the sentence `text` is given of the Note around it. */
function read(blocks: NodeJSON[], text: string) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const fragment = doc.getXmlFragment(MIND_CONTENT_FIELD);
  fragment.push(
    blocks.map((block, index) =>
      createElement({ ...block, attrs: { ...block.attrs, id: `b${index}` } }),
    ),
  );
  const sentence = everySentence(fragment).find((each) => each.text === text);
  if (!sentence) throw new Error(`No sentence "${text}"`);
  return checkText(sentence);
}

/** The place it is given as the one it stands in. */
const placeOf = (blocks: NodeJSON[], text: string) => read(blocks, text).context;

const NOTE = [
  heading(1, "Harbour Dairy: the delivery fleet in 2027"),
  paragraph("Harbour Dairy runs 9 delivery vans. Four are more than ten years old."),
  heading(2, "Costs"),
  paragraph("Repairs came to £21,400 in 2026."),
  table,
  heading(2, "Recommendation"),
  paragraph("Diesel is a fifth of delivery costs."),
  list("Order before the offer runs out.", "Do it in two batches."),
  paragraph("We should start replacing them now."),
];

// protects=a line that doesn't say what it is about is checked with what stands above it, in the Note's own order: its title and the lines under it, the heading it is under and its section so far, a list's items each on their own line, then its own paragraph (#3332); fails_when=a lone piece of advice goes to its check with its heading alone, so the search looks for the advice's own words and its card says the Documents hold nothing; no_claim=what a model finds with it.
test("a lone line goes to its check under the Note's title, its heading and its section so far", () => {
  expect(placeOf(NOTE, "We should start replacing them now.").split("\n\n")).toEqual([
    "Harbour Dairy: the delivery fleet in 2027",
    "Harbour Dairy runs 9 delivery vans. Four are more than ten years old.",
    "Recommendation",
    "Diesel is a fifth of delivery costs.",
    "Order before the offer runs out.\nDo it in two batches.",
    "We should start replacing them now.",
  ]);
});

// protects=another section's lines are not said of the sentence, nor is a table above it, whose cells state their own units; fails_when=a sentence under "Recommendation" is read with the "Costs" section's lines or its table.
test("a sibling section's lines and a table above are left out", () => {
  const place = placeOf(NOTE, "Diesel is a fifth of delivery costs.");
  expect(place).not.toContain("Costs");
  expect(place).not.toContain("Repairs came to");
  expect(place).not.toContain("Vans in thousands");
});

// protects=a list item is read with what is above its list and with the items before it; fails_when=an item goes to its check without its list's heading, the lines that lead into the list, or the item above that says what it is about.
test("a list item goes with what is above its list and the items before it", () => {
  expect(placeOf(NOTE, "Do it in two batches.").split("\n\n").slice(-4)).toEqual([
    "Recommendation",
    "Diesel is a fifth of delivery costs.",
    "Order before the offer runs out.",
    "Do it in two batches.",
  ]);
});

// protects=a sentence of an Answer is read with the Answer's own heading and earlier paragraphs, and with what is above the Answer; fails_when=an Answer's later line goes to its check without the lines of the same Answer that say what it is about.
test("a line of an Answer goes with the Answer's lines before it", () => {
  const answer: NodeJSON = {
    type: ANSWER_BLOCK,
    content: [
      heading(2, "Recommendation"),
      paragraph("Four vans are more than ten years old."),
      paragraph("We should start replacing them now."),
    ],
  };
  expect(
    placeOf(
      [heading(1, "Harbour Dairy fleet"), paragraph("It runs 9 vans."), answer],
      "We should start replacing them now.",
    ).split("\n\n"),
  ).toEqual([
    "Harbour Dairy fleet",
    "It runs 9 vans.",
    "Recommendation",
    "Four vans are more than ten years old.",
    "We should start replacing them now.",
  ]);
});

// protects=a Block the User left out of what a model is sent stays out of a check's lines above, as it stays out of a Question's (ADR-0022); fails_when=checking a sentence sends an excluded Block above it.
test("a Block the User left out is not read above", () => {
  const place = placeOf(
    [
      heading(1, "Harbour Dairy fleet"),
      { ...paragraph("The owner's private note on prices."), attrs: { includeInContext: false } },
      paragraph("It runs 9 vans."),
      paragraph("We should start replacing them now."),
    ],
    "We should start replacing them now.",
  );
  expect(place).toContain("It runs 9 vans.");
  expect(place).not.toContain("private note");
});

// protects=a table cell is read as a cell is, by its row and column, and the table adds no lines above it; fails_when=a cell's check is sent the cells before it as the Note's lines above.
test("a table cell reads nothing of its table as lines above", () => {
  const row = (text: string): NodeJSON => ({
    type: "tableRow",
    content: [{ type: "tableCell", content: [paragraph(text)] }],
  });
  const place = placeOf(
    [
      heading(1, "Fleet"),
      { type: "table", content: [row("Cost"), row("Vans cost 40."), row("Fuel costs 9.")] },
    ],
    "Fuel costs 9.",
  );
  // The heading, then the cell as a table's cell is read: by its own row and column, nothing more above.
  expect(place.split("\n\n")).toHaveLength(2);
  expect(place.startsWith("Fleet\n\n")).toBe(true);
});

// protects=a Note with no headings is read from its top; fails_when=a plain Note's later lines go to their checks without its opening lines.
test("a Note without headings gives the lines above from its top", () => {
  expect(
    placeOf(
      [paragraph("Harbour Dairy runs 9 delivery vans."), paragraph("We should replace them.")],
      "We should replace them.",
    ),
  ).toBe("Harbour Dairy runs 9 delivery vans.\n\nWe should replace them.");
});

// protects=a long Note costs a check a bounded amount of text above its sentence, nearest lines first, while every heading it is under is still read; fails_when=the hundredth paragraph of a section sends the ninety-nine before it.
test("the lines above are bounded, the headings always read", () => {
  const long = [
    heading(1, "Fleet"),
    ...Array.from({ length: 40 }, (_, index) => paragraph(`Line ${index} ${"x".repeat(200)}.`)),
    paragraph("We should start replacing them now."),
  ];
  const place = placeOf(long, "We should start replacing them now.");
  expect(place.startsWith("Fleet\n\n")).toBe(true);
  expect(place).toContain("Line 39 ");
  expect(place).not.toContain("Line 0 ");
  expect(place.length).toBeLessThan(2400);
});

// protects=the check is told the lines above are the User's text and no evidence; fails_when=the prompt presents them as facts or drops the tag that keeps them apart from instructions.
test("the prompt gives the place as the User's text, in its own tag", () => {
  const prompt = claimPrompt({
    claim: "We should start replacing them now.",
    context: placeOf(NOTE, "We should start replacing them now."),
    language: "en",
  });
  expect(prompt).toMatch(
    /Where it stands in the Note[^\n]*\n<paragraph>\nHarbour Dairy: the delivery fleet in 2027\n[\s\S]*We should start replacing them now\.\n<\/paragraph>/,
  );
});

// protects=a decision model reads a sentence with what its lines were measured with, the paragraph under its nearest heading (#3118), whatever more the AI model's check is given; fails_when=the Note's lines above reach the decision model, whose scores were never measured with them.
test("a decision model's reading keeps the paragraph under its nearest heading", () => {
  expect(read(NOTE, "We should start replacing them now.").near).toBe(
    "Recommendation\n\nWe should start replacing them now.",
  );
});
