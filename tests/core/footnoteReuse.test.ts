import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { type CitationPlace, type CitedWork, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { renderDocx } from "../../src/core/exports/docx";
import { exportLabels } from "../../src/core/exports/labels";
import { renderPrintHtml } from "../../src/core/exports/printHtml";
import { type Block, type Footnote, type Inline, NO_MARKS } from "../../src/core/mindText";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { citationsIn, noteNumbers } from "../../src/renderer/src/editor/copyNotes";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { checkWellFormed, footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

/*
 * One footnote for a source and place in a Word export, and a cross-reference to it from every
 * later Citation of it (#1552), through the core and through the writer.
 */

const NOTEREF = /NOTEREF (_Ref\d+) \\f \\h /g;

function crossReferences(document: string) {
  const bookmarks = [
    ...document.matchAll(
      /<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"\/>(<w:r><w:rPr><w:rStyle w:val="[^"]*"\/><\/w:rPr><w:footnoteReference w:id="(\d+)"\/><\/w:r>)<w:bookmarkEnd w:id="\1"\/>/g,
    ),
  ].map((found) => ({ id: found[1], name: found[2], note: Number(found[4]) }));
  const results = [
    ...document.matchAll(
      /NOTEREF (_Ref\d+) \\f \\h <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:t>(\d+)<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r>/g,
    ),
  ].map((found) => ({ name: found[1], shows: Number(found[2]) }));
  return {
    bookmarks,
    results,
    referenced: [...document.matchAll(NOTEREF)].map((found) => found[1]),
    marks: [...document.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((found) =>
      Number(found[1]),
    ),
    begins: [...document.matchAll(/w:fldCharType="begin"/g)].length,
    ends: [...document.matchAll(/w:fldCharType="end"/g)].length,
  };
}

/**
 * What the reader sees at every Citation mark in the text, in order: the note it points at, and
 * the number it shows, whether it is the note's own mark or a cross-reference to it.
 */
function shownMarks(
  document: string,
): { mark: "reference" | "noteref"; note: number; shows: number }[] {
  const bookmarks = new Map(
    crossReferences(document).bookmarks.map((each) => [each.name, each.note]),
  );
  const marks: { mark: "reference" | "noteref"; note: number; shows: number }[] = [];
  const pattern =
    /<w:footnoteReference w:id="(\d+)"\/>|NOTEREF (_Ref\d+) \\f \\h <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:t>(\d+)<\/w:t><\/w:r>/g;
  const numbers = new Map<number, number>();
  for (const found of document.matchAll(pattern)) {
    if (found[1] !== undefined) {
      const note = Number(found[1]);
      if (!numbers.has(note)) numbers.set(note, numbers.size + 1);
      marks.push({ mark: "reference", note, shows: numbers.get(note) ?? 0 });
    } else {
      marks.push({
        mark: "noteref",
        note: bookmarks.get(found[2] as string) ?? -1,
        shows: Number(found[3]),
      });
    }
  }
  return marks;
}

describe("a Word export of a Mind that cites a source again", () => {
  /** The source and place a Citation names, its Document's name and the words quoted. */
  const resume = { name: "黄珊简历", quote: "黄珊，产品经理。" };
  const citation = (
    documentId: string,
    contentHash: string | null,
    page: number,
    source = resume,
  ): JSONContent => ({
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId,
      documentName: source.name,
      contentHash,
      pageFrom: page,
      pageTo: page,
      quote: source.quote,
      check: "found",
      checkReason: null,
    },
  });
  const text = (value: string): JSONContent => ({ type: "text", text: value });

  async function exportWith(
    pages: readonly number[],
    {
      citationPlace,
      format = "docx",
      ownFootnote = false,
      source = resume,
    }: {
      citationPlace?: CitationPlace;
      format?: "docx" | "pdf";
      ownFootnote?: boolean;
      source?: { name: string; quote: string };
    } = {},
  ) {
    const { printed, printer } = fakePrinter();
    const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, `${source.name}.txt`, source.quote);
    const [document] = await addAndProcess(core, [path]);
    const mind = await core.createMind({ title: "总结" });
    const client = await connectToMind(core, mind.id);
    writeMind(
      client,
      pages.map((page, index) => ({
        type: "paragraph",
        content: [
          text(`第 ${index + 1} 句`),
          citation(document?.id ?? "", document?.contentHash ?? null, page, source),
          ...(ownFootnote && index === 0
            ? [{ type: "footnote", attrs: { id: "own-1" }, content: [text("我的注。")] }]
            : []),
          text("。"),
        ],
      })),
    );
    await client.settled();
    // The numbers the editor shows at the Citation marks, top to bottom, its checks settled as
    // the live Documents have them.
    const screen = numberFootnotes(readMind(client), "numbered", {
      documents: await core.listDocuments(),
    }).citations;
    const exported = await core.exportMind(mind.id, {
      format,
      ...(citationPlace !== undefined && { citationPlace }),
    });
    if (format === "pdf") return { document: "", footnotes: {}, exported, printed, screen };
    const files = unzip(exported.data);
    for (const [name, content] of files) {
      if (name.endsWith(".xml") || name.endsWith(".rels"))
        checkWellFormed(content.toString("utf8"));
    }
    return {
      document: part(files, "word/document.xml"),
      footnotes: footnotesOf(part(files, "word/footnotes.xml")),
      exported,
      printed,
      screen,
    };
  }

  test("each screen mark has a reference, each NOTEREF its own note's number, and the Saved line the file's count (#2292)", async () => {
    const { document, footnotes, exported, screen } = await exportWith([1, 1, 2]);
    const marks = shownMarks(document);
    // The screen shows the file's numbers: one note per source and place (#1381), the repeat reused.
    expect(screen.map((each) => each.number)).toEqual([1, 1, 2]);
    expect(marks.map((each) => `${each.mark} ${each.shows}`)).toEqual([
      "reference 1",
      "noteref 1",
      "reference 2",
    ]);
    // Every mark in the file answers a mark on screen.
    expect(marks).toHaveLength(screen.length);
    expect(footnotes).toEqual({ "1": "黄珊简历, p. 1", "2": "黄珊简历, p. 2" });
    // A cross-reference names a bookmark around a note, and shows that note's number.
    const numberByNote = new Map<number, number>();
    for (const each of marks) {
      if (each.mark === "reference" && !numberByNote.has(each.note))
        numberByNote.set(each.note, each.shows);
    }
    for (const each of marks) {
      if (each.mark !== "noteref") continue;
      expect(each.note).toBeGreaterThan(0);
      expect(each.shows).toBe(numberByNote.get(each.note));
    }
    // One mark for each footnote, and the Saved line counts the footnotes the file holds.
    expect([...numberByNote.keys()].sort()).toEqual([1, 2]);
    expect(exported.footnotes).toBe(Object.keys(footnotes).length);
    expect(exported.footnotes).toBe(2);
  });

  test("an English source and place number the same way: two footnotes for three marks (#2292)", async () => {
    const source = { name: "Tides", quote: "The tide rises twice a day." };
    const { document, footnotes, exported, screen } = await exportWith([1, 1, 2], { source });
    expect(screen.map((each) => each.number)).toEqual([1, 1, 2]);
    expect(shownMarks(document).map((each) => each.shows)).toEqual([1, 1, 2]);
    expect(footnotes).toEqual({ "1": "Tides, p. 1", "2": "Tides, p. 2" });
    expect(exported.footnotes).toBe(2);
    expect(exported.citations).toBe(3);
  });

  test("a Document removed since makes a found and a not-found Citation of one place one unverified footnote (#2292)", async () => {
    const { printer } = fakePrinter();
    const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, "Tides.txt", "The tide rises twice a day.");
    const [tides] = await addAndProcess(core, [path]);
    const mind = await core.createMind({ title: "Memo" });
    const client = await connectToMind(core, mind.id);
    const cite = (check: "found" | "not-found"): JSONContent => ({
      type: "citation",
      attrs: {
        passageId: "passage-1",
        documentId: tides?.id ?? "",
        documentName: "Tides",
        contentHash: tides?.contentHash ?? null,
        pageFrom: 1,
        pageTo: 1,
        quote: "The tide rises twice a day.",
        check,
        checkReason: null,
      },
    });
    writeMind(client, [
      { type: "paragraph", content: [text("One."), cite("found")] },
      { type: "paragraph", content: [text("Two."), cite("not-found")] },
    ]);
    await client.settled();
    await core.deleteDocuments([tides?.id ?? ""]);
    const live = await core.listDocuments();
    // Neither can be checked now: one unverified footnote, as the file has it.
    const screen = numberFootnotes(readMind(client), "numbered", { documents: live }).citations;
    expect(screen.map((each) => each.number)).toEqual([1, 1]);
    const exported = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(exported.data);
    expect(footnotesOf(part(files, "word/footnotes.xml"))).toEqual({
      "1": "Tides, p. 1 [unverified]",
    });
    expect(exported.footnotes).toBe(1);
    expect(
      shownMarks(part(files, "word/document.xml")).map((each) => `${each.mark} ${each.shows}`),
    ).toEqual(["reference 1", "noteref 1"]);
  });

  test("ten Citations of one résumé at two pages make two footnotes, and the other eight refer to them", async () => {
    const { document, footnotes, exported } = await exportWith([1, 1, 2, 1, 1, 2, 1, 1, 2, 1]);
    expect(exported.citations).toBe(10);
    expect(exported.footnotes).toBe(2);
    expect(footnotes).toEqual({ "1": "黄珊简历, p. 1", "2": "黄珊简历, p. 2" });

    const found = crossReferences(document);
    expect(found.marks).toEqual([1, 2]);
    expect(found.referenced).toHaveLength(8);
    expect(found.begins).toBe(8);
    expect(found.ends).toBe(8);
    // Each note's mark is inside a bookmark of its own, and each cross-reference names one.
    expect(found.bookmarks.map((each) => each.note)).toEqual([1, 2]);
    expect(new Set(found.bookmarks.map((each) => each.id)).size).toBe(2);
    expect(new Set(found.bookmarks.map((each) => each.name)).size).toBe(2);
    const [first, second] = found.bookmarks;
    expect(found.results.map((each) => each.name)).toEqual([
      first?.name,
      first?.name,
      first?.name,
      second?.name,
      first?.name,
      first?.name,
      second?.name,
      first?.name,
    ]);
    // Until Word updates them, they show the numbers of the notes, as Word counts them.
    expect(found.results.map((each) => each.shows)).toEqual([1, 1, 1, 2, 1, 1, 2, 1]);
    expect(document).not.toContain("\u0001");
    expect(document).not.toContain("\u0002");
  });

  test("a Citation cited once leaves the document as it was: no bookmark, no field", async () => {
    const { document, footnotes } = await exportWith([1, 2]);
    expect(Object.keys(footnotes)).toEqual(["1", "2"]);
    expect(document).not.toContain("bookmarkStart");
    expect(document).not.toContain("fldChar");
  });

  test("five Citations across two pages are 2 footnotes in the file, and the Saved line says so (#2193)", async () => {
    const { document, footnotes, exported } = await exportWith([1, 1, 1, 2, 2]);
    expect(exported.citations).toBe(5);
    expect(exported.citationPlace).toBe("footnotes");
    expect(exported.footnotes).toBe(2);
    expect(Object.keys(footnotes)).toHaveLength(2);
    expect(crossReferences(document).marks).toEqual([1, 2]);
  });

  test("one Citation on one page is 1 footnote", async () => {
    const { footnotes, exported } = await exportWith([1]);
    expect(exported.footnotes).toBe(1);
    expect(Object.keys(footnotes)).toHaveLength(1);
  });

  test("Citations all on one page are 1 footnote", async () => {
    const { footnotes, exported } = await exportWith([2, 2, 2, 2]);
    expect(exported.citations).toBe(4);
    expect(exported.footnotes).toBe(1);
    expect(Object.keys(footnotes)).toHaveLength(1);
  });

  test("a list at the end writes no footnotes, so the line counts its Citations", async () => {
    const { document, exported } = await exportWith([1, 1, 1, 2, 2], { citationPlace: "list" });
    expect(exported.citationPlace).toBe("list");
    expect(exported.citations).toBe(5);
    expect(exported.footnotes).toBe(0);
    expect(document).not.toContain("footnoteReference");
  });

  test("a PDF numbers as the Note does: five Citations over two pages are two footnotes", async () => {
    const { exported, printed, screen } = await exportWith([1, 1, 1, 2, 2], { format: "pdf" });
    expect(exported.citations).toBe(5);
    expect(exported.footnotes).toBe(2);
    expect(printed[0]?.notes).toHaveLength(2);
    expect(screen.map((each) => each.number)).toEqual([1, 1, 1, 2, 2]);
  });

  test("a footnote the User wrote is counted too: three Citations beside it are 3 footnotes (#2193)", async () => {
    const { footnotes, exported } = await exportWith([1, 1, 2], { ownFootnote: true });
    expect(exported.citations).toBe(3);
    expect(exported.footnotes).toBe(3);
    expect(Object.keys(footnotes)).toHaveLength(3);
  });

  test("a PDF counts the same note's footnotes, the User's own and a repeat's included: 3 (#2193)", async () => {
    const { exported, printed } = await exportWith([1, 1, 2], { ownFootnote: true, format: "pdf" });
    expect(exported.footnotes).toBe(3);
    expect(printed[0]?.notes).toHaveLength(3);
  });
});

describe("the writer's notes", () => {
  const work = (name: string): CitedWork => ({
    documentId: name,
    documentName: name,
    location: null,
  });
  const footnote = (source: string, unverified = false): Footnote => ({ source, unverified });
  const cited = (source: string, unverified = false, over: Partial<Inline> = {}): Inline =>
    ({
      kind: "citation",
      footnote: footnote(source, unverified),
      work: work(source),
      ...over,
    }) as Inline;
  const styled = (text: string, of: string | undefined, over: Partial<Inline> = {}): Inline =>
    ({
      kind: "cite",
      runs: [{ text }],
      note: true,
      unverified: false,
      ...(of !== undefined && { of }),
      ...over,
    }) as Inline;
  const words = (value: string): Inline => ({
    kind: "text",
    text: value,
    marks: {
      bold: false,
      italic: false,
      strike: false,
      underline: false,
      highlight: false,
      code: false,
      link: null,
    },
  });
  const paragraph = (...content: Inline[]): Block => ({ kind: "paragraph", content });

  function render(blocks: Block[]) {
    const { data, footnotes: count } = renderDocx(blocks, {
      title: "",
      labels: exportLabels("en"),
      language: "en-US",
      paper: "a4",
      created: "2026-10-22T00:00:00Z",
      font: null,
      lineSpacing: null,
    });
    const files = unzip(data);
    for (const [name, content] of files) {
      if (name.endsWith(".xml") || name.endsWith(".rels"))
        checkWellFormed(content.toString("utf8"));
    }
    return {
      document: part(files, "word/document.xml"),
      footnotes: footnotesOf(part(files, "word/footnotes.xml")),
      count,
    };
  }

  test("a source and place cited again, in any kind of block, is cited by the first note's number", () => {
    const { document, footnotes, count } = render([
      paragraph(words("a"), cited("Tides, p. 2")),
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [[paragraph(words("b"), cited("Tides, p. 2"))]],
      },
      {
        kind: "table",
        rows: [
          [
            {
              header: false,
              colspan: 1,
              rowspan: 1,
              align: null,
              content: [paragraph(words("c"), cited("Tides, p. 2"))],
            },
          ],
        ],
      },
    ]);
    expect(footnotes).toEqual({ "1": "Tides, p. 2" });
    expect(count).toBe(1);
    const found = crossReferences(document);
    expect(found.marks).toEqual([1]);
    expect(found.results.map((each) => each.shows)).toEqual([1, 1]);
  });

  test("a footnote of the User's counts in the numbers the cross-references show", () => {
    const own: Inline = { kind: "footnote", content: [words("Mine")] };
    const { document, footnotes, count } = render([
      paragraph(cited("Tides, p. 2"), own, cited("Tides, p. 2"), cited("Waves, p. 1")),
      paragraph(cited("Waves, p. 1"), cited("Tides, p. 2")),
    ]);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Mine", "Waves, p. 1"]);
    expect(count).toBe(3);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([1, 3, 1]);
  });

  // protects=what the User wrote stays as they wrote it when a reference shows its number; fails_when=text that looks like the writer's stand-in for a number is replaced by a number, or a control character of theirs is taken for one; no_claim=none beyond protects.
  test("the User's own brackets and control characters are never taken for the writer's marks", () => {
    const { document } = render([
      paragraph(words("see ⟦1⟧ and ⟦7⟧ in the proof, \u00011\u0002 too"), cited("Tides, p. 2")),
      paragraph(cited("Tides, p. 2"), words(" and ⟦1⟧ again")),
    ]);
    expect(document).toContain("see ⟦1⟧ and ⟦7⟧ in the proof, 1 too");
    expect(document).toContain(" and ⟦1⟧ again");
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([1]);
  });

  // protects=6,000 sources each cited twice each get one bookmark and one reference to it; fails_when=a note is bookmarked twice, two share one id, or a reference shows another note's number; no_claim=speed, which a unit test doesn't time.
  test("6,000 sources each cited twice each get one note and one reference", () => {
    const sources = Array.from({ length: 6_000 }, (_, index) => `Source ${index + 1}, p. 1`);
    const { document, footnotes } = render(
      sources.map((source) => paragraph(cited(source), cited(source))),
    );
    expect(Object.keys(footnotes)).toHaveLength(6_000);
    const found = crossReferences(document);
    expect(found.bookmarks.map((each) => each.note)).toEqual(sources.map((_, index) => index + 1));
    expect(new Set(found.bookmarks.map((each) => each.id)).size).toBe(6_000);
    expect(found.results.map((each) => each.shows)).toEqual(sources.map((_, index) => index + 1));
  });

  // protects=a note says a person's check only where every Citation it stands for carries it; fails_when=a checked line appears for a mark the Note shows unchecked, or a shared line is dropped; no_claim=the words of a check line, which the i18n tests hold.
  test("a check on one Citation of a place and not another writes no check line, in Word and PDF (#2292)", () => {
    const checked: Footnote = {
      source: "Tides, p. 2",
      unverified: false,
      checked: ["Checked by Ada · 28 Oct 2026"],
    };
    const blocks = [
      paragraph(words("a"), cited("Tides, p. 2")),
      paragraph(words("b"), cited("Tides, p. 2", false, { footnote: checked })),
    ];
    // The second mark is checked on screen and the first is not: one note, so it says neither.
    expect(render(blocks).footnotes).toEqual({ "1": "Tides, p. 2" });
    expect(renderPrintHtml(blocks, exportLabels("en")).notes).toEqual(["Tides, p. 2"]);
  });

  test("a check every Citation of a place carries is written once, in Word and PDF, in Chinese too", () => {
    const line = "由 Ada 核对 · 2026年10月28日";
    const checked: Footnote = { source: "Tides, p. 2", unverified: false, checked: [line] };
    const blocks = [
      paragraph(words("a"), cited("Tides, p. 2", false, { footnote: checked })),
      paragraph(words("b"), cited("Tides, p. 2", false, { footnote: checked })),
    ];
    expect(render(blocks).footnotes).toEqual({ "1": `Tides, p. 2\n${line}` });
    expect(renderPrintHtml(blocks, exportLabels("zh-CN")).notes).toEqual([
      `Tides, p. 2<br><span class="checked-by">${line}</span>`,
    ]);
  });

  test("two people's checks on one place write no line rather than one that isn't every mark's", () => {
    const check = (line: string): Footnote => ({
      source: "Tides, p. 2",
      unverified: false,
      checked: [line],
    });
    const blocks = [
      paragraph(
        words("a"),
        cited("Tides, p. 2", false, { footnote: check("Checked by Ada · 28 Oct 2026") }),
      ),
      paragraph(
        words("b"),
        cited("Tides, p. 2", false, { footnote: check("Checked by Bob · 29 Oct 2026") }),
      ),
    ];
    expect(render(blocks).footnotes).toEqual({ "1": "Tides, p. 2" });
    expect(renderPrintHtml(blocks, exportLabels("en")).notes).toEqual(["Tides, p. 2"]);
  });

  test("a line with a dollar sign in a person's name is written as it is", () => {
    const checked: Footnote = {
      source: "Tides, p. 2",
      unverified: false,
      checked: ["Checked by A$&B · 28 Oct 2026"],
    };
    const blocks = [
      paragraph(words("a"), cited("Tides, p. 2", false, { footnote: checked })),
      paragraph(words("b"), cited("Tides, p. 2", false, { footnote: checked })),
    ];
    expect(render(blocks).footnotes).toEqual({ "1": "Tides, p. 2\nChecked by A$&B · 28 Oct 2026" });
  });

  test("a Citation whose check is not the same, or whose address is not, has a note of its own", () => {
    const { document, footnotes } = render([
      paragraph(
        cited("Tides, p. 2"),
        cited("Tides, p. 2", true),
        cited("Tides, p. 2", true),
        cited("Page", false, {
          footnote: { source: "Page", unverified: false, link: "https://a" },
        }),
        cited("Page", false, {
          footnote: { source: "Page", unverified: false, link: "https://b" },
        }),
      ),
    ]);
    expect(Object.values(footnotes)).toEqual([
      "Tides, p. 2",
      "Tides, p. 2 [unverified]",
      "Page",
      "Page",
    ]);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([2]);
  });

  test("a Citation a change still waiting adds or removes is a note of its own in Word and the PDF, so no later number moves", () => {
    const change = { id: "p1", at: null };
    const blocks = [
      paragraph(words("a"), cited("Tides, p. 2", false, { inserted: change })),
      paragraph(words("b"), cited("Tides, p. 2")),
      paragraph(words("c"), cited("Tides, p. 2", false, { deleted: change })),
      paragraph(words("d"), cited("Tides, p. 2")),
    ];
    // A change's Citation stands for itself (#107), so accepting or rejecting the change never
    // leaves a cross-reference without a note; the live marks share theirs. The numbers after it
    // are the Note's too.
    const { document, footnotes } = render(blocks);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Tides, p. 2", "Tides, p. 2"]);
    const found = crossReferences(document);
    expect(found.marks).toEqual([1, 2, 3]);
    expect(found.results.map((each) => each.shows)).toEqual([2]);
    const printed = renderPrintHtml(blocks, exportLabels("en"));
    // The Citations' markers are 1, 2, 3 and 2, as the Note and Word have them; the PDF's own
    // notes on the changes take 4 and 5, after every Citation's note.
    expect([...printed.body.matchAll(/data-note="(\d+)"/g)].map((each) => Number(each[1]))).toEqual(
      [1, 4, 2, 3, 5, 2],
    );
  });

  test("a waiting change before a later Citation moves no number: the Note's, Word's and the PDF's marks are 1, 2, 3", () => {
    const change = { id: "p1", at: null };
    const blocks = [
      paragraph(words("a"), cited("Tides, p. 1", false, { inserted: change })),
      paragraph(words("b"), cited("Tides, p. 1")),
      paragraph(words("c"), cited("Moon, p. 1")),
    ];
    const { document } = render(blocks);
    expect(crossReferences(document).marks).toEqual([1, 2, 3]);
    const printed = renderPrintHtml(blocks, exportLabels("en"));
    // The change's own note is the PDF's fourth, after the Citations' notes, so the marks before
    // it are the Note's numbers.
    expect(
      [...printed.body.matchAll(/<sup class="note-ref" data-note="(\d+)"/g)].map((found) =>
        Number(found[1]),
      ),
    ).toEqual([1, 2, 3]);
    expect(printed.notes).toHaveLength(4);
    expect(printed.notes[3]).toContain("Inserted");
  });

  test("a Citation a change still waiting adds or removes is never the note others refer to, nor refers to one", () => {
    const change = { id: "p1", at: null };
    const { footnotes, document } = render([
      paragraph(
        cited("Tides, p. 2", false, { inserted: change }),
        cited("Tides, p. 2"),
        cited("Tides, p. 2", false, { deleted: change }),
        cited("Tides, p. 2"),
      ),
    ]);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Tides, p. 2", "Tides, p. 2"]);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([2]);
  });

  test("a Citation in a Block a change still waiting adds or removes shares no note either", () => {
    const change = { id: "b1", at: null };
    const { footnotes, document } = render([
      { ...paragraph(cited("Tides, p. 2")), inserted: change },
      { ...paragraph(cited("Tides, p. 2")), deleted: change },
      paragraph(cited("Tides, p. 2"), cited("Tides, p. 2")),
    ]);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Tides, p. 2", "Tides, p. 2"]);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([3]);
  });

  test("a Citation in a to-do a change still waiting adds or removes shares no note either", () => {
    const change = { id: "t1", at: null };
    const { footnotes } = render([
      {
        kind: "list",
        ordered: false,
        start: 1,
        checked: [false, false],
        items: [
          [{ ...paragraph(cited("Tides, p. 2")), inserted: change }],
          [paragraph(cited("Tides, p. 2"))],
        ],
      },
    ]);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Tides, p. 2"]);
  });

  test("a Citation of another version of a Document has a note of its own", () => {
    const first = { ...work("Tides, p. 2"), contentHash: "h1" };
    const later = { ...work("Tides, p. 2"), contentHash: "h2" };
    const { footnotes, document } = render([
      paragraph(
        cited("Tides, p. 2", false, { work: first }),
        cited("Tides, p. 2", false, { work: first }),
        cited("Tides, p. 2", false, { work: later }),
        cited("Tides, p. 2", false, { work: first }),
      ),
    ]);
    expect(Object.values(footnotes)).toEqual(["Tides, p. 2", "Tides, p. 2"]);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([1, 1]);
  });

  test("two Documents with one name have a note each", () => {
    const { footnotes, document } = render([
      paragraph(
        cited("Notes", false, { work: work("a") }),
        cited("Notes", false, { work: work("b") }),
        cited("Notes", false, { work: work("a") }),
      ),
    ]);
    expect(Object.values(footnotes)).toEqual(["Notes", "Notes"]);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([1]);
  });

  test("a citation style's own form for a repeat is a note of its own; the same form again is a reference", () => {
    const { document, footnotes, count } = render([
      paragraph(
        styled("Smith, Tides, 5.", "a"),
        styled("Id.", "a"),
        styled("Id.", "a"),
        styled("Smith, Tides, 5.", "a"),
        styled("Jones, Waves, 9.", "b"),
        styled("Jones, Waves, 9.", "b"),
        styled("No key.", undefined),
        styled("No key.", undefined),
      ),
    ]);
    expect(Object.values(footnotes)).toEqual([
      "Smith, Tides, 5.",
      "Id.",
      "Id.",
      "Jones, Waves, 9.",
      "No key.",
      "No key.",
    ]);
    expect(count).toBe(6);
    expect(crossReferences(document).results.map((each) => each.shows)).toEqual([1, 4]);
  });
});

describe("the Note, Word, the PDF and Copy with Citations number one way (#2292)", () => {
  const words = (text: string): Inline => ({ kind: "text", text, marks: NO_MARKS });
  const paragraph = (...content: Inline[]): Block => ({ kind: "paragraph", content });
  const written = (value: string): JSONContent => ({ type: "text", text: value });

  test("five Citations over two sources and places, and a removed Document's pair, read the same", async () => {
    const { printed: pages, printer } = fakePrinter();
    const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
    const sources = await createTempDataFolder();
    const tidesPath = await writeSourceFile(sources, "Tides.txt", "The tide rises twice a day.");
    const moonPath = await writeSourceFile(sources, "Moon.txt", "The Moon pulls the tides.");
    const gonePath = await writeSourceFile(sources, "Notes.txt", "Remember the tide tables.");
    const [tides, moon, gone] = await addAndProcess(core, [tidesPath, moonPath, gonePath]);
    const mind = await core.createMind({ title: "Memo" });
    const client = await connectToMind(core, mind.id);

    /** One Citation's source and place, the check it was made with, and a Proposal's mark. */
    const places = [
      { document: tides, page: 1, check: "found" },
      { document: tides, page: 1, check: "found" },
      { document: tides, page: 2, check: "found" },
      { document: moon, page: 1, check: "found" },
      { document: moon, page: 1, check: "found" },
      { document: gone, page: 1, check: "found" },
      { document: gone, page: 1, check: "not-found" },
      { document: tides, page: 1, check: "found", pending: true },
    ] as const;
    const pending = (place: (typeof places)[number]) =>
      "pending" in place && place.pending === true;
    const cite = (place: (typeof places)[number], index: number): JSONContent => ({
      type: "citation",
      attrs: {
        passageId: `passage-${index}`,
        documentId: place.document?.id ?? "",
        documentName: place.document?.name ?? "",
        contentHash: place.document?.contentHash ?? null,
        pageFrom: place.page,
        pageTo: place.page,
        quote: "A quoted sentence.",
        check: place.check,
        checkReason: null,
        ...(pending(place) && {
          [PROPOSAL_ATTRIBUTE]: { id: `pending-${index}`, request: "request", kind: "insert" },
        }),
      },
    });
    writeMind(
      client,
      places.map((place, index) => ({
        type: "paragraph",
        content: [written(`Sentence ${index + 1}.`), cite(place, index)],
      })),
    );
    await client.settled();
    // A Document removed since can't be checked: its found and not-found marks are one footnote.
    await core.deleteDocuments([gone?.id ?? ""]);
    const live = await core.listDocuments();
    // One source and place is one note; a Proposal's Citation is a note of its own everywhere
    // (#107), so it does not move the numbers after it either.
    const numbers = [1, 1, 2, 3, 3, 4, 4, 5];

    // The Note: one footnote for each source and place, a later mark repeating its number.
    const doc = readMind(client);
    const note = numberFootnotes(doc, "numbered", { documents: live });
    expect(note.citations.map((each) => each.number)).toEqual(numbers);
    expect(note.citations.filter((each) => each.footnote)).toHaveLength(5);

    // The PDF: the same marks with the same numbers, one note for each source and place.
    const unverified = new Set([gone?.id]);
    const blocks = places.map((place, index) =>
      paragraph(words(`Sentence ${index + 1}.`), {
        kind: "citation",
        footnote: {
          source: `${place.document?.name}, p. ${place.page}`,
          unverified: unverified.has(place.document?.id),
        },
        work: {
          documentId: place.document?.id ?? null,
          documentName: place.document?.name ?? null,
          location: { kind: "page", from: place.page, to: place.page },
          contentHash: place.document?.contentHash ?? null,
        },
        ...(pending(place) && { inserted: { id: `pending-${index}`, at: null } }),
      }),
    );
    const pdf = renderPrintHtml(blocks, exportLabels("en"));
    // The Citations' markers are the Note's numbers; the PDF's own note on the change has a
    // class of its own and comes after them, so it moves no Citation's number.
    expect(
      [...pdf.body.matchAll(/<sup class="note-ref" data-note="(\d+)"/g)].map((found) =>
        Number(found[1]),
      ),
    ).toEqual(numbers);
    // The Citations' five notes, and the PDF's own note that says the change.
    expect(pdf.notes).toHaveLength(6);

    // Copy with Citations: the same numbers in the markers it writes.
    const copied = noteNumbers(citationsIn(doc.content), {
      language: "en",
      documents: live,
      kept: [],
    });
    expect(copied).toEqual(numbers);

    // The Word file counts the same footnotes, and its marks show the same numbers.
    const exported = await core.exportMind(mind.id, { format: "docx" });
    expect(exported.footnotes).toBe(5);
    const files = unzip(exported.data);
    expect(shownMarks(part(files, "word/document.xml")).map((each) => each.shows)).toEqual(numbers);

    // The app's own PDF reads the Note with its waiting change too: the same marks, the same
    // numbers, the change's own note after them.
    await core.exportMind(mind.id, { format: "pdf" });
    const pdfBody = pages.at(-1)?.body ?? "";
    expect(
      [...pdfBody.matchAll(/<sup class="note-ref" data-note="(\d+)"/g)].map((found) =>
        Number(found[1]),
      ),
    ).toEqual(numbers);
    // A change that ends with a Citation keeps the comma its own note shows right after it,
    // though the note itself is printed after the Citations' (#2292).
    expect(pdfBody).toContain('</ins><sup class="note-ref change-note" data-note="6">,6</sup>');
  });
});
