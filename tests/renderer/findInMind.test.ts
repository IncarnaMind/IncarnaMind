import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import {
  FindInMind,
  findMatches,
  findStateOf,
  replaceAllInMind,
  replaceCurrentInMind,
  setFindQuery,
} from "../../src/renderer/src/editor/findInMind";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { editorExtensions, headlessEditor } from "../helpers/editor";

const schema = getSchema(noteExtensions());

const text = (value: string, marks?: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks: marks.map((type) => ({ type })) }),
});

const docOf = (...paragraphs: JSONContent[][]) =>
  schema.nodeFromJSON({
    type: "doc",
    content: paragraphs.map((content) => ({ type: "paragraph", content })),
  });

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

/** What each match covers, as the document's text between its parts. */
const found = (
  doc: ReturnType<typeof docOf>,
  query: string,
  options?: { matchCase?: boolean; wholeWord?: boolean },
) =>
  findMatches(doc, query, options).map((match) =>
    match.parts.map((part) => doc.textBetween(part.from, part.to)).join("|"),
  );

describe("findMatches", () => {
  test("finds every occurrence in order, whatever the case", () => {
    const doc = docOf([text("Tides and tides and TIDES")], [text("No tide here")]);
    expect(found(doc, "tides")).toEqual(["Tides", "tides", "TIDES"]);
    expect(found(doc, "TIDE")).toEqual(["Tide", "tide", "TIDE", "tide"]);
  });

  test("finds Chinese text as it comes, with no idea of words", () => {
    const doc = docOf([text("潮汐是海水的周期性涨落，大潮和小潮交替出现。")]);
    expect(found(doc, "潮")).toHaveLength(3);
    expect(found(doc, "大潮和")).toEqual(["大潮和"]);
    // Chinese and Latin letters side by side, with no space between them.
    expect(found(docOf([text("用Mind记录潮汐")]), "mind记录")).toEqual(["Mind记录"]);
  });

  test("a match across marks covers each stretch, and a node in between breaks it", () => {
    const marked = docOf([text("spring "), text("tides", ["bold"]), text(" rise")]);
    const [match] = findMatches(marked, "ng tides r");
    expect(match?.parts).toHaveLength(3);
    expect(found(marked, "ng tides r")).toEqual(["ng |tides| r"]);

    const cited = docOf([
      text("tide"),
      { type: CITATION_NODE, attrs: { documentId: "d", documentName: "D" } },
      text("s"),
    ]);
    expect(found(cited, "tides")).toEqual([]);
    expect(found(cited, "tide")).toEqual(["tide"]);
  });

  test("an empty query finds nothing", () => {
    expect(findMatches(docOf([text("tides")]), "")).toEqual([]);
  });

  test("matches don't overlap into the next paragraph", () => {
    const doc = docOf([text("tid")], [text("es")]);
    expect(found(doc, "tides")).toEqual([]);
  });

  test("Match case and Whole word, as the bar offers them", () => {
    const doc = docOf([text("Tide tide TIDE tidal tide-water")]);
    expect(found(doc, "tide", { wholeWord: true })).toEqual(["Tide", "tide", "TIDE", "tide"]);
    expect(found(doc, "tide", { matchCase: true })).toEqual(["tide", "tide"]);
    expect(found(doc, "tide", { matchCase: true, wholeWord: true })).toEqual(["tide", "tide"]);
    // A Chinese word is whole when no Latin letter or digit runs into it.
    expect(found(docOf([text("大潮和潮汐")]), "潮", { wholeWord: true })).toHaveLength(2);
    expect(found(docOf([text("tide潮")]), "潮", { wholeWord: true })).toHaveLength(1);
    expect(found(docOf([text("atide")]), "tide", { wholeWord: true })).toEqual([]);
  });
});

const citation = (quote: string, check: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "p",
    documentId: "d",
    documentName: "Tides",
    contentHash: "h",
    pageFrom: 1,
    pageTo: 1,
    quote,
    check,
  },
});

const citationsIn = (doc: ReturnType<typeof docOf>) => {
  const citations: { quote: unknown; check: unknown }[] = [];
  doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) {
      citations.push({ quote: node.attrs.quote, check: node.attrs.check });
    }
  });
  return citations;
};

/** A 30-page note: 600 paragraphs with a tide in each, a Citation on every third. */
function longNote(): JSONContent[] {
  const blocks: JSONContent[] = [];
  const quote = "Spring tides happen at new moon.";
  for (let page = 1; page <= 30; page++) {
    for (let line = 1; line <= 20; line++) {
      const at = (page - 1) * 20 + line;
      const content: JSONContent[] = [text(`A tide rises on page ${at}.`)];
      if (at % 3 === 0) content.push(citation(quote, "found"));
      blocks.push(paragraph(...content));
    }
  }
  return blocks;
}

describe("replace", () => {
  test("replaces every match as the bar's options say, and the note's text reads anew", () => {
    const editor = headlessEditor();
    editor.commands.setContent({
      type: "doc",
      content: docOf([text("Tides, tides and TIDES")]).toJSON().content,
    });
    expect(replaceAllInMind(editor, "tides", "waves", {})).toBe(3);
    expect(editor.state.doc.textContent).toBe("waves, waves and waves");
    expect(replaceAllInMind(editor, "waves", "seas", { wholeWord: true })).toBe(3);
    expect(editor.state.doc.textContent).toBe("seas, seas and seas");
  });

  test("Replace replaces the match the bar is on, and goes on to the next", () => {
    const editor = headlessEditor([...editorExtensions(), FindInMind]);
    editor.commands.setContent({
      type: "doc",
      content: docOf([text("tide tide tide")]).toJSON().content,
    });
    setFindQuery(editor, "tide");
    expect(findStateOf(editor).current).toBe(0);
    expect(replaceCurrentInMind(editor, "tide", "wave", {})).toBe(1);
    expect(editor.state.doc.textContent).toBe("wave tide tide");
    expect(findStateOf(editor).current).toBe(0);
    expect(replaceCurrentInMind(editor, "tide", "wave", {})).toBe(1);
    expect(editor.state.doc.textContent).toBe("wave wave tide");
  });

  test("a 30-page note with 200 Citations: Replace all leaves every Citation and its quote intact", () => {
    const editor = headlessEditor();
    editor.commands.setContent({ type: "doc", content: longNote() });
    const before = citationsIn(editor.state.doc);
    expect(before).toHaveLength(200);
    expect(before.every((each) => each.quote === "Spring tides happen at new moon.")).toBe(true);

    expect(replaceAllInMind(editor, "tide", "wave", {})).toBe(600);

    expect(editor.state.doc.textContent).not.toContain("tide rises");
    expect(editor.state.doc.textContent.match(/wave rises/g)).toHaveLength(600);
    const after = citationsIn(editor.state.doc);
    expect(after).toEqual(before);
    expect(after.every((each) => each.check === "found")).toBe(true);
    expect(findMatches(editor.state.doc, "tide")).toHaveLength(0);
  });

  test("a match never reaches across a Citation, so a replacement cannot cut its marker", () => {
    const editor = headlessEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        paragraph(text("tide"), citation("Spring tides happen at new moon.", "found"), text("s")),
      ],
    });
    expect(findMatches(editor.state.doc, "tides")).toHaveLength(0);
    expect(replaceAllInMind(editor, "tides", "waves", {})).toBe(0);
    expect(citationsIn(editor.state.doc)).toHaveLength(1);
    expect(replaceAllInMind(editor, "tide", "wave", {})).toBe(1);
    expect(citationsIn(editor.state.doc)).toHaveLength(1);
    expect(editor.state.doc.textContent).toContain("waves");
  });

  test("a case-insensitive find takes letters whose case changes their length, such as İ", () => {
    const doc = docOf([text("İstanbul and istanbul")]);
    expect(found(doc, "istanbul")).toEqual(["İstanbul", "istanbul"]);

    const editor = headlessEditor();
    editor.commands.setContent(doc.toJSON());
    expect(replaceAllInMind(editor, "istanbul", "Izmir", {})).toBe(2);
    expect(editor.state.doc.textContent).toBe("Izmir and Izmir");
  });

  const marked = (value: string, marks: { type: string; attrs?: Record<string, unknown> }[]) => ({
    type: "text" as const,
    text: value,
    marks,
  });
  const runsOf = (editor: ReturnType<typeof headlessEditor>) => {
    const runs: { text: string; marks: string[] }[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText)
        runs.push({ text: node.text ?? "", marks: node.marks.map((m) => m.type.name) });
    });
    return runs;
  };
  const marksOn = (editor: ReturnType<typeof headlessEditor>, word: string) =>
    runsOf(editor)
      .filter((run) => run.text.includes(word))
      .flatMap((run) => run.marks);

  test("a replacement keeps the mark of the words it starts in, at their start, middle and end", () => {
    const marks: { type: string; attrs?: Record<string, unknown> }[] = [
      { type: "bold" },
      { type: "link", attrs: { href: "https://example.com" } },
      { type: "claimCheck", attrs: { id: "c1", text: "one tide two" } },
    ];
    for (const { type, attrs } of marks) {
      for (const word of ["one", "tide", "two"]) {
        const editor = headlessEditor();
        const mark = { type, ...(attrs && { attrs }) };
        editor.commands.setContent({
          type: "doc",
          content: [paragraph(marked("one tide two", [mark]), text(" after"))],
        });
        expect(replaceAllInMind(editor, word, "new", {})).toBe(1);
        expect(marksOn(editor, "new")).toContain(type);
        expect(marksOn(editor, "after")).not.toContain(type);
        expect(editor.state.doc.textContent).toBe("one tide two after".replace(word, "new"));
      }
    }
  });

  test("Replace all writes 10,000 matches a block at a time", () => {
    const paragraphs = Array.from({ length: 500 }, () =>
      paragraph(text(Array.from({ length: 20 }, () => "tide").join(" "))),
    );
    const editor = headlessEditor();
    editor.commands.setContent({ type: "doc", content: paragraphs });
    expect(replaceAllInMind(editor, "tide", "wave", {})).toBe(10_000);
    expect(editor.state.doc.textContent.match(/wave/g)).toHaveLength(10_000);
  });
});
