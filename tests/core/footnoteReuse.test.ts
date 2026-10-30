import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { CitationPlace, CitedWork } from "../../src/core/api";
import { renderDocx } from "../../src/core/exports/docx";
import { exportLabels } from "../../src/core/exports/labels";
import type { Block, Footnote, Inline } from "../../src/core/mindText";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { checkWellFormed, footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
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

describe("a Word export of a Mind that cites a source again", () => {
  const citation = (documentId: string, contentHash: string | null, page: number): JSONContent => ({
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId,
      documentName: "黄珊简历",
      contentHash,
      pageFrom: page,
      pageTo: page,
      quote: "黄珊，产品经理。",
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
    }: { citationPlace?: CitationPlace; format?: "docx" | "pdf"; ownFootnote?: boolean } = {},
  ) {
    const { printed, printer } = fakePrinter();
    const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, "黄珊简历.txt", "黄珊，产品经理。");
    const [resume] = await addAndProcess(core, [path]);
    const mind = await core.createMind({ title: "总结" });
    const client = await connectToMind(core, mind.id);
    writeMind(
      client,
      pages.map((page, index) => ({
        type: "paragraph",
        content: [
          text(`第 ${index + 1} 句`),
          citation(resume?.id ?? "", resume?.contentHash ?? null, page),
          ...(ownFootnote && index === 0
            ? [{ type: "footnote", attrs: { id: "own-1" }, content: [text("我的注。")] }]
            : []),
          text("。"),
        ],
      })),
    );
    await client.settled();
    const exported = await core.exportMind(mind.id, {
      format,
      ...(citationPlace !== undefined && { citationPlace }),
    });
    if (format === "pdf") return { document: "", footnotes: {}, exported, printed };
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
    };
  }

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

  test("a PDF places each Citation as its own footnote, so the same note says 5", async () => {
    const { exported, printed } = await exportWith([1, 1, 1, 2, 2], { format: "pdf" });
    expect(exported.citations).toBe(5);
    expect(exported.footnotes).toBe(5);
    expect(printed[0]?.notes).toHaveLength(5);
  });

  test("a footnote the User wrote is counted too: three Citations beside it are 3 footnotes (#2193)", async () => {
    const { footnotes, exported } = await exportWith([1, 1, 2], { ownFootnote: true });
    expect(exported.citations).toBe(3);
    expect(exported.footnotes).toBe(3);
    expect(Object.keys(footnotes)).toHaveLength(3);
  });

  test("a PDF counts the same note's footnotes, the User's own included: 4 (#2193)", async () => {
    const { exported, printed } = await exportWith([1, 1, 2], { ownFootnote: true, format: "pdf" });
    expect(exported.footnotes).toBe(4);
    expect(printed[0]?.notes).toHaveLength(4);
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
