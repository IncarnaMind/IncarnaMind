import { describe, expect, test } from "vitest";
import {
  citesSource,
  linkKnownSources,
  linkSources,
  type NamedSource,
  namesOneOf,
  sourcesAsText,
} from "../../src/shared/namedSources";

/**
 * Sources a model writes in a table's cells as a name in brackets (#961):
 * each links to the Citation of that Document at the place it names, by page,
 * slide, sheet cell or section, or stays as text and is counted.
 */

const CITATIONS = [
  { documentName: "Annual report.pdf", pageFrom: 3, pageTo: 4 },
  { documentName: "Deck.pptx", location: { kind: "slide", from: 2, to: 2 } },
  { documentName: "Model.xlsx", location: { kind: "rows", sheet: "Revenue", from: 10, to: 14 } },
  { documentName: "Policy.docx", location: { kind: "section", heading: "4. Termination" } },
  { documentName: "Notes.md" },
];

const link = (text: string) =>
  linkSources(text, (source) => {
    const index = CITATIONS.findIndex((citation) => citesSource(citation, source));
    return index < 0 ? null : `[${index + 1}]`;
  });

describe("A source written as a name in brackets", () => {
  // protects=page, slide, sheet cell and section sources link to the Citation there, in English and Chinese; fails_when=one of them stays as text though a Citation is there; no_claim=none beyond protects.
  test.each([
    ["Revenue rose [Annual report, p. 4]", "Revenue rose [1]"],
    ["Revenue rose [Annual report，第 3 页]", "Revenue rose [1]"],
    ["Pricing [Deck, slide 2]", "Pricing [2]"],
    ["Q3 [Model.xlsx, B12]", "Q3 [3]"],
    ["Q3 [Model, Revenue!B12]", "Q3 [3]"],
    ["Q3 [Model.xlsx, Revenue, rows 11–12]", "Q3 [3]"],
    ["Notice [Policy, §4]", "Notice [4]"],
    ["Notice [Policy, § 4]", "Notice [4]"],
    ["Ideas [Notes]", "Ideas [5]"],
    ["Ideas [Notes, p. 9]", "Ideas [5]"],
    ["Notice [Policy, p. 2]", "Notice [4]"],
  ])("%s", (text, linked) => {
    expect(link(text)).toEqual({ text: linked, unlinked: 0 });
  });

  // protects=a source at a place no Citation is, or of a Document none is of, stays as text and is counted, while a bracket that names no source isn't counted; fails_when=it links to the wrong place, or "[sic]" counts as a source; no_claim=none beyond protects.
  test.each([
    ["[Annual report, p. 9]", 1],
    ["[Deck, slide 5]", 1],
    ["[Model.xlsx, B40]", 1],
    ["[Model.xlsx, Costs!B12]", 1],
    ["[Policy, §7]", 1],
    ["[Atlas of the Sea, p. 2]", 1],
    ["[sic]", 0],
    ["[^1] and [2]", 0],
    ["[a link](https://example.com)", 0],
  ])("%s stays as text", (text, unlinked) => {
    expect(link(text)).toEqual({ text, unlinked });
  });
});

describe("Sources written as text in what the assistant writes into a Mind (#1075)", () => {
  const NAMES = ["5_Rue_Berryer_Paris.pptx", "执行概要.md", "Tides.md", "Deck.pptx"];
  const known = (source: { name: string }) => namesOneOf(source.name, NAMES);
  const link = (source: NamedSource) =>
    source.name === "5_Rue_Berryer_Paris" &&
    source.location?.kind === "slide" &&
    source.location.from === 3
      ? "[^1]"
      : null;

  // protects=a bracket that names a Document, with or without a place, in the owner's two shapes, full-width or several in one, is found as written; fails_when=one of them is missed; no_claim=what is done with it.
  test("finds brackets that name a Document, as written", () => {
    const text = [
      "Offices of 1,200 m² [5_Rue_Berryer_Paris, slide 3].",
      "收入每年增长百分之二十[执行概要, § 6.3.1 未来三年财务预测]。",
      "From [5_Rue_Berryer_Paris, slide 2; 执行概要, § 7] and 【执行概要，第 3 页】, see [Tides].",
    ].join("\n\n");
    expect(sourcesAsText(text, known)).toEqual([
      "[5_Rue_Berryer_Paris, slide 3]",
      "[执行概要, § 6.3.1 未来三年财务预测]",
      "[5_Rue_Berryer_Paris, slide 2; 执行概要, § 7]",
      "【执行概要，第 3 页】",
      "[Tides]",
    ]);
  });

  // protects=the reviewer's brackets that aren't sources stay exactly as written: checkboxes, code, maths, quoted words, intervals, times, "[1]", "[Section 4]" and a bracket that names no Document; fails_when=any is found or changed; no_claim=none beyond protects.
  test("leaves every other bracket exactly as written", () => {
    const text = [
      "- [ ] Visit the building",
      "- [x] Read the deck",
      '```python\ndf[["col1","col2"]]\narr[0, 10:20]\n```',
      'Use `df[["col1"]]` and $x \\in [t1, t2]$ here.',
      "Between [t1, t2], open [09:00, 17:00], as [1] says.",
      "“Claims under [Section 4] are void,” and so is [Section 4].",
      "As “[Tides, p. 3]” shows, [Atlas of the Sea, p. 2] and [sic] stay.",
    ].join("\n\n");
    expect(sourcesAsText(text, known)).toEqual([]);
    expect(linkKnownSources(text, known, link)).toEqual({ text, dropped: 0 });
  });

  // protects=a source between two dollar amounts or two inch marks is still found and linked or left out, while real maths and a real quoted phrase keep their brackets, as pandoc reads $ and straight quotes (#1087 review); fails_when=a source beside money or inches stays as bracket text, or a bracket in maths or quotes is touched; no_claim=none beyond protects.
  test.each([
    [
      "Revenue was $4.2m [5_Rue_Berryer_Paris, slide 3], up from $3.1m.",
      "Revenue was $4.2m [^1], up from $3.1m.",
      0,
    ],
    ["$100 万 [执行概要, § 6.3.1 未来三年财务预测]，高于 $80 万", "$100 万，高于 $80 万", 1],
    ['12" pipes [Deck, slide 3] and the 6" ones', '12" pipes and the 6" ones', 1],
  ])("finds the source in %s", (text, linked, dropped) => {
    expect(sourcesAsText(text, known)).toHaveLength(1);
    expect(linkKnownSources(text, known, link)).toEqual({ text: linked, dropped });
  });

  // protects=a bracket inside real maths or a real straight-quoted phrase is never a source; fails_when=either is found or changed; no_claim=none beyond protects.
  test.each(["The area is $x^2 [Tides]$ here.", 'He wrote "see [Tides] first" in the margin.'])(
    "keeps the bracket in %s",
    (text) => {
      expect(sourcesAsText(text, known)).toEqual([]);
      expect(linkKnownSources(text, known, link)).toEqual({ text, dropped: 0 });
    },
  );

  // protects=a source with a recorded Citation becomes its marker, and one with none, a bare Document name too, is left out with the space before it and counted; fails_when=a bracket stays as text, a space is left before the punctuation, or one left out isn't counted; no_claim=none beyond protects.
  test("links what it can, and leaves out and counts the rest", () => {
    expect(
      linkKnownSources(
        "Offices [5_Rue_Berryer_Paris, slide 3]. Forecast [执行概要, § 6.3.1]. Tides [Tides]. Both [5_Rue_Berryer_Paris, slide 3; Tides].",
        known,
        link,
      ),
    ).toEqual({ text: "Offices [^1]. Forecast. Tides. Both [^1].", dropped: 3 });
  });
});
