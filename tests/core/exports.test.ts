import { createHash } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type CitationCheck,
  type CitationCheckReason,
  type Document,
  InvalidInputError,
  type MindExport,
  messageReference,
  NotFoundError,
} from "../../src/core";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { checkWellFormed, footnotesOf, paragraphsOf, part, textOf, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, question, writeMind } from "../helpers/minds";
import { zipFingerprint } from "../helpers/zip";

/** A core with one Document ("Tides") and a Mind titled "Tides", with a client. */
async function setUp(title = "Tides", region?: string) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    now: manualClock().now,
    ...(region !== undefined && { systemRegion: () => region }),
  });
  const path = await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon.");
  const [tides] = await addAndProcess(core, [path]);
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, tides: tides as Document };
}

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });

/** A Citation of the Document, as the core writes one into an Answer. */
function citation(
  document: Document,
  pages: [number, number] | null,
  check: CitationCheck,
  checkReason: CitationCheckReason | null = null,
): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      pageFrom: pages?.[0] ?? null,
      pageTo: pages?.[1] ?? null,
      quote: "Spring tides happen at new moon.",
      check,
      checkReason,
    },
  };
}

/**
 * Notes of every kind (one switched out of Question context), a Question, and
 * its Answer, whose three Citations were found, not found, and can't be checked.
 */
function writeSample(client: MindClient, tides: Document): void {
  const asked = question("When do spring tides happen?");
  writeMind(client, [
    heading(1, "Spring tides"),
    paragraph(
      text("Neap", "bold"),
      text(" tides are "),
      text("weaker", "italic"),
      text(", at $0."),
    ),
    note("Kept out of Questions, still exported.", { off: true }),
    {
      type: "bulletList",
      content: [item(paragraph(text("High water"))), item(paragraph(text("Low water")))],
    },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        item(paragraph(text("New moon"))),
        item(paragraph(text("Full moon")), {
          type: "bulletList",
          content: [item(paragraph(text("Twice a month")))],
        }),
      ],
    },
    { type: "codeBlock", attrs: { language: "js" }, content: [text('console.log("tide");')] },
    { type: "blockMath", attrs: { latex: "F = G\\frac{m_1 m_2}{r^2}" } },
    asked,
    {
      type: "answer",
      attrs: { questionId: asked.attrs.id, status: "done" },
      content: [
        paragraph(
          text("At new moon "),
          citation(tides, [2, 2], "found"),
          text(" and at full moon "),
          citation(tides, [2, 2], "not-found", "quote-not-on-pages"),
          text("."),
        ),
        paragraph(
          text("The pull falls off as "),
          { type: "inlineMath", attrs: { latex: "1/r^3" } },
          text(" "),
          citation(tides, [3, 4], "cant-check", "no-text"),
          text("."),
        ),
      ],
    },
  ]);
}

/**
 * What the sample leaves out that the .docx writer knows: a quote, a rule, web
 * links (one on code), struck and underlined text, a line break, Citations of
 * slides, rows and sections, maths Word's equations can't hold, a table with a
 * cell over two columns, and an image.
 */
function writeEverythingElse(client: MindClient, tides: Document): void {
  const at = (location: object): JSONContent => {
    const node = citation(tides, [1, 1], "found");
    return { ...node, attrs: { ...node.attrs, location } };
  };
  const linked = (value: string, href: string, ...marks: string[]): JSONContent => ({
    type: "text",
    text: value,
    marks: [...marks.map((type) => ({ type })), { type: "link", attrs: { href } }],
  });
  writeMind(client, [
    { type: "blockquote", content: [paragraph(text("Time and tide wait for no one."))] },
    { type: "horizontalRule" },
    paragraph(
      linked("Tide tables", "https://tides.example/tables"),
      text(" and "),
      linked("tide.js", "https://tides.example/code", "code"),
      text(": "),
      text("old", "strike"),
      text(" "),
      text("new", "underline"),
      { type: "hardBreak" },
      text("Growth"),
      at({ kind: "slide", from: 3, to: 3 }),
      text(", revenue"),
      at({ kind: "rows", sheet: "Revenue", from: 12, to: 14 }),
      text(", the crest"),
      at({ kind: "section", heading: "2.1 Sensitivity" }),
      text("."),
    ),
    { type: "blockMath", attrs: { latex: "\\undefinedmacro{x}" } },
  ]);
  // The editor has no tables or images yet; they are written as Tiptap's would be.
  client.doc.transact(() => {
    client.blocks.push([
      element("table", {}, [
        element("tableRow", {}, [
          element("tableHeader", { colspan: "2" }, [element("paragraph", {}, ["Tides"])]),
        ]),
        element("tableRow", {}, [
          element("tableCell", {}, [element("paragraph", {}, ["Spring"])]),
          element("tableCell", {}, [element("paragraph", {}, ["4 m"])]),
        ]),
      ]),
      element("image", { src: PIXEL, alt: "A chart" }, []),
    ]);
  });
}

const decode = (exported: MindExport) => new TextDecoder().decode(exported.data);

/** The text of an equation's runs, joined. */
const mathText = (omml: string) =>
  [...omml.matchAll(/<m:t xml:space="preserve">([^<]*)<\/m:t>/g)].map((match) => match[1]).join("");

/** The parts of an exported .docx, each checked to be well-formed XML. */
function docxParts(exported: MindExport) {
  const files = unzip(exported.data);
  for (const [name, content] of files) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) checkWellFormed(content.toString("utf8"));
  }
  return {
    files,
    document: part(files, "word/document.xml"),
    footnotes: part(files, "word/footnotes.xml"),
    numbering: part(files, "word/numbering.xml"),
    relationships: part(files, "word/_rels/document.xml.rels"),
  };
}

describe("exporting a Mind", () => {
  test("a table of contents is Word's own field, with cached entries and bookmarks, and Word updates it on opening (#1935)", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [
      { type: "tableOfContents" },
      heading(1, "Spring tides"),
      paragraph(text("Spring tides happen at new moon.")),
      heading(2, "Neap tides"),
      paragraph(text("Neap tides come at the quarter moons.")),
    ]);
    await client.settled();

    const { files, document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));

    expect(document).toContain("TOC \\o");
    expect(document).toContain('<w:fldChar w:fldCharType="begin"');
    expect(document).toContain('<w:fldChar w:fldCharType="separate"/>');
    expect(document).toContain('<w:fldChar w:fldCharType="end"/>');
    expect(document).toContain("Contents");
    // The cached entries, each a link to its heading's bookmark.
    expect(document).toContain("Spring tides");
    expect(document).toContain("Neap tides");
    expect(document).toContain('w:anchor="_Toc90000001"');
    expect(document).toContain('w:anchor="_Toc90000002"');
    expect(document).toContain('<w:bookmarkStart w:id="0" w:name="_Toc90000001"/>');
    expect(document).toContain('<w:bookmarkStart w:id="1" w:name="_Toc90000002"/>');
    expect(part(files, "word/settings.xml")).toContain('<w:updateFields w:val="true"/>');

    // The other exports draw it from the same headings.
    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(markdown).toContain("**Contents**");
    expect(markdown).toContain("- Spring tides");
    expect(markdown).toContain("  - Neap tides");
    const html = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "html" })).data,
    );
    expect(html).toContain('class="toc"');
    expect(html).toContain("Spring tides");
    expect(html).toContain("Neap tides");
  });

  test("a Note without a table of contents writes no field, and Word is asked to update nothing", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [heading(1, "Spring tides"), paragraph(text("At new moon."))]);
    await client.settled();

    const { files, document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));

    expect(document).not.toContain("TOC \\o");
    expect(document).not.toContain("w:bookmarkStart");
    expect(part(files, "word/settings.xml")).not.toContain("w:updateFields");
  });

  test("Markdown preserves checked, unchecked and empty checklist items, nested beside ordinary lists", async () => {
    const { core, mind, client } = await setUp();
    const task = (checked: boolean, ...content: JSONContent[]): JSONContent => ({
      type: "taskItem",
      attrs: { checked },
      content,
    });
    const checklist = (checked: boolean): JSONContent => ({
      type: "taskList",
      content: [
        task(
          checked,
          paragraph(text("核查清单项")),
          {
            type: "taskList",
            content: [
              task(false, paragraph(text("Check sources"))),
              task(true, paragraph(text("已核对"))),
            ],
          },
          {
            type: "bulletList",
            content: [item(paragraph(text("Supporting note")))],
          },
        ),
        task(false, paragraph(text("交付报告"))),
        task(true, paragraph()),
        task(true, paragraph(), {
          type: "taskList",
          content: [task(false, paragraph(text("Empty parent")))],
        }),
        task(false, paragraph()),
      ],
    });
    const ordinary: JSONContent = {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        item(paragraph(text("Ordinary item")), {
          type: "bulletList",
          content: [item(paragraph(text("A bullet")))],
        }),
      ],
    };
    for (const checked of [true, false]) {
      writeMind(client, [checklist(checked), ordinary]);
      await client.settled();
      const exported = await core.exportMind(mind.id, { format: "markdown" });
      expect(new TextDecoder().decode(exported.data).trim()).toBe(
        [
          `- [${checked ? "x" : " "}] 核查清单项`,
          "  - [ ] Check sources",
          "  - [x] 已核对",
          "  - Supporting note",
          "- [ ] 交付报告",
          "- [x] ",
          "- [x] ",
          "  - [ ] Empty parent",
          "- [ ] ",
          "",
          "3. Ordinary item",
          "   - A bullet",
        ].join("\n"),
      );
    }
  });

  test("the bytes of an export don't change: a fingerprint of the sample's Markdown and .docx", async () => {
    const { core, mind, client, tides } = await setUp();
    writeSample(client, tides);
    await client.settled();

    const exported = async (format: "markdown" | "docx") =>
      (await core.exportMind(mind.id, { format })).data;

    expect(
      createHash("sha256")
        .update(await exported("markdown"))
        .digest("hex"),
    ).toBe("6af5396e9bda856838e28958169641a1d21a98d04e5ec9d02a7e5375bb0c8f74");
    // The .docx's compressed bytes depend on zlib's build, so they are checked against this
    // Node's deflate, and the rest is pinned (see `zipFingerprint`).
    expect(zipFingerprint(await exported("docx"))).toBe(
      "37d4b4388f05af92b219559087aa58c649ba0aedaf510b6a91e8dc27040ea5ea",
    );
  });

  test.each([
    [
      "the sample, with its Question",
      "sample",
      { includeQuestions: true },
      "7e49fd33d0aca4c4efb1098a9aac24363c8470f3ec084f64dea769ba81be5e03",
    ],
    [
      "the sample, in Chinese, on a computer in China (A4)",
      "sample",
      { language: "zh-CN", region: "CN" },
      "6a5ddfe6b09d64eb8a168bba49091bd06fcbefb0e712d314baa2b83d24ef8d47",
    ],
    [
      "quotes, rules, links, marks, breaks, tables, images and Locations",
      "rest",
      {},
      "b79bca0bfcb3d2983a19c3b5c3b5d89ca8115571ffc23d49e08d6287edbfcd6a",
    ],
  ] as const)(
    "the bytes of a .docx export don't change either: %s",
    async (_, content, options, expected) => {
      const { core, mind, client, tides } = await setUp(
        "Tides",
        "region" in options ? options.region : undefined,
      );
      if (content === "sample") writeSample(client, tides);
      else writeEverythingElse(client, tides);
      await client.settled();
      if ("language" in options)
        await core.updateSettings({ user: { language: options.language } });

      const exported = await core.exportMind(mind.id, {
        format: "docx",
        includeQuestions: "includeQuestions" in options,
      });

      expect(zipFingerprint(exported.data)).toBe(expected);
    },
  );

  test("to Markdown: Notes and Answers as Markdown, the Question marked, math kept, and a footnote per Citation", async () => {
    const { core, mind, client, tides } = await setUp();
    writeSample(client, tides);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });

    expect(decode(exported)).toBe(
      [
        "# Spring tides",
        "",
        "**Neap** tides are *weaker*, at \\$0.",
        "",
        "Kept out of Questions, still exported.",
        "",
        "- High water",
        "- Low water",
        "",
        "1. New moon",
        "2. Full moon",
        "   - Twice a month",
        "",
        "```js",
        'console.log("tide");',
        "```",
        "",
        "$$",
        "F = G\\frac{m_1 m_2}{r^2}",
        "$$",
        "",
        "**Question:** When do spring tides happen?",
        "",
        "At new moon[^1] and at full moon[^2].",
        "",
        "The pull falls off as $1/r^3$[^3].",
        "",
        "[^1]: Tides, p. 2",
        "[^2]: Tides, p. 2 [unverified]",
        "[^3]: Tides, p. 3–4 [unverified]",
        "",
      ].join("\n"),
    );
    expect(exported).toMatchObject({
      fileName: "Tides.md",
      citations: 3,
      unverifiedCitations: 2,
      questions: 1,
    });
  });

  test("the preview counts the unverified Citations before anything is written", async () => {
    const { core, mind, client, tides } = await setUp("Tides: spring/neap?");
    writeSample(client, tides);
    await client.settled();

    expect(await core.previewMindExport(mind.id, { format: "docx" })).toEqual({
      fileName: "Tides spring neap.docx",
      citations: 3,
      citedDocuments: 1,
      numbered: true,
      unverifiedCitations: 2,
      questions: 1,
      hiddenColumns: 0,
      fromWord: false,
      theirChanges: 0,
      citationPlace: "footnotes",
      markAiText: false,
      othersFile: false,
      othersComments: false,
    });
  });

  test("to .docx: to-dos start with ☐ or ☒ at the text edge, a nested one 24px in, and bullets and numbers keep Word's indents", async () => {
    const { core, mind, client } = await setUp();
    const task = (checked: boolean, ...content: JSONContent[]): JSONContent => ({
      type: "taskItem",
      attrs: { checked },
      content,
    });
    writeMind(client, [
      paragraph(text("Before.")),
      {
        type: "taskList",
        content: [
          task(
            false,
            paragraph(text("核查清单项")),
            {
              type: "taskList",
              content: [
                task(true, paragraph(text("已核对")), {
                  type: "taskList",
                  content: [task(false, paragraph(text("Deeper")))],
                }),
              ],
            },
            { type: "bulletList", content: [item(paragraph(text("Supporting note")))] },
          ),
          task(true, paragraph()),
        ],
      },
      { type: "bulletList", content: [item(paragraph(text("Ordinary bullet")))] },
      {
        type: "bulletList",
        content: [
          item(paragraph(text("Parent bullet")), {
            type: "taskList",
            content: [task(false, paragraph(text("Under bullet")))],
          }),
        ],
      },
    ]);
    await client.settled();
    const { document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));
    const written = [...document.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((found) => ({
      text: textOf(found[0]),
      indent: /<w:ind w:left="(\d+)"(?: w:hanging="(\d+)")?\/>/.exec(found[0])?.slice(1, 3),
      listed: found[0].includes("<w:numPr>"),
    }));
    expect(written).toEqual([
      { text: "Before.", indent: undefined, listed: false },
      { text: "☐\t核查清单项", indent: ["420", "420"], listed: false },
      { text: "☒\t已核对", indent: ["780", "420"], listed: false },
      { text: "☐\tDeeper", indent: ["1140", "420"], listed: false },
      { text: "Supporting note", indent: ["1140", "360"], listed: true },
      { text: "☒\t", indent: ["420", "420"], listed: false },
      { text: "Ordinary bullet", indent: ["720", "360"], listed: true },
      { text: "Parent bullet", indent: ["720", "360"], listed: true },
      { text: "☐\tUnder bullet", indent: ["1140", "420"], listed: false },
    ]);
    const todos = [...document.matchAll(/<w:p>.*?<\/w:p>/g)]
      .map((found) => found[0])
      .filter((each) => /<w:t xml:space="preserve">[☐☒]<\/w:t>/.test(each));
    expect(todos).toHaveLength(5);
    for (const xml of todos) {
      expect(xml).toContain("<w:r><w:tab/></w:r>");
      // Word's schema has no bare <w:tab/> under <w:p>: every tab sits in a run.
      const children = xml
        .replace(/^<w:p>/, "")
        .replace(/<\/w:p>$/, "")
        .replace(/^<w:pPr>.*?<\/w:pPr>/, "");
      expect(children.replace(/<w:r>.*?<\/w:r>/g, "")).toBe("");
    }
  });

  test("to .docx: headings, lists, code and math, the Question left out, and each Citation a Word footnote", async () => {
    const { core, mind, client, tides } = await setUp();
    writeSample(client, tides);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx" });
    expect(exported).toMatchObject({
      fileName: "Tides.docx",
      citations: 3,
      unverifiedCitations: 2,
    });
    const { files, document, footnotes, numbering } = docxParts(exported);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
        "word/numbering.xml",
        "word/footnotes.xml",
      ]),
    );
    expect(part(files, "[Content_Types].xml")).toContain(
      'PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"',
    );

    // The name is the file's Title property, and the page starts with the text, with no title line (#908).
    expect(part(files, "docProps/core.xml")).toContain("<dc:title>Tides</dc:title>");
    // Questions are left out by default; the Note switched out of Question context is in.
    expect(paragraphsOf(document)).toEqual([
      { style: "Heading1", text: "Spring tides" },
      { text: "Neap tides are weaker, at $0." },
      { text: "Kept out of Questions, still exported." },
      { style: "ListParagraph", list: "1/0", text: "High water" },
      { style: "ListParagraph", list: "1/0", text: "Low water" },
      { style: "ListParagraph", list: "2/0", text: "New moon" },
      { style: "ListParagraph", list: "2/0", text: "Full moon" },
      { style: "ListParagraph", list: "3/1", text: "Twice a month" },
      { style: "Code", text: 'console.log("tide");' },
      // The maths is in Word's equations, not text (below).
      { style: "Math", text: "" },
      { text: "At new moon[1] and at full moon[2]." },
      { text: "The pull falls off as [3]." },
    ]);
    // Maths is Word's own equations: a display equation in its paragraph, and inline.
    expect(document).toContain(
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
    );
    const display =
      /<w:p><w:pPr><w:pStyle w:val="Math"\/><\/w:pPr><m:oMathPara>(.*?)<\/m:oMathPara><\/w:p>/.exec(
        document,
      )?.[1];
    expect(display).toMatch(/^<m:oMath>.*<\/m:oMath>$/);
    expect(display).toContain("<m:f><m:num>");
    expect(mathText(display ?? "")).toBe("F=Gm1m2r2");
    const inline = /falls off as <\/w:t><\/w:r>(<m:oMath>.*?<\/m:oMath>)/.exec(document)?.[1];
    expect(mathText(inline ?? "")).toBe("1/r3");
    expect(inline).toContain("<m:sSup>");
    expect(document).not.toContain("$$");
    expect(document).not.toContain("$1/r^3$");
    expect(document).not.toContain("When do spring tides happen?");
    expect(document).toContain(
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Neap</w:t></w:r>',
    );
    expect(document).toContain(
      '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">weaker</w:t></w:r>',
    );

    // Real Word footnotes, one per Citation even when two cite the same page.
    expect(footnotesOf(footnotes)).toEqual({
      "1": "Tides, p. 2",
      "2": "Tides, p. 2 [unverified]",
      "3": "Tides, p. 3–4 [unverified]",
    });
    expect(footnotes).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(part(files, "word/settings.xml")).toContain(
      '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>',
    );

    // Each list numbers itself: bullets, numbers from 1, and bullets again a level down.
    expect(
      [...numbering.matchAll(/<w:num w:numId="\d+">[\s\S]*?<\/w:num>/g)].map((m) => m[0]),
    ).toEqual([
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>',
      '<w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num>',
    ]);
    // Headings are Word's own heading styles, so Word's navigation finds them.
    expect(part(files, "word/styles.xml")).toContain(
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>',
    );
  });

  // protects=a list in a Word export is indented as the Mind draws it (DESIGN.md, #1341): each level's text half an inch further in, its bullet or number a quarter inch before it; fails_when=the export's indents drift from the screen's 48px a level and 24px hang; no_claim=how Word draws them.
  test("to .docx: a list's levels are indented 720 twips each, with a 360 hang, as the Mind draws them", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [
      {
        type: "bulletList",
        content: [
          item(paragraph(text("One")), {
            type: "bulletList",
            content: [
              item(paragraph(text("Two")), {
                type: "bulletList",
                content: [item(paragraph(text("Three")))],
              }),
            ],
          }),
        ],
      },
    ]);
    await client.settled();

    const { document, numbering } = docxParts(await core.exportMind(mind.id, { format: "docx" }));

    // A level's text is 48px per level in, in twips: 720 each; its bullet 24px (360) before it.
    expect(
      [...document.matchAll(/<w:ind w:left="(\d+)" w:hanging="(\d+)"\/>/g)].map((m) => m.slice(1)),
    ).toEqual([
      ["720", "360"],
      ["1440", "360"],
      ["2160", "360"],
    ]);
    // The list's own definition says the same for each of its levels.
    const levels = [
      ...numbering.matchAll(/<w:lvl w:ilvl="(\d)">.*?<w:ind w:left="(\d+)" w:hanging="(\d+)"\/>/g),
    ];
    expect(levels.slice(0, 3).map((m) => m.slice(1))).toEqual([
      ["0", "720", "360"],
      ["1", "1440", "360"],
      ["2", "2160", "360"],
    ]);
  });

  test("a new Mind's title line left empty isn't exported: no empty heading at the top of the file", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [
      { type: "heading", attrs: { level: 1 } },
      note("Spring tides come at new moon."),
    ]);
    await client.settled();

    const markdown = decode(await core.exportMind(mind.id, { format: "markdown" }));
    expect(markdown).toBe("Spring tides come at new moon.\n");
    const html = decode(await core.exportMind(mind.id, { format: "html" }));
    expect(html).not.toMatch(/<h[1-6][^>]*>\s*<\/h[1-6]>/);
    const { document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));
    expect(paragraphsOf(document)).toEqual([{ text: "Spring tides come at new moon." }]);
  });

  test("highlighted text is ==marked== in Markdown and highlighted in Word", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [
      paragraph(
        text("Spring tides are "),
        text("strongest", "highlight"),
        text(" at "),
        text("new moon", "bold", "highlight"),
        text("."),
      ),
      // A "==" that isn't a highlight stays text; so does a highlight that starts with "=".
      paragraph(text("In code, a == b; "), text("= b", "highlight")),
    ]);
    await client.settled();

    const markdown = decode(await core.exportMind(mind.id, { format: "markdown" }));
    expect(markdown).toBe(
      [
        "Spring tides are ==strongest== at **==new moon==**.",
        "",
        "In code, a \\== b; ==\\= b==",
        "",
      ].join("\n"),
    );

    const { document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));
    expect(paragraphsOf(document)).toEqual([
      { text: "Spring tides are strongest at new moon." },
      { text: "In code, a == b; = b" },
    ]);
    // Word's own highlighting, which its Text Highlight Color button shows and removes.
    expect(document).toContain(
      '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">strongest</w:t></w:r>',
    );
    expect(document).toContain(
      '<w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">new moon</w:t></w:r>',
    );
    expect(document.match(/<w:highlight /g)).toHaveLength(3);
  });

  test("to .docx with Questions: they are put back, marked as Questions", async () => {
    const { core, mind, client, tides } = await setUp();
    writeSample(client, tides);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx", includeQuestions: true });

    const paragraphs = paragraphsOf(docxParts(exported).document);
    expect(paragraphs.filter((each) => each.style === "Question")).toEqual([
      { style: "Question", text: "Question: When do spring tides happen?" },
    ]);
    const at = paragraphs.findIndex((each) => each.style === "Question");
    expect(paragraphs[at + 1]?.text).toBe("At new moon[1] and at full moon[2].");
  });

  test("Markdown can leave Questions out too", async () => {
    const { core, mind, client } = await setUp("");
    writeMind(client, [note("A Note."), question("A Question?")]);
    await client.settled();

    const exported = await core.exportMind(mind.id, {
      format: "markdown",
      includeQuestions: false,
    });
    expect(decode(exported)).toBe("A Note.\n");
    expect(exported).toMatchObject({ fileName: "A Note.md", citations: 0, questions: 1 });
  });

  describe("the file is named after the note (#1945)", () => {
    const nameOf = async (title: string, blocks: JSONContent[], format: "markdown" | "docx") => {
      const { core, mind, client } = await setUp(title);
      writeMind(client, blocks);
      await client.settled();
      return (await core.previewMindExport(mind.id, { format })).fileName;
    };

    test("a Mind with no title takes its first line, in English and Chinese", async () => {
      expect(await nameOf("", [note("Tides and the moon"), note("More")], "markdown")).toBe(
        "Tides and the moon.md",
      );
      expect(await nameOf("", [note("潮汐与月亮的关系"), note("更多")], "docx")).toBe(
        "潮汐与月亮的关系.docx",
      );
    });

    test("a typed title wins over the first line", async () => {
      expect(await nameOf("Tides", [note("Something else")], "markdown")).toBe("Tides.md");
    });

    test("an empty Mind is Untitled", async () => {
      expect(await nameOf("", [], "markdown")).toBe("Untitled.md");
    });

    test("the first line is cleaned for a file name, and cut only where a file name can't hold it", async () => {
      expect(await nameOf("", [note("Tides: spring/neap?")], "docx")).toBe(
        "Tides spring neap.docx",
      );
      const long = await nameOf("", [note("tide ".repeat(40))], "markdown");
      expect(long.length).toBeLessThanOrEqual(122);
      expect(long.endsWith("tide.md")).toBe(true);
    });

    test("a whole sentence names the file as it reads, without the mark it ends on", async () => {
      expect(
        await nameOf(
          "",
          [
            note(
              "The employee gets 27 days of paid holiday per year, plus bank holidays and the notice period after probation.",
            ),
          ],
          "docx",
        ),
      ).toBe(
        "The employee gets 27 days of paid holiday per year, plus bank holidays and the notice period after probation.docx",
      );
      expect(
        await nameOf(
          "",
          [
            note(
              "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方，否则视为违约，需要承担相应的赔偿责任并支付违约金。",
            ),
          ],
          "docx",
        ),
      ).toBe(
        "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方，否则视为违约，需要承担相应的赔偿责任并支付违约金.docx",
      );
    });

    test("a typed title too long for a file is cut at a word (#769)", async () => {
      const title = "Holiday and notice rules for employees on probation ".repeat(4).trim();
      const name = await nameOf(title, [note("Body")], "markdown");
      expect(title.startsWith(`${name.slice(0, -".md".length)} `)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(123);
    });

    test("a heading an Answer wrote names the file, not the instruction that gave it (#1174, #1945)", async () => {
      const { core, mind } = await setUp("");
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
          { type: "paragraph", content: [{ type: "text", text: "The parties agree to terms." }] },
        ],
        origin: {
          from: messageReference("conversation-1", "answer-1"),
          question: "Make the summary longer.",
        },
        model: null,
      });

      expect((await core.previewMindExport(mind.id, { format: "docx" })).fileName).toBe(
        "Summary.docx",
      );
    });
  });

  test("a Citation whose Document has been deleted is unverified, whatever its check said", async () => {
    const { core, mind, client, tides } = await setUp();
    writeMind(client, [paragraph(text("Spring tides"), citation(tides, [2, 2], "found"))]);
    await client.settled();
    expect(await core.previewMindExport(mind.id, { format: "docx" })).toMatchObject({
      citations: 1,
      unverifiedCitations: 0,
    });

    await core.deleteDocument(tides.id);

    expect(await core.previewMindExport(mind.id, { format: "docx" })).toMatchObject({
      citations: 1,
      unverifiedCitations: 1,
    });
    const exported = await core.exportMind(mind.id, { format: "markdown" });
    expect(decode(exported)).toContain("[^1]: Tides, p. 2 [unverified]");
  });

  test("a Citation of a Document without pages names only the Document", async () => {
    const { core, mind, client, tides } = await setUp("");
    writeMind(client, [paragraph(text("Spring tides."), citation(tides, null, "found"))]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx" });
    expect(footnotesOf(docxParts(exported).footnotes)).toEqual({ "1": "Tides" });
  });

  test("tables become Word tables and GitHub tables, and images are embedded", async () => {
    const { core, mind, client } = await setUp("");
    // The editor has no tables or images yet; they are written as Tiptap's would be.
    client.doc.transact(() => {
      client.blocks.push([
        element("table", {}, [
          element("tableRow", {}, [
            element("tableHeader", {}, [element("paragraph", {}, ["Tide"])]),
            element("tableHeader", {}, [element("paragraph", {}, ["Height"])]),
          ]),
          element("tableRow", {}, [
            element("tableCell", {}, [element("paragraph", {}, ["Spring"])]),
            element("tableCell", {}, [element("paragraph", {}, ["4 m | high"])]),
          ]),
        ]),
        element("image", { src: PIXEL, alt: "A chart" }, []),
      ]);
    });
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });
    const markdown = decode(exported);
    // The picture is a file beside the .md, named after its bytes, that the text links (#1937).
    const [picture] = exported.files ?? [];
    expect(picture?.name).toMatch(/^picture-[0-9a-f]{12}\.png$/);
    expect(Buffer.from(picture?.data ?? [])).toEqual(
      Buffer.from(PIXEL.split(",")[1] as string, "base64"),
    );
    expect(markdown).toBe(
      [
        "| Tide | Height |",
        "| --- | --- |",
        "| Spring | 4 m \\| high |",
        "",
        `![A chart](${picture?.name})`,
        "",
      ].join("\n"),
    );

    const { files, document, relationships } = docxParts(
      await core.exportMind(mind.id, { format: "docx" }),
    );
    const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(document)?.[0] ?? "";
    expect(table).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    expect(
      [...table.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((cell) => textOf(cell[1] as string)),
    ).toEqual(["Tide", "Height", "Spring", "4 m | high"]);
    expect(files.get("word/media/image1.png")).toEqual(
      Buffer.from(PIXEL.split(",")[1] as string, "base64"),
    );
    expect(relationships).toContain(
      'Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"',
    );
    expect(document).toContain('<a:blip r:embed="rIdImage1"/>');
    // One pixel at 96 dpi.
    expect(document).toContain('<wp:extent cx="9525" cy="9525"/>');
  });

  test("a WebP picture is embedded as a WebP, its type listed, at the size the Note shows it at", async () => {
    const { core, mind, client } = await setUp("");
    const webp = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          {
            type: "image",
            attrs: {
              src: `data:image/webp;base64,${webp}`,
              alt: "A tide chart",
              width: 40,
              height: 20,
            },
          },
        ],
      },
    ]);
    await client.settled();

    const { files, document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));
    expect(files.get("word/media/image1.webp")).toEqual(Buffer.from(webp, "base64"));
    expect(part(files, "[Content_Types].xml")).toContain(
      '<Default Extension="webp" ContentType="image/webp"/>',
    );
    expect(document).toContain('<wp:extent cx="381000" cy="190500"/>');
    expect(textOf(document)).not.toContain("A tide chart");
  });

  test("a table made in the editor, Citations in its cells: a GitHub table with footnotes, and a Word table with its alignment, merged cells and real footnotes", async () => {
    const { core, mind, client, tides } = await setUp();
    const cell = (
      type: "tableHeader" | "tableCell",
      content: JSONContent[],
      attrs: Record<string, unknown> = {},
    ): JSONContent => ({ type, attrs: { colspan: 1, rowspan: 1, ...attrs }, content });
    writeMind(client, [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              cell("tableHeader", [paragraph(text("Tide"))], { align: "left" }),
              cell("tableHeader", [paragraph(text("When"))]),
              cell("tableHeader", [paragraph(text("Range"))], { align: "right" }),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", [paragraph(text("Spring"))], { rowspan: 2 }),
              cell("tableCell", [
                paragraph(text("At new and full moon "), citation(tides, [2, 2], "found")),
              ]),
              cell("tableCell", [paragraph(text("Largest", "bold"))], { align: "right" }),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", [
                paragraph(
                  text("满月和新月"),
                  citation(tides, [2, 2], "not-found", "quote-not-on-pages"),
                ),
              ]),
              cell("tableCell", [paragraph(text("a | b"))], { align: "right" }),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", [paragraph(text("Line one")), paragraph(text("Line two"))], {
                colspan: 2,
              }),
              cell("tableCell", [paragraph(text("—"))], { align: "right" }),
            ],
          },
        ],
      },
    ]);
    await client.settled();

    const markdown = await core.exportMind(mind.id, { format: "markdown" });
    expect(decode(markdown)).toBe(
      [
        "| Tide | When | Range |",
        "| :--- | --- | ---: |",
        "| Spring | At new and full moon[^1] | **Largest** |",
        "|  | 满月和新月[^2] | a \\| b |",
        "| Line one<br>Line two |  | — |",
        "",
        "[^1]: Tides, p. 2",
        "[^2]: Tides, p. 2 [unverified]",
        "",
      ].join("\n"),
    );
    expect(markdown).toMatchObject({ citations: 2, unverifiedCitations: 1 });

    const exported = await core.exportMind(mind.id, { format: "docx" });
    const { document, footnotes } = docxParts(exported);
    const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(document)?.[0] ?? "";
    expect(table.match(/<w:gridCol /g)).toHaveLength(3);
    const rows = [...table.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map((row) => row[1] as string);
    expect(rows).toHaveLength(4);
    // The heading row repeats on each page, shaded, its first and last cells aligned.
    expect(rows[0]).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    const cellsOf = (row: string) =>
      [...row.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((each) => each[1] as string);
    const heading = cellsOf(rows[0] as string);
    expect(heading.map((each) => /<w:jc w:val="(\w+)"\/>/.exec(each)?.[1] ?? null)).toEqual([
      "left",
      null,
      "right",
    ]);
    // "Spring" is merged down over two rows; "Line one" across two columns, a line each.
    const [spring, , largest] = cellsOf(rows[1] as string);
    expect(spring).toContain('<w:vMerge w:val="restart"/>');
    expect(largest).toContain("<w:b/>");
    const below = cellsOf(rows[2] as string);
    expect(below).toHaveLength(3);
    expect(below[0]).toContain("<w:vMerge/>");
    expect(textOf(below[0] as string)).toBe("");
    expect(textOf(below[1] as string)).toBe("满月和新月[2]");
    const last = cellsOf(rows[3] as string);
    expect(last).toHaveLength(2);
    expect(last[0]).toContain('<w:gridSpan w:val="2"/>');
    expect(paragraphsOf(last[0] as string).map((each) => each.text)).toEqual([
      "Line one",
      "Line two",
    ]);
    // Each Citation is a Word footnote, referenced from its cell.
    expect(textOf(cellsOf(rows[1] as string)[1] as string)).toBe("At new and full moon[1]");
    expect(footnotesOf(footnotes)).toEqual({
      "1": "Tides, p. 2",
      "2": "Tides, p. 2 [unverified]",
    });
    expect(zipFingerprint(exported.data)).toBe(
      "e2dc23dd2b96504fb3e5b08d515996adac6dc879a22e209592093f9edefe08ea",
    );
  });

  test("its own words are in the interface language", async () => {
    const { core, mind, client, tides } = await setUp();
    await core.updateSettings({ user: { language: "zh-CN" } });
    writeMind(client, [
      question("大潮什么时候出现？"),
      paragraph(
        text("新月时"),
        citation(tides, [2, 3], "not-found", "quote-not-on-pages"),
        text("。"),
      ),
    ]);
    await client.settled();

    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toBe(
      [
        "**问题：** 大潮什么时候出现？",
        "",
        "新月时[^1]。",
        "",
        "[^1]: Tides，第 2–3 页 [未核实]",
        "",
      ].join("\n"),
    );
  });

  test("a footnote names its Citation's Location: a slide, rows of a sheet, a section, lines", async () => {
    const { core, mind, client, tides } = await setUp();
    const at = (location: object): JSONContent => {
      const node = citation(tides, [1, 1], "found");
      return { ...node, attrs: { ...node.attrs, location } };
    };
    writeMind(client, [
      paragraph(
        text("Growth"),
        at({ kind: "slide", from: 3, to: 3 }),
        text(", revenue"),
        at({ kind: "rows", sheet: "Revenue", from: 12, to: 14 }),
        text(", the crest"),
        at({ kind: "section", heading: "2.1 Sensitivity" }),
        text(", the log"),
        at({ kind: "lines", from: 120, to: 134 }),
        text("."),
      ),
    ]);
    await client.settled();

    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toContain(
      [
        "[^1]: Tides, slide 3",
        "[^2]: Tides, Revenue, rows 12–14",
        "[^3]: Tides, § 2.1 Sensitivity",
        "[^4]: Tides, lines 120–134",
      ].join("\n"),
    );
    const docx = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(footnotesOf(part(docx, "word/footnotes.xml"))).toEqual({
      "1": "Tides, slide 3",
      "2": "Tides, Revenue, rows 12–14",
      "3": "Tides, § 2.1 Sensitivity",
      "4": "Tides, lines 120–134",
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toContain(
      [
        "[^1]: Tides，第 3 张幻灯片",
        "[^2]: Tides，Revenue，第 12–14 行",
        "[^3]: Tides，§ 2.1 Sensitivity",
        "[^4]: Tides，第 120–134 行",
      ].join("\n"),
    );
  });

  test("a PDF page's footnote names the page it prints, in Word and in Markdown, in both languages", async () => {
    const { core, mind, client, tides } = await setUp();
    const at = (location: object): JSONContent => {
      const node = citation(tides, [69, 69], "found");
      return { ...node, attrs: { ...node.attrs, location } };
    };
    writeMind(client, [
      paragraph(
        text("Turnover"),
        at({ kind: "page", from: 69, to: 69, printed: { from: "68", to: "68" } }),
        text(", the preface"),
        at({ kind: "page", from: 3, to: 4, printed: { from: "iii", to: "iv" } }),
        text(", and a page that prints no number"),
        at({ kind: "page", from: 70, to: 70 }),
        text("."),
      ),
    ]);
    await client.settled();

    const docx = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(footnotesOf(part(docx, "word/footnotes.xml"))).toEqual({
      "1": "Tides, p. 68",
      "2": "Tides, p. iii–iv",
      "3": "Tides, p. 70",
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toContain(
      ["[^1]: Tides，第 68 页", "[^2]: Tides，第 iii–iv 页", "[^3]: Tides，第 70 页"].join("\n"),
    );
  });

  test("maths Word's equations can't hold stays LaTeX text in a .docx that still opens; Markdown keeps $…$", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [
      { type: "blockMath", attrs: { latex: "\\undefinedmacro{x}" } },
      paragraph(
        text("Linked "),
        { type: "inlineMath", attrs: { latex: "\\href{https://example.com}{x}" } },
        text(", and fine "),
        { type: "inlineMath", attrs: { latex: "E = mc^2" } },
        text("."),
      ),
    ]);
    await client.settled();

    const { document } = docxParts(await core.exportMind(mind.id, { format: "docx" }));
    expect(paragraphsOf(document)).toEqual([
      { style: "Math", text: "$$\\undefinedmacro{x}$$" },
      { text: "Linked $\\href{https://example.com}{x}$, and fine ." },
    ]);
    expect(document.match(/<m:oMath>/g)).toHaveLength(1);
    expect(document).not.toContain("<m:oMathPara>");

    expect(decode(await core.exportMind(mind.id, { format: "markdown" }))).toContain(
      "Linked $\\href{https://example.com}{x}$, and fine $E = mc^2$.",
    );
  });

  test("refuses unknown formats and Minds", async () => {
    const { core, mind } = await setUp();
    await expect(
      core.exportMind(mind.id, { format: "odt" } as unknown as { format: "docx" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.exportMind(mind.id, { format: "docx", includeQuestions: "yes" } as unknown as {
        format: "docx";
      }),
    ).rejects.toThrow(InvalidInputError);
    await core.deleteMind(mind.id);
    await expect(core.previewMindExport(mind.id, { format: "docx" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

/** A 1×1 PNG. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A node as Tiptap's Yjs binding stores it; strings are its text. */
function element(
  type: string,
  attributes: Record<string, string>,
  children: (Y.XmlElement | string)[],
): Y.XmlElement {
  const node = new Y.XmlElement(type);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.insert(
    0,
    children.map((child) => (typeof child === "string" ? new Y.XmlText(child) : child)),
  );
  return node;
}
