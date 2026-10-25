import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DOMParser, parseHTML } from "linkedom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { fromWord } from "../../src/renderer/src/editor/wordPaste";

const fieldReport = readFileSync(
  join(__dirname, "../fixtures/formats/word-clipboard-field-report.html"),
  "utf8",
);

beforeEach(() => {
  vi.stubGlobal("DOMParser", DOMParser);
});

function pasted(html: string): ProseMirrorNode {
  const { document } = parseHTML(`<!doctype html><html><body>${fromWord(html)}</body></html>`);
  return ProseMirrorDOMParser.fromSchema(getSchema(noteExtensions())).parse(
    document.body as unknown as Node,
  );
}

const blocks = (doc: ProseMirrorNode) =>
  doc.children.map((node) => ({ type: node.type.name, text: node.textContent }));

const items = (list: ProseMirrorNode | null | undefined) =>
  list?.children.map((item) => item.firstChild?.textContent);

const listParagraph = (list: string, level: number, marker: string, words: string) =>
  `<p class=MsoListParagraphCxSpMiddle style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'><![if !supportLists]><span><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${words}<o:p></o:p></span></p>`;

const word = (body: string) =>
  `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body><!--StartFragment-->${body}<!--EndFragment--></body></html>`;

const emptyParagraph = "<p class=MsoNormal><span lang=EN-US><o:p>&nbsp;</o:p></span></p>";
const pageBreak = `<span lang=EN-US><br clear=all style='mso-special-character:line-break;page-break-before:always'></span>`;

describe("pasting what Word copies", () => {
  test("the Field Report keeps its Title, headings, lists and table, and leaves its comment out", () => {
    const doc = pasted(fieldReport);
    const shown = blocks(doc);
    expect(shown[0]).toEqual({ type: "heading", text: "Field Report: Northern Estuary" });
    expect(doc.firstChild?.attrs.level).toBe(1);
    expect(shown.map((block) => block.type)).toEqual(
      expect.arrayContaining(["orderedList", "bulletList", "table"]),
    );
    const steps = doc.children.find((node) => node.type.name === "orderedList");
    expect(items(steps)).toEqual([
      "Calibrate each gauge against the datum.",
      "Read it every fifteen minutes.",
      "Reject gaps longer than a month.",
    ]);
    expect(steps?.attrs.start).toBe(1);
    const equipment = doc.children.find((node) => node.type.name === "bulletList");
    expect(items(equipment)).toEqual(["Pressure gauges", "Radar level sensors", "A survey boat"]);
    expect(shown).toContainEqual({ type: "heading", text: "1 Methods" });
    expect(shown).toContainEqual({ type: "heading", text: "1.1 Sites" });
    expect(doc.textContent).toContain("Highlighted text marks open questions.");
    expect(doc.textContent).not.toContain("[JM1]");
    expect(doc.textContent).not.toContain("Confirm with the hydrology team");
    expect(shown.at(-1)).toEqual({
      type: "paragraph",
      text: "The central and southern estuaries gain less, because their defences are already above the 2050 line.",
    });
  });

  // The rule for Word's numbering: a list becomes the editor's when a scheme writes every marker in it.
  test.each(["1、", "（1）", "1.1.", "a)", "§1"])(
    "a run numbered %s stays paragraphs, each with its number typed",
    (marker) => {
      const doc = pasted(
        word(listParagraph("l0", 1, marker, "First") + listParagraph("l0", 1, marker, "Second")),
      );
      expect(blocks(doc)).toEqual([
        { type: "paragraph", text: `${marker} First` },
        { type: "paragraph", text: `${marker} Second` },
      ]);
    },
  );

  // protects=a Word list written in one of the schemes ("(a) (i)", "一、 （一）", "1. 1.1.") pastes as a list in that scheme, nested by level, and one whose first item is deeper starts at that level; fails_when=it stays typed, or draws in another scheme or level; no_claim=a list of mixed schemes.
  test.each([
    ["clauses", ["(a)", "(i)", "(b)"]],
    ["chinese", ["一、", "（一）", "二、"]],
    ["outline", ["1.", "1.1.", "2."]],
  ])("a run in %s is a list in that scheme", (scheme, [first, nested, second]) => {
    const doc = pasted(
      word(
        listParagraph("l0", 1, first ?? "", "Rent") +
          listParagraph("l0", 2, nested ?? "", "Monthly") +
          listParagraph("l0", 1, second ?? "", "Deposit"),
      ),
    );
    expect(blocks(doc).map((block) => block.type)).toEqual(["orderedList"]);
    expect(doc.firstChild?.attrs.numbering).toBe(scheme);
    expect(items(doc.firstChild)).toEqual(["Rent", "Deposit"]);
    expect(items(doc.firstChild?.firstChild?.lastChild)).toEqual(["Monthly"]);

    const deeper = pasted(
      word(
        listParagraph("l0", 2, nested ?? "", "Monthly") +
          listParagraph("l0", 1, second ?? "", "Deposit"),
      ),
    );
    expect(blocks(deeper).map((block) => block.type)).toEqual(["orderedList", "orderedList"]);
    expect(deeper.firstChild?.attrs.startLevel).toBe(1);
    expect(deeper.lastChild?.attrs.startLevel ?? 0).toBe(0);
  });

  test("a run numbered from 3. is a list that starts at 3", () => {
    const doc = pasted(
      word(listParagraph("l0", 1, "3.", "Third") + listParagraph("l0", 1, "4.", "Fourth")),
    );
    expect(blocks(doc).map((block) => block.type)).toEqual(["orderedList"]);
    expect(doc.firstChild?.attrs.start).toBe(3);
    expect(items(doc.firstChild)).toEqual(["Third", "Fourth"]);
  });

  test.each(["·", "o", "§", "\uf0b7"])("a run of %s bullets is a bullet list", (bullet) => {
    const doc = pasted(word(listParagraph("l1", 1, bullet, "Tide tables")));
    expect(doc.firstChild?.type.name).toBe("bulletList");
    expect(doc.firstChild?.firstChild?.type.name).toBe("listItem");
    expect(doc.firstChild?.firstChild?.firstChild?.type.name).toBe("paragraph");
    expect(doc.textContent).toBe("Tide tables");
  });

  test("a run with one marker the editor can't draw stays plain; the next run is a list", () => {
    const doc = pasted(
      word(
        listParagraph("l0", 1, "1.", "Collect") +
          listParagraph("l0", 2, "a)", "Label") +
          "<p class=MsoNormal>Then</p>" +
          listParagraph("l1", 1, "·", "Boats"),
      ),
    );
    expect(blocks(doc)).toEqual([
      { type: "paragraph", text: "1. Collect" },
      { type: "paragraph", text: "a) Label" },
      { type: "paragraph", text: "Then" },
      { type: "bulletList", text: "Boats" },
    ]);
  });

  test("bullets nest by level", () => {
    const doc = pasted(
      word(
        listParagraph("l1", 1, "·", "Spring tides") +
          listParagraph("l1", 2, "o", "At new moon") +
          listParagraph("l1", 2, "o", "At full moon") +
          listParagraph("l1", 1, "·", "Neap tides"),
      ),
    );
    expect(blocks(doc).map((block) => block.type)).toEqual(["bulletList"]);
    const list = doc.firstChild;
    expect(items(list)).toEqual(["Spring tides", "Neap tides"]);
    const inner = list?.firstChild?.lastChild;
    expect(inner?.type.name).toBe("bulletList");
    expect(items(inner)).toEqual(["At new moon", "At full moon"]);
  });

  test("a bullet under a numbered step nests in it, and the numbering goes on after", () => {
    const doc = pasted(
      word(
        listParagraph("l0", 1, "1.", "First") +
          listParagraph("l0", 2, "·", "Detail") +
          listParagraph("l0", 1, "2.", "Second"),
      ),
    );
    const list = doc.firstChild;
    expect(list?.type.name).toBe("orderedList");
    expect(items(list)).toEqual(["First", "Second"]);
    const inner = list?.firstChild?.lastChild;
    expect(inner?.type.name).toBe("bulletList");
    expect(items(inner)).toEqual(["Detail"]);
  });

  test("a bullet under a numbered list that starts deeper follows it, rather than nesting in it", () => {
    const doc = pasted(
      word(
        listParagraph("l0", 2, "1.1.", "First") +
          listParagraph("l0", 3, "·", "Detail") +
          listParagraph("l0", 2, "1.2.", "Second"),
      ),
    );
    // The scheme list keeps its own level, so the bullet is a list beside it.
    expect(blocks(doc)).toEqual([
      { type: "orderedList", text: "First" },
      { type: "bulletList", text: "Detail" },
      { type: "orderedList", text: "Second" },
    ]);
    expect(doc.firstChild?.attrs.startLevel).toBe(1);
  });

  test("words beside a list, outside any paragraph, are kept", () => {
    const doc = pasted(word(`Loose words before${listParagraph("l0", 1, "1.", "First")}and after`));
    expect(blocks(doc)).toEqual([
      { type: "paragraph", text: "Loose words before" },
      { type: "orderedList", text: "First" },
      { type: "paragraph", text: "and after" },
    ]);
  });

  test("a paragraph between two runs ends the first", () => {
    const doc = pasted(
      word(
        listParagraph("l0", 1, "1.", "One") +
          "<p class=MsoNormal>Between</p>" +
          listParagraph("l0", 1, "2.", "Two"),
      ),
    );
    expect(blocks(doc)).toEqual([
      { type: "orderedList", text: "One" },
      { type: "paragraph", text: "Between" },
      { type: "orderedList", text: "Two" },
    ]);
    expect(doc.child(2).attrs.start).toBe(2);
  });
  test("a list in a table cell stays in its cell, and Windows Word's comment-wrapped markers go", () => {
    const windows = (marker: string, words: string) =>
      `<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><!--[if !supportLists]--><span><span style='mso-list:Ignore'>${marker}<span>&nbsp; </span></span></span><!--[endif]-->${words}</p>`;
    const doc = pasted(
      word(
        `<table><tr><td>${windows("1.", "First")}${windows("2.", "Second")}</td><td><p class=MsoNormal>Notes</p></td></tr></table>`,
      ),
    );
    const cell = doc.firstChild?.firstChild?.firstChild;
    expect(cell?.firstChild?.type.name).toBe("orderedList");
    expect(items(cell?.firstChild)).toEqual(["First", "Second"]);
    expect(doc.textContent).not.toContain("1.");
  });

  test("the Field Report's page break leaves no empty paragraph between its caption and Discussion", () => {
    const shown = blocks(pasted(fieldReport));
    const caption = shown.findIndex((block) => block.text === "Figure 1: the surveyed sites.");
    expect(caption).toBeGreaterThan(-1);
    expect(shown.slice(caption + 1, caption + 2)).toEqual([
      { type: "heading", text: "3 Discussion" },
    ]);
  });

  test("the User's own empty lines beside the Field Report's page break are kept", () => {
    expect(fieldReport.split(emptyParagraph)).toHaveLength(2);
    const breakAt = fieldReport.lastIndexOf("<span", fieldReport.indexOf("page-break-before"));
    expect(breakAt).toBeGreaterThan(-1);
    const withOwnLines =
      fieldReport.slice(0, breakAt) +
      emptyParagraph +
      fieldReport.slice(breakAt).replace(emptyParagraph, emptyParagraph.repeat(2));
    const shown = blocks(pasted(withOwnLines));
    const caption = shown.findIndex((block) => block.text === "Figure 1: the surveyed sites.");
    expect(shown.slice(caption + 1, caption + 4)).toEqual([
      { type: "paragraph", text: "\u00a0" },
      { type: "paragraph", text: "\u00a0" },
      { type: "heading", text: "3 Discussion" },
    ]);
  });

  test("a page break between words leaves them as two paragraphs with nothing between", () => {
    const doc = pasted(
      word(`<p class=MsoNormal>Before the break</p>${pageBreak}<p class=MsoNormal>After it</p>`),
    );
    expect(blocks(doc)).toEqual([
      { type: "paragraph", text: "Before the break" },
      { type: "paragraph", text: "After it" },
    ]);
  });

  test("a page break inside a paragraph leaves a space, so Before and After stay apart", () => {
    const doc = pasted(
      word(`<p class=MsoNormal><span>Before</span>${pageBreak}<span>After</span></p>`),
    );
    expect(blocks(doc)).toEqual([{ type: "paragraph", text: "Before After" }]);
  });

  test("the empty remainder paragraph Word writes after a page break goes with it", () => {
    const doc = pasted(
      word(
        `<p class=MsoNormal>Before the break</p>${pageBreak}${emptyParagraph}<p class=MsoNormal>After it</p>`,
      ),
    );
    expect(blocks(doc)).toEqual([
      { type: "paragraph", text: "Before the break" },
      { type: "paragraph", text: "After it" },
    ]);
  });

  test("a Subtitle is a plain line, and HTML from anywhere else is left as it is", () => {
    const doc = pasted(word(`<p class=MsoSubtitle>Spring 2026</p>`));
    expect(blocks(doc)).toEqual([{ type: "paragraph", text: "Spring 2026" }]);
    const web = `<ol><li>One</li></ol><p class="Title">Not Word</p>`;
    expect(fromWord(web)).toBe(web);
  });
});
