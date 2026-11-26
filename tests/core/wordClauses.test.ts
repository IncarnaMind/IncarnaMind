/**
 * A contract's numbered clauses back into its Word file (#746): whatever numbers them (each
 * heading's own numbering, the heading style's, a body style's, a level linked to a style, or a
 * list style), a clause the User adds is numbered among them, one whose level they change moves
 * a level in the numbering, and typed numbers stay text. Each file's numbers are read as Word
 * reads them, through the shared reader the import uses.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { numbersIn } from "../helpers/docx";
import { editMind } from "../helpers/minds";
import { paragraph, run, STYLES, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const definition = (levels: readonly [string, string][], id = 0, extra = "") =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>${extra}${levels
    .map(([format, text], level) => {
      const [fmt, style] = format.split("@");
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:lvlText w:val="${text}"/></w:lvl>`;
    })
    .join("")}</w:abstractNum>`;
const num = (id: number, abstract: number) =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/></w:num>`;

/** A paragraph style, based on Normal, with its own numbering and outline level if given, named as Word names its own. */
const style = (id: string, numPr = "", outline: number | null = null) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id.replace(/^Heading(\d)$/, "heading $1")}"/><w:basedOn w:val="Normal"/><w:pPr>${numPr}${outline === null ? "" : `<w:outlineLvl w:val="${outline}"/>`}</w:pPr></w:style>`;
const numPr = (numId: number, ilvl?: number) =>
  `<w:numPr>${ilvl === undefined ? "" : `<w:ilvl w:val="${ilvl}"/>`}<w:numId w:val="${numId}"/></w:numPr>`;

/** Two clauses with their sub-clauses, what the User adds, and how Word numbers each level. */
const ENGLISH = {
  levels: [
    ["decimal", "%1."],
    ["decimal", "%1.%2"],
  ] as [string, string][],
  title: "Services Agreement",
  clauses: ["Services", "Fees"] as [string, string],
  subs: [
    ["Brightwater Studio designs the packaging."],
    ["Alder & Finch Ltd pays each month.", "Fees are due within 30 days."],
  ] as [string[], string[]],
  newClause: "Termination",
  newSub: "Late fees are capped.",
  clause: (n: number) => `${n}.`,
  sub: (n: number, m: number) => `${n}.${m}`,
};

const CHINESE = {
  levels: [
    ["chineseCounting", "第%1条"],
    ["chineseCounting", "（%2）"],
  ] as [string, string][],
  title: "服务合同",
  clauses: ["服务内容", "费用"] as [string, string],
  subs: [["青禾设计工作室设计包装。"], ["远帆贸易有限公司按月付款。", "费用在三十日内支付。"]] as [
    string[],
    string[],
  ],
  newClause: "合同解除",
  newSub: "滞纳金以费用为限。",
  clause: (n: number) => `第${"一二三四五"[n - 1]}条`,
  sub: (_n: number, m: number) => `（${"一二三四五"[m - 1]}）`,
};

type Contract = typeof ENGLISH;
const LANGUAGES = [
  ["English", ENGLISH],
  ["Chinese", CHINESE],
] as const;

/** How a file numbers its clauses and sub-clauses: what a heading and a sub-clause paragraph carry, and its styles. */
interface Numbered {
  styles: string;
  numbering: (contract: Contract) => string;
  clause: (text: string) => string;
  sub: (text: string) => string;
}

const OWN: Numbered = {
  styles: STYLES,
  numbering: (contract) => definition(contract.levels) + num(1, 0),
  clause: (text) => paragraph(run(text), { style: "Heading1", numId: 1, ilvl: 0 }),
  sub: (text) => paragraph(run(text), { numId: 1, ilvl: 1 }),
};

/** As Word's legal templates do: the heading and clause styles carry the numbering, each its level. */
const BY_STYLE: Numbered = {
  styles: `${STYLES.replace(/<w:style w:type="paragraph" w:styleId="Heading1">.*?<\/w:style>/, "")}${style("Heading1", numPr(1, 0), 0)}${style("Clause", numPr(1, 1))}`,
  numbering: OWN.numbering,
  clause: (text) => paragraph(run(text), { style: "Heading1" }),
  sub: (text) => paragraph(run(text), { style: "Clause" }),
};

/** The styles name the list only; the numbering's levels name the style each is for. */
const LINKED: Numbered = {
  styles: `${style("Article", numPr(1), 0)}${style("Section", numPr(1))}${STYLES}`,
  numbering: (contract) =>
    definition([
      [`${contract.levels[0]?.[0]}@Article`, contract.levels[0]?.[1] ?? ""],
      [`${contract.levels[1]?.[0]}@Section`, contract.levels[1]?.[1] ?? ""],
    ]) + num(1, 0),
  clause: (text) => paragraph(run(text), { style: "Article" }),
  sub: (text) => paragraph(run(text), { style: "Section" }),
};

/** A list style: the paragraphs' list links to it, and its own list holds the levels. */
const LIST_STYLE: Numbered = {
  styles: `${STYLES}<w:style w:type="numbering" w:styleId="Contract"><w:name w:val="Contract"/><w:pPr>${numPr(2)}</w:pPr></w:style>`,
  numbering: (contract) =>
    definition([], 0, '<w:numStyleLink w:val="Contract"/>') +
    definition(contract.levels, 1, '<w:styleLink w:val="Contract"/>') +
    num(1, 0) +
    num(2, 1),
  clause: OWN.clause,
  sub: OWN.sub,
};

const NUMBERINGS = [
  ["each heading's own numbering", OWN],
  ["the heading and clause styles", BY_STYLE],
  ["levels linked to the styles", LINKED],
  ["a list style", LIST_STYLE],
] as const;

/** Each way of numbering, in each language. */
const CASES = NUMBERINGS.flatMap(([how, numbering]) =>
  LANGUAGES.map(([language, contract]) => [how, language, numbering, contract] as const),
);

const fileOf = (numbered: Numbered, contract: Contract) =>
  wordFile({
    styles: numbered.styles,
    numbering: numbered.numbering(contract),
    body: [
      paragraph(run(contract.title), { style: "Title" }),
      numbered.clause(contract.clauses[0]),
      ...contract.subs[0].map(numbered.sub),
      numbered.clause(contract.clauses[1]),
      ...contract.subs[1].map(numbered.sub),
    ].join(""),
  });

/** The file's numbers as Word draws them, after its title: the sub-clauses of each clause in `subs`. */
const expected = (contract: Contract, clauses: string[], subs: string[][]) => [
  contract.title,
  ...clauses.flatMap((clause, n) => [
    `${contract.clause(n + 1)} ${clause}`,
    ...(subs[n] ?? []).map((text, m) => `${contract.sub(n + 1, m + 1)} ${text}`),
  ]),
];

const textOfNode = (node: JSONContent): string =>
  node.text ?? (node.content ?? []).map(textOfNode).join("");

async function editedExport(bytes: Buffer, edit: (blocks: JSONContent[]) => JSONContent[]) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  editMind(client, edit);
  await client.settled();
  return (await core.exportMind(mindId, { format: "docx" })).data;
}

/** A sub-clause after the one whose text is `after`, as Enter at its end makes it. */
const addSub =
  (after: string, text: string) =>
  (blocks: JSONContent[]): JSONContent[] => {
    const visit = (node: JSONContent): JSONContent => {
      const content = node.content ?? [];
      const at = content.findIndex(
        (each) => each.type === "listItem" && textOfNode(each.content?.[0] ?? {}) === after,
      );
      if (at < 0) return { ...node, content: content.map(visit) };
      const item = {
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      };
      return { ...node, content: [...content.slice(0, at + 1), item, ...content.slice(at + 1)] };
    };
    return blocks.map(visit);
  };

describe("a contract's numbered clauses after an edit", () => {
  // protects=the import reads each way of numbering clauses so the export can keep it: a word changed in every clause and sub-clause leaves every number as the file had it, in English and Chinese; fails_when=a paragraph loses its number or gets another; no_claim=what the Note draws before each item.
  test.each(CASES)(
    "numbered by %s (%s): every paragraph edited keeps its number",
    async (_how, _language, numbering, contract) => {
      const bytes = fileOf(numbering, contract);
      const numbers = expected(contract, [...contract.clauses], [...contract.subs]);
      expect(numbersIn(new Uint8Array(bytes))).toEqual(numbers);
      const data = await editedExport(bytes, (blocks) => {
        const visit = (node: JSONContent): JSONContent =>
          node.type === "text"
            ? { ...node, text: `${node.text} ` }
            : { ...node, ...(node.content && { content: node.content.map(visit) }) };
        return blocks.map(visit);
      });
      expect(numbersIn(data).map((line) => line.trimEnd())).toEqual(numbers);
    },
  );

  // protects=a sub-clause the User adds after another is numbered at its level among them, and the ones after it count on, whatever numbers the clauses; fails_when=it is unnumbered, at another level, or the later numbers don't move; no_claim=a sub-clause dragged into another clause.
  test.each(CASES)(
    "numbered by %s (%s): an added sub-clause is numbered",
    async (_how, _language, numbering, contract) => {
      const [first = "", second = ""] = contract.subs[1];
      const data = await editedExport(fileOf(numbering, contract), addSub(first, contract.newSub));
      expect(numbersIn(data)).toEqual(
        expected(
          contract,
          [...contract.clauses],
          [contract.subs[0], [first, contract.newSub, second]],
        ),
      );
    },
  );

  // protects=a clause heading the User adds right after a clause's heading is numbered as the next clause, as the heading before it is, not as the unnumbered title, and the clauses after it count on, whatever numbers the clauses, in English and Chinese; fails_when=it comes back unnumbered, as in the 8 synthetic contracts of the corpus on main; no_claim=a heading of a level no clause has.
  test.each(CASES)(
    "numbered by %s (%s): an added clause heading is numbered",
    async (_how, _language, numbering, contract) => {
      const data = await editedExport(fileOf(numbering, contract), (blocks) => {
        const at = blocks.findIndex(
          (each) => each.type === "heading" && textOfNode(each) === contract.clauses[0],
        );
        const added = {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: contract.newClause }],
        };
        return [...blocks.slice(0, at + 1), added, ...blocks.slice(at + 1)];
      });
      expect(numbersIn(data)).toEqual(
        expected(
          contract,
          [contract.clauses[0], contract.newClause, contract.clauses[1]],
          [[], contract.subs[0], contract.subs[1]],
        ),
      );
    },
  );

  // protects=a clause heading the User makes a level lower, numbered by its own numbering, goes a level deeper in that numbering, as a list item's Tab does; fails_when=it keeps the first level's number ("2." where it now sits under "1."); no_claim=headings numbered by their style, whose new style brings its own level.
  test.each(LANGUAGES)(
    "%s: a clause heading made a sub-heading goes a level deeper",
    async (_language, contract) => {
      const data = await editedExport(fileOf(OWN, contract), (blocks) =>
        blocks.map((block) =>
          block.type === "heading" && textOfNode(block) === contract.clauses[1]
            ? { ...block, attrs: { ...block.attrs, level: 2 } }
            : block,
        ),
      );
      const lines = numbersIn(data);
      expect(lines[contract.subs[0].length + 2]).toBe(
        `${contract.sub(1, 2)} ${contract.clauses[1]}`,
      );
    },
  );

  // protects=a heading the User adds after a clause heading they made a sub-heading is numbered as that one now is, a level deeper, rather than falling back to an unnumbered heading style because no heading had that level in the file; fails_when=the new heading comes back unnumbered or at the first level; no_claim=a heading of a level no heading has, before or after the edit.
  test.each(LANGUAGES)(
    "%s: a heading added after one made a sub-heading is numbered at its level",
    async (_language, contract) => {
      const data = await editedExport(fileOf(OWN, contract), (blocks) => {
        const at = blocks.findIndex(
          (each) => each.type === "heading" && textOfNode(each) === contract.clauses[1],
        );
        const moved = blocks.map((block, index) =>
          index === at ? { ...block, attrs: { ...block.attrs, level: 2 } } : block,
        );
        const added = {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: contract.newClause }],
        };
        return [...moved.slice(0, at + 1), added, ...moved.slice(at + 1)];
      });
      const lines = numbersIn(data);
      expect(lines[contract.subs[0].length + 3]).toBe(
        `${contract.sub(1, 3)} ${contract.newClause}`,
      );
    },
  );

  // protects=a heading with its own list but its level from its style (the style says level 2, the paragraph only the list) moves a level deeper from its style's level when the User makes it a sub-heading; fails_when=it moves from the first level instead and keeps a clause number; no_claim=a heading whose style alone numbers it.
  test("a heading numbered at its style's level moves a level deeper from there", async () => {
    const styles = `${STYLES.replace(/<w:style w:type="paragraph" w:styleId="Heading1">.*?<\/w:style>/, "")}${style("Heading1", '<w:numPr><w:ilvl w:val="1"/></w:numPr>', 0)}`;
    const heading = (text: string) =>
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`;
    const bytes = wordFile({
      styles,
      numbering:
        definition([
          ["upperRoman", "Part %1"],
          ["decimal", "%2."],
          ["decimal", "%2.%3"],
        ]) + num(1, 0),
      body: [
        paragraph(run("General"), { numId: 1, ilvl: 0 }),
        heading("Services"),
        heading("Fees"),
      ].join(""),
    });
    expect(numbersIn(new Uint8Array(bytes))).toEqual(["Part I General", "1. Services", "2. Fees"]);
    const data = await editedExport(bytes, (blocks) =>
      blocks.map((block) =>
        block.type === "heading" && textOfNode(block) === "Fees"
          ? { ...block, attrs: { ...block.attrs, level: 2 } }
          : block,
      ),
    );
    expect(numbersIn(data)).toEqual(["Part I General", "1. Services", "1.1 Fees"]);
  });

  // protects=typed clause numbers and a bold line standing for a heading stay the file's text after an edit: the export gives them no numbering; fails_when=either becomes a numbered paragraph; no_claim=how the import reads them, which the import test covers.
  test("typed numbers and a bold heading stay text", async () => {
    const bytes = wordFile({
      body: [
        paragraph(run("1. Definitions", { b: true })),
        paragraph("Words have the meanings given here."),
        paragraph(run("第一条 定义")),
        paragraph("本合同用语含义如下。"),
      ].join(""),
    });
    const data = await editedExport(bytes, (blocks) =>
      blocks.map((block) => ({
        ...block,
        content: (block.content ?? []).map((each) => ({ ...each, text: `${each.text}!` })),
      })),
    );
    expect(numbersIn(data)).toEqual([
      "1. Definitions!",
      "Words have the meanings given here.!",
      "第一条 定义!",
      "本合同用语含义如下。!",
    ]);
  });
});

describe("Word's numbering rules, as the shared reader counts a file", () => {
  const fileWith = (levels: string, list = num(1, 0)) =>
    wordFile({
      numbering: `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>${list}`,
      body: [
        paragraph("Services", { numId: 1, ilvl: 0 }),
        paragraph("The studio designs the packaging.", { numId: 1, ilvl: 1 }),
        paragraph("Fees", { numId: 1, ilvl: 0 }),
        paragraph("The fee is due each month.", { numId: 1, ilvl: 1 }),
      ].join(""),
    });
  const level = (ilvl: number, format: string, text: string, more = "") =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${more}<w:lvlText w:val="${text}"/></w:lvl>`;

  // protects=a level whose restart is 0 (w:lvlRestart) never starts again, so its count goes on across the items above it, as Word counts it, and an item's other levels start again as without it; fails_when=the second sub-clause is numbered 2.1; no_claim=a restart at a level two above, which counts the same way.
  test("a level that never starts again counts on under the next item", () => {
    const bytes = fileWith(
      level(0, "decimal", "%1.") + level(1, "decimal", "%1.%2", '<w:lvlRestart w:val="0"/>'),
    );
    expect(numbersIn(new Uint8Array(bytes))).toEqual([
      "1. Services",
      "1.1 The studio designs the packaging.",
      "2. Fees",
      "2.2 The fee is due each month.",
    ]);
  });

  // protects=a paragraph whose style is based on another, each linked to a level, is numbered at the level linked to its own style, the nearest in its chain, not at the first level whose style is anywhere in it; fails_when=the sub-clause is numbered "2." at the first level; no_claim=a paragraph with an ilvl of its own, which wins.
  test("a level linked to a style is the nearest style's", () => {
    const bytes = wordFile({
      styles: `${style("Article", numPr(1))}<w:style w:type="paragraph" w:styleId="Section"><w:name w:val="Section"/><w:basedOn w:val="Article"/></w:style>${STYLES}`,
      numbering:
        definition([
          ["decimal@Article", "%1."],
          ["decimal@Section", "%1.%2"],
        ]) + num(1, 0),
      body: [
        paragraph(run("Services"), { style: "Article" }),
        paragraph(run("The studio designs the packaging."), { style: "Section" }),
      ].join(""),
    });
    expect(numbersIn(new Uint8Array(bytes))).toEqual([
      "1. Services",
      "1.1 The studio designs the packaging.",
    ]);
  });

  // protects=a restart level a list's override gives is ignored, as Word ignores it (MS-OI29500, lvlRestart), so the level starts again under the next item; fails_when=the second sub-clause is numbered 2.2; no_claim=an override's start, which counts.
  test("a restart level in a list's override is ignored", () => {
    const override = `<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1">${level(1, "decimal", "%1.%2", '<w:lvlRestart w:val="0"/>')}</w:lvlOverride></w:num>`;
    const bytes = fileWith(level(0, "decimal", "%1.") + level(1, "decimal", "%1.%2"), override);
    expect(numbersIn(new Uint8Array(bytes))[3]).toBe("2.1 The fee is due each month.");
  });

  // protects=legal numbering (w:isLgl) writes every level of the number in Arabic numerals, the level's own too, and w:isLgl w:val="0" leaves the levels' own formats; fails_when=the sub-clause is written 1.a under legal numbering, or 1.1 with it off; no_claim=levels with a bullet or no number.
  test.each([
    ["<w:isLgl/>", "1.1"],
    ['<w:isLgl w:val="0"/>', "I.a"],
  ])("legal numbering %s writes the sub-clause %s", (legal, number) => {
    const bytes = fileWith(level(0, "upperRoman", "%1.") + level(1, "lowerLetter", "%1.%2", legal));
    expect(numbersIn(new Uint8Array(bytes))[1]).toBe(`${number} The studio designs the packaging.`);
  });
});
