/**
 * A Note main's import stored exports, with no edit, as the file it came from, byte for byte
 * (#746). The export reads some lists differently from main's import: through a list style, with
 * a level that draws no number, at a level linked to a style, under a numbered heading. The
 * export compares the stored Note with the file as it reads it, so a Note main stored must not
 * look edited. Each Note is built here as main's import (commit 09cb58343a,
 * `src/core/documents/formats/docxImport.ts`) stores it: its lists, their kind and start, and
 * which paragraphs each holds, from the paragraphs the import made.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { unzip } from "../helpers/docx";
import { editMind } from "../helpers/minds";
import { paragraph, run, STYLES, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const lvl = (ilvl: number, format: string, text: string, more = "") =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${more}<w:lvlText w:val="${text}"/></w:lvl>`;
const abstract = (id: number, levels: string, more = "") =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>${more}${levels}</w:abstractNum>`;
const num = (id: number, of: number) =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${of}"/></w:num>`;
const styled = (id: string) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`;

/** A Note's blocks as main stores them: an imported paragraph by its place, or a list of them. */
type Stored = number | { type: "orderedList" | "bulletList"; start: number; items: number[] };

interface Case {
  file: Buffer;
  stored: Stored[];
}

/** The four readings in one language: `t` gives the texts, `counting` the numbers' format. */
const cases = (t: readonly string[], counting: string): Record<string, Case> => ({
  // Main never finds the list style, so its bullets come out a numbered list.
  "bullets from a list style": {
    file: wordFile({
      styles: `${STYLES}<w:style w:type="numbering" w:styleId="Bullets"><w:name w:val="Bullets"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>`,
      numbering:
        abstract(0, "", '<w:numStyleLink w:val="Bullets"/>') +
        abstract(1, lvl(0, "bullet", "•"), '<w:styleLink w:val="Bullets"/>') +
        num(1, 0) +
        num(2, 1),
      body: [t[0], t[1], t[2]].map((each) => paragraph(each ?? "", { numId: 1, ilvl: 0 })).join(""),
    }),
    stored: [{ type: "orderedList", start: 1, items: [0, 1, 2] }],
  },
  // Main doesn't count the level that draws no number, so the second list goes on from the first.
  "a level that draws no number": {
    file: wordFile({
      numbering: abstract(0, lvl(0, "none", "") + lvl(1, counting, "%2.")) + num(1, 0),
      body: [0, 1, 2, 3, 4]
        .map((at) => paragraph(t[at] ?? "", { numId: 1, ilvl: at === 0 || at === 3 ? 0 : 1 }))
        .join(""),
    }),
    stored: [
      0,
      { type: "orderedList", start: 1, items: [1, 2] },
      3,
      { type: "orderedList", start: 3, items: [4] },
    ],
  },
  // Main reads a level only from the paragraph's or its style's numbering, so all are one level.
  "levels linked to the styles": {
    file: wordFile({
      styles: `${styled("Article")}${styled("Section")}${STYLES}`,
      numbering:
        abstract(
          0,
          lvl(0, counting, "%1.", '<w:pStyle w:val="Article"/>') +
            lvl(1, counting, "%1.%2", '<w:pStyle w:val="Section"/>'),
        ) + num(1, 0),
      body: [0, 1, 2, 3, 4]
        .map((at) =>
          paragraph(run(t[at] ?? ""), { style: at === 0 || at === 2 ? "Article" : "Section" }),
        )
        .join(""),
    }),
    stored: [{ type: "orderedList", start: 1, items: [0, 1, 2, 3, 4] }],
  },
  // Main doesn't count a numbered heading, so the sub-clauses under the second go on from the first's.
  "sub-clauses under numbered headings": {
    file: wordFile({
      numbering: abstract(0, lvl(0, counting, "%1.") + lvl(1, counting, "%1.%2")) + num(1, 0),
      body: [0, 1, 2, 3, 4]
        .map((at) =>
          at === 0 || at === 2
            ? paragraph(run(t[at] ?? ""), { style: "Heading1", numId: 1, ilvl: 0 })
            : paragraph(t[at] ?? "", { numId: 1, ilvl: 1 }),
        )
        .join(""),
    }),
    stored: [
      0,
      { type: "orderedList", start: 1, items: [1] },
      2,
      { type: "orderedList", start: 2, items: [3, 4] },
    ],
  },
});

const LANGUAGES = {
  English: cases(
    [
      "Services",
      "The studio designs the packaging.",
      "Fees",
      "The fee is monthly.",
      "It is due in 30 days.",
    ],
    "decimal",
  ),
  Chinese: cases(
    ["服务内容", "工作室设计包装。", "费用", "服务费按月支付。", "三十日内付清。"],
    "chineseCounting",
  ),
};

const isList = (node: JSONContent) => /List$/.test(node.type ?? "");

/** The Note rebuilt as `stored` says, from the paragraphs and lists the import made. */
function rebuilt(blocks: JSONContent[], stored: readonly Stored[]): JSONContent[] {
  const paragraphs: JSONContent[] = [];
  const items: JSONContent[] = [];
  const lists: JSONContent[] = [];
  const visit = (node: JSONContent, item: JSONContent | null) => {
    if (isList(node)) lists.push(node);
    if (node.type === "paragraph" || node.type === "heading") {
      paragraphs.push(node);
      items.push(item ?? { type: "listItem" });
      return;
    }
    for (const each of node.content ?? []) visit(each, node.type === "listItem" ? node : item);
  };
  for (const block of blocks) visit(block, null);
  let list = 0;
  return stored.map((each) => {
    if (typeof each === "number") return paragraphs[each] ?? { type: "paragraph" };
    const attrs = lists[list++]?.attrs ?? {};
    return {
      type: each.type,
      attrs: { ...attrs, start: each.start },
      content: each.items.map((at) => ({
        ...items[at],
        content: [paragraphs[at] ?? { type: "paragraph" }],
      })),
    };
  });
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  const [left, right] = [unzip(a), unzip(b)];
  return [...left].filter(([name, data]) => !right.get(name)?.equals(data)).map(([name]) => name);
};

describe("a Note main's import stored, exported with no edit", () => {
  // protects=a Note main stored, whose lists main read differently from how the export now reads them (bullets from a list style as a numbered list, a level that draws no number, levels linked to styles, sub-clauses under numbered headings), exports as its file byte for byte, in English and Chinese, so lists the User never touched aren't rewritten; fails_when=any entry of the export differs from the file's; no_claim=a Note the User edited, which the other Word tests cover.
  test.each(
    Object.entries(LANGUAGES).flatMap(([language, all]) =>
      Object.entries(all).map(([reading, each]) => [language, reading, each] as const),
    ),
  )("%s: %s", async (_language, _reading, { file, stored }) => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mindId, client } = await importWordBytes(core, dataDir, file, { origin: "own" });
    editMind(client, (blocks) => rebuilt(blocks, stored));
    await client.settled();
    const exported = (await core.exportMind(mindId, { format: "docx" })).data;
    expect(sameBytes(file, exported)).toEqual([]);
    expect([...unzip(exported).keys()].sort()).toEqual([...unzip(file).keys()].sort());
  });
});
