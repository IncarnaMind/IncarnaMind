import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, onTestFinished, test } from "vitest";
import { NUMBERING_SCHEMES, type NumberingScheme } from "../../src/shared/numbering";
import { createTempDataFolder, startCore } from "../helpers/core";
import { part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { run, wordFile, paragraph as wordParagraph } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

/*
 * Numbered lists' schemes in Word (#1419): a Mind's list in each scheme exports as Word's own
 * numbering in that scheme (one definition a scheme, one numbering through a list and the lists
 * nested in it, each item at its level), and the file imports back as the same scheme, nested the
 * same, a list that starts deeper at that level.
 */

const item = (text: string, ...lists: JSONContent[]): JSONContent => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...lists],
});
const ordered = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({
  type: "orderedList",
  attrs,
  content: items,
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

/** Each level's number format and text, as the scheme writes it. */
const WORD_LEVELS: Record<NumberingScheme, readonly [string, string][]> = {
  default: [
    ["decimal", "%1."],
    ["lowerLetter", "%2."],
    ["lowerRoman", "%3."],
  ],
  outline: [
    ["decimal", "%1."],
    ["decimal", "%1.%2."],
    ["decimal", "%1.%2.%3."],
  ],
  clauses: [
    ["lowerLetter", "(%1)"],
    ["lowerRoman", "(%2)"],
    ["upperLetter", "(%3)"],
  ],
  chinese: [
    ["chineseCounting", "%1、"],
    ["chineseCounting", "（%2）"],
    ["decimal", "%3."],
  ],
};

async function newMind() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Lease" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir, mind, client };
}

/** The abstract numbering a numId stands for, and its levels' number formats and texts. */
/** The definition a numbering instance is of. */
const definitionOf = (numbering: string, numId: string) =>
  new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="(\\d+)"/>`).exec(numbering)?.[1];

function levelsOf(numbering: string, numId: string): [string, string][] {
  const abstract = new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="(\\d+)"/>`).exec(
    numbering,
  )?.[1];
  const definition = new RegExp(
    `<w:abstractNum w:abstractNumId="${abstract}">([\\s\\S]*?)</w:abstractNum>`,
  ).exec(numbering)?.[1];
  return [
    ...(definition ?? "").matchAll(/<w:numFmt w:val="(\w+)"\/><w:lvlText w:val="([^"]*)"\/>/g),
  ]
    .slice(0, 3)
    .map((found) => [found[1] ?? "", found[2] ?? ""]);
}

/** Each numbered paragraph's level and numbering, with its text. */
const numberedParagraphs = (document: string) =>
  [
    ...document.matchAll(
      /<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>(?:(?!<\/w:p>)[\s\S])*?<w:t[^>]*>([^<]*)<\/w:t>/g,
    ),
  ].map((found) => ({ level: Number(found[1]), numId: found[2] ?? "", text: found[3] ?? "" }));

const listsIn = (doc: ProseMirrorNode) => {
  const found: { numbering: unknown; startLevel: number; items: string[] }[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "orderedList") return true;
    const items: string[] = [];
    node.forEach((child) => {
      items.push(child.firstChild?.textContent ?? "");
    });
    found.push({
      numbering: node.attrs.numbering ?? null,
      startLevel: Number(node.attrs.startLevel) || 0,
      items,
    });
    return true;
  });
  return found;
};

describe("Numbering schemes in Word", () => {
  // protects=a list in each scheme exports as Word numbering in that scheme, its nested lists in the same numbering a level deeper, a list that starts deeper at that level, and imports back the same; fails_when=Word would draw other numbers, the nested list starts a numbering of its own (so "1.1." loses its parent), or the import comes back in another scheme or level; no_claim=how Word lays the numbers out, which the Word corpus check opens in LibreOffice.
  test.each(NUMBERING_SCHEMES)(
    "%s exports as Word's numbering and imports back",
    async (scheme) => {
      const { core, dataDir, mind, client } = await newMind();
      const numbering = scheme === "default" ? null : scheme;
      writeMind(client, [
        ordered(
          { numbering },
          item("Rent", ordered({}, item("Monthly", ordered({}, item("In advance"))))),
          item("Deposit"),
        ),
        paragraph("Between the lists."),
        ordered({ numbering, startLevel: 1 }, item("Repairs")),
      ]);
      await client.settled();

      const exported = await core.exportMind(mind.id, { format: "docx" });
      const files = unzip(exported.data);
      const document = part(files, "word/document.xml");
      const numberingXml = part(files, "word/numbering.xml");
      const paragraphs = numberedParagraphs(document);
      expect(paragraphs.map(({ level, text }) => [level, text])).toEqual([
        [0, "Rent"],
        [1, "Monthly"],
        [2, "In advance"],
        [0, "Deposit"],
        [1, "Repairs"],
      ]);
      const [first, second] = [paragraphs[0]?.numId ?? "", paragraphs[4]?.numId ?? ""];
      expect(new Set(paragraphs.slice(0, 4).map(({ numId }) => numId))).toEqual(new Set([first]));
      expect(second).not.toBe(first);
      expect(levelsOf(numberingXml, first)).toEqual(WORD_LEVELS[scheme]);
      const deeper = new RegExp(`<w:num w:numId="${second}">[\\s\\S]*?</w:num>`).exec(numberingXml);
      // A definition of its own, or LibreOffice counts the levels its number draws ("1.1.")
      // on from the list before, as it treats the instances of one definition as one list.
      expect(definitionOf(numberingXml, second)).not.toBe(definitionOf(numberingXml, first));
      expect(deeper?.[0]).toContain('<w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/>');

      const { client: imported } = await importWordBytes(
        core,
        dataDir,
        Buffer.from(exported.data),
        {
          origin: "own",
          name: `${scheme}.docx`,
        },
      );
      expect(listsIn(readMind(imported))).toEqual([
        { numbering, startLevel: 0, items: ["Rent", "Deposit"] },
        { numbering, startLevel: 0, items: ["Monthly"] },
        { numbering, startLevel: 0, items: ["In advance"] },
        { numbering, startLevel: 1, items: ["Repairs"] },
      ]);
    },
  );

  // protects=a list added in a scheme to a Mind imported from Word goes back into the original file as Word numbering in that scheme, its nested list in the same numbering, the rest of the file's numbering left as it was; fails_when=it goes back as plain "1." or as a numbering of its own a level; no_claim=a list of the file's own whose scheme the User changes, which keeps the file's numbering.
  test("a list that starts deeper, added to a Word file, gets a definition of its own too", async () => {
    const { core, dataDir } = await newMind();
    const { mindId, client } = await importWordBytes(
      core,
      dataDir,
      wordFile({ body: wordParagraph(run("Terms of the lease.")) }),
      { origin: "own" },
    );
    editMind(client, (blocks) => [
      ...blocks,
      ordered({ numbering: "outline" }, item("First"), item("Second")),
      ordered({ numbering: "outline", startLevel: 1 }, item("Deeper")),
    ]);
    await client.settled();
    const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
    const numbering = part(files, "word/numbering.xml");
    const paragraphs = numberedParagraphs(part(files, "word/document.xml"));
    expect(paragraphs.map(({ text }) => text)).toEqual(["First", "Second", "Deeper"]);
    const [first, , deeper] = paragraphs;
    expect(definitionOf(numbering, deeper?.numId ?? "")).not.toBe(
      definitionOf(numbering, first?.numId ?? ""),
    );
  });

  test("a list in a scheme added to a Word file goes back into it in that scheme", async () => {
    const { core, dataDir } = await newMind();
    const { mindId, client } = await importWordBytes(
      core,
      dataDir,
      wordFile({ body: wordParagraph(run("Terms of the lease.")) }),
      { origin: "own" },
    );
    editMind(client, (blocks) => [
      ...blocks,
      ordered(
        { numbering: "clauses" },
        item("Rent", ordered({}, item("Monthly"))),
        item("Deposit"),
      ),
    ]);
    await client.settled();
    const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
    const paragraphs = numberedParagraphs(part(files, "word/document.xml"));
    expect(paragraphs.map(({ level, text }) => [level, text])).toEqual([
      [0, "Rent"],
      [1, "Monthly"],
      [0, "Deposit"],
    ]);
    expect(new Set(paragraphs.map(({ numId }) => numId)).size).toBe(1);
    expect(levelsOf(part(files, "word/numbering.xml"), paragraphs[0]?.numId ?? "")).toEqual(
      WORD_LEVELS.clauses,
    );
  });
});
