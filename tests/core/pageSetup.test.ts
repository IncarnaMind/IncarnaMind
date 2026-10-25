/**
 * The pages of a Mind, through the core's public interface and over the Word corpus: each
 * section's size, orientation and margins, its headers and footers with their page fields, as the
 * Word file has them; a native Mind's paper and margins by region; and none of it in the Mind's content.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { readManifest, WORD_DIR } from "../../eval/word/corpus";
import type { PageFurniture, PageFurnitureRun, PageSection, PageSetup } from "../../src/core";
import { openWordPackage } from "../../src/core/documents/formats/docxPackage";
import { readPageSetup } from "../../src/core/documents/formats/docxPages";
import { createTempDataFolder, startCore } from "../helpers/core";
import { part, unzip } from "../helpers/docx";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { field, PNG, paragraph, picture, run, wordFile } from "../helpers/word";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const plain = (furniture: PageFurniture | null): string | null =>
  furniture === null
    ? null
    : furniture.paragraphs
        .map((each) =>
          each.runs
            .map((piece) =>
              piece.kind === "text"
                ? piece.text
                : piece.kind === "field"
                  ? `{${piece.field}}`
                  : `<${piece.align} tab>`,
            )
            .join(""),
        )
        .join("\n");

/** A Word file with three sections that differ in what a section can differ in. */
function threeSections(): Buffer {
  const footer = (instructions: string) =>
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("Page ")}${field("PAGE", "1")}${run(" of ")}<w:fldSimple w:instr=" ${instructions} "><w:r><w:t>9</w:t></w:r></w:fldSimple></w:p>`;
  return wordFile({
    body: [
      paragraph("Chapter one", {
        sectPr:
          '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1021" w:bottom="1247" w:left="1304" w:header="567" w:footer="624" w:gutter="0"/><w:titlePg/></w:sectPr>',
      }),
      paragraph("Chapter two", {
        sectPr:
          '<w:sectPr><w:type w:val="oddPage"/><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="360"/><w:pgNumType w:start="1" w:fmt="lowerRoman"/></w:sectPr>',
      }),
      paragraph("Chapter three"),
    ].join(""),
    headers: {
      rIdH1: `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Annual report</w:t></w:r></w:p>`,
      rIdH2: `<w:p>${run("Cover")}</w:p>`,
    },
    footers: {
      rIdF1: footer("NUMPAGES"),
      rIdF2: `<w:p>${field("SECTIONPAGES \\* ROMAN", "iv")}</w:p>`,
    },
    sectPr:
      '<w:footerReference w:type="default" r:id="rIdF2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="708" w:footer="708"/>',
    rels: `<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`,
    parts: [
      {
        name: "word/settings.xml",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders/></w:settings>',
      },
    ],
  });
}

async function importedPageSetup(bytes: Buffer, region?: string) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, region === undefined ? {} : { systemRegion: () => region });
  const path = join(dataDir, "Report.docx");
  await writeFile(path, bytes);
  const result = await core.importWordFile({ path, origin: "own" });
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await client.settled();
  return { core, mindId: result.mind.id, client };
}

describe("The pages of a Mind imported from Word", () => {
  // protects=each section's size, orientation, margins, first-page rule, page numbering and its headers and footers, with their page fields, reach the window as the file has them, and a section that names none has the section before's; fails_when=a section's size or margin is the default, a field is read as text, or an inherited footer is missing; no_claim=how pages are laid out from this, which is part 2.
  test("every section comes through as the file has it, a section that names no header or footer inheriting the one before's", async () => {
    const { core, mindId } = await importedPageSetup(threeSections());

    const setup = await core.getPageSetup(mindId);

    expect(setup.source).toBe("word");
    expect(setup.oddAndEven).toBe(true);
    const [first, second, third] = setup.sections as [PageSection, PageSection, PageSection];
    expect(setup.sections).toHaveLength(3);

    expect(first).toMatchObject({
      breakPlace: "w:sectPr#0",
      start: "nextPage",
      width: 11906,
      height: 16838,
      orientation: "portrait",
      margins: {
        top: 1134,
        right: 1021,
        bottom: 1247,
        left: 1304,
        gutter: 0,
        header: 567,
        footer: 624,
      },
      differentFirstPage: true,
      pageNumbers: { start: null, format: "decimal" },
    });
    expect(plain(first.headers.default)).toBe("Annual report");
    expect(first.headers.default?.paragraphs[0]).toMatchObject({
      align: "right",
      runs: [{ kind: "text", text: "Annual report", bold: true }],
    });
    expect(plain(first.headers.first)).toBe("Cover");
    expect(first.headers.even).toBeNull();
    const pages: PageFurnitureRun[] = [
      { kind: "text", text: "Page " },
      { kind: "field", field: "PAGE", format: null },
      { kind: "text", text: " of " },
      { kind: "field", field: "NUMPAGES", format: null },
    ];
    expect(first.footers.default?.paragraphs).toEqual([{ align: "center", runs: pages }]);

    expect(second).toMatchObject({
      breakPlace: "w:sectPr#1",
      start: "oddPage",
      width: 15840,
      height: 12240,
      orientation: "landscape",
      margins: { gutter: 360 },
      differentFirstPage: false,
      pageNumbers: { start: 1, format: "lowerRoman" },
    });
    expect(second.headers).toEqual(first.headers);
    expect(second.footers).toEqual(first.footers);

    expect(third).toMatchObject({ breakPlace: null, width: 12240, height: 15840 });
    expect(third.margins).toMatchObject({ left: 1800, right: 1800, header: 708, footer: 708 });
    expect(third.footers.default?.paragraphs).toEqual([
      { align: "left", runs: [{ kind: "field", field: "SECTIONPAGES", format: "upperRoman" }] },
    ]);
    expect(third.headers).toEqual(first.headers);
  });

  // protects=the place a section carries is the place of the section break the Mind holds, so Page view can end the section there; fails_when=the numbers drift from the importer's; no_claim=none beyond protects.
  test("a section's place is the place of its break in the Mind", async () => {
    const { core, mindId, client } = await importedPageSetup(threeSections());
    const places: string[] = [];
    const visit = (node: JSONContent) => {
      if (node.attrs?.kind === "sectionBreak" && typeof node.attrs.source === "string") {
        places.push(node.attrs.source);
      }
      for (const each of node.content ?? []) visit(each);
    };
    visit(readMind(client).toJSON());
    const setup = await core.getPageSetup(mindId);
    const ends = setup.sections.flatMap((each) => each.breakPlace ?? []);
    expect(places.length).toBeGreaterThan(0);
    expect(ends).toEqual(places);
  });

  // protects=pages are layout only: asking for them changes nothing in the Mind; fails_when=the Mind's document changes; no_claim=none beyond protects.
  test("asking for the pages leaves the Mind's content as it was", async () => {
    const { core, mindId, client } = await importedPageSetup(threeSections());
    const before = Y.encodeStateAsUpdate(client.doc);

    await core.getPageSetup(mindId);
    await core.getPageSetup(mindId);

    expect(Y.encodeStateAsUpdate(client.doc)).toEqual(before);
  });
});

const SECTION = (inside: string) => `<w:p><w:pPr><w:sectPr>${inside}</w:sectPr></w:pPr></w:p>`;

describe("What a Word file's section breaks, headers and footers hold", () => {
  const setupOf = async (bytes: Buffer) => readPageSetup(await openWordPackage(bytes));

  // protects=a section break inside a content control (a table of contents) or custom XML ends a section, as Word counts it, and the control's break is named by the control the Mind holds; fails_when=such a section is missed, so its header is lost and the next section inherits the wrong one; no_claim=a break in a table, which Word ignores.
  test("a section break inside a content control or custom XML is a section, named by the outermost control", async () => {
    const bytes = wordFile({
      body: [
        `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${paragraph("Contents")}${SECTION('<w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="12240" w:h="15840"/>')}</w:sdtContent></w:sdt>`,
        `<w:customXml w:element="part">${SECTION('<w:pgSz w:w="15840" w:h="12240"/>')}</w:customXml>`,
        paragraph("Last"),
      ].join(""),
      headers: { rIdH1: `<w:p>${run("Cover")}</w:p>` },
    });

    const setup = await setupOf(bytes);

    expect(setup.sections.map((each) => each.breakPlace)).toEqual(["w:sdt#0", "w:sectPr#1", null]);
    expect(plain(setup.sections[0]?.headers.default ?? null)).toBe("Cover");
    expect(plain(setup.sections[2]?.headers.default ?? null)).toBe("Cover");

    const { core, mindId, client } = await importedPageSetup(bytes);
    const sources = new Set<string>();
    const visit = (node: JSONContent) => {
      if (typeof node.attrs?.source === "string") sources.add(node.attrs.source);
      for (const each of node.content ?? []) visit(each);
    };
    visit(readMind(client).toJSON());
    for (const place of (await core.getPageSetup(mindId)).sections.flatMap(
      (each) => each.breakPlace ?? [],
    )) {
      expect(sources, place).toContain(place);
    }
  });

  // protects=a paragraph's alignment and tab stops come from its style and the styles it is based on, as Word resolves them, and its own win; fails_when=a footer a style right-aligns is reported left-aligned, or a cleared tab stop stays; no_claim=fonts, sizes and colours, which are not read.
  test("alignment and tab stops come from the paragraph's style, down the styles it is based on", async () => {
    const styles = [
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
      '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360" w:leader="dot"/></w:tabs></w:pPr></w:style>',
      '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Header"/><w:pPr><w:tabs><w:tab w:val="clear" w:pos="4680"/></w:tabs><w:jc w:val="right"/></w:pPr></w:style>',
    ].join("");
    const pStyle = (id: string, more = "") =>
      `<w:p><w:pPr><w:pStyle w:val="${id}"/>${more}</w:pPr>${run("x")}</w:p>`;
    const setup = await setupOf(
      wordFile({
        body: paragraph("Body"),
        styles,
        sectPr:
          '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/>',
        headers: { rIdH1: pStyle("Header") },
        footers: {
          rIdF1: `${pStyle("Footer")}${pStyle("Footer", '<w:jc w:val="center"/>')}<w:p>${run("plain")}</w:p>`,
        },
      }),
    );
    const [header] = setup.sections;
    const [styled, own, plainParagraph] = header?.footers.default?.paragraphs ?? [];

    expect(header?.headers.default?.paragraphs[0]).toMatchObject({
      align: "left",
      tabStops: [
        { position: 4680, align: "center" },
        { position: 9360, align: "right", leader: "dot" },
      ],
    });
    expect(styled).toMatchObject({
      align: "right",
      tabStops: [{ position: 9360, align: "right", leader: "dot" }],
    });
    expect(own?.align).toBe("center");
    expect(plainParagraph).toEqual({ align: "left", runs: [{ kind: "text", text: "plain" }] });
  });

  // protects=what part 1 does not draw is said, not dropped: Word's position tab, a frame, a picture and a field's own formatting reach the window; fails_when=a position tab is read as no text at all, or a picture is lost without a count; no_claim=drawing any of them, which is part 2.
  test("a position tab, a frame, a picture and a field's formatting are kept or counted", async () => {
    const bold = "<w:rPr><w:b/></w:rPr>";
    const setup = await setupOf(
      wordFile({
        body: paragraph("Body"),
        sectPr:
          '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/>',
        headers: {
          rIdH1: `<w:p>${run("Left")}<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>${field("PAGE \\* MERGEFORMAT \\* roman", "i")}</w:p>${picture("rIdImg", "Logo")}`,
        },
        footers: {
          rIdF1: `<w:p><w:pPr><w:framePr w:w="1000" w:hAnchor="margin" w:xAlign="right"/></w:pPr><w:fldSimple w:instr=" PAGE "><w:r>${bold}<w:t>1</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${bold}<w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
        },
        media: { rIdImg: { name: "media/logo.png", data: PNG } },
      }),
    );
    const section = setup.sections[0];

    expect(section?.headers.default?.paragraphs[0]?.runs).toEqual([
      { kind: "text", text: "Left" },
      { kind: "alignedTab", align: "right", relativeTo: "margin" },
      { kind: "field", field: "PAGE", format: "lowerRoman" },
    ]);
    expect(section?.headers.default?.pictures).toBe(1);
    expect(section?.footers.default?.paragraphs).toEqual([
      {
        align: "left",
        framed: true,
        runs: [{ kind: "field", field: "PAGE", format: null, bold: true }],
      },
      {
        align: "left",
        runs: [{ kind: "field", field: "NUMPAGES", format: null, bold: true }],
      },
    ]);
    expect(section?.footers.default?.pictures).toBeUndefined();
  });

  // protects=a value that is also a property every object has ("constructor", "toString", "__proto__) where a keyword is expected reads as unknown, so the page setup still crosses the bridge; fails_when=the reader looks a keyword up in a plain object, finds a function, and the result can't be structured-cloned; no_claim=none beyond protects.
  test.each(["constructor", "toString", "__proto__"])(
    "%s where a keyword is expected falls back to the default, and the result is structured-clone-safe",
    async (value) => {
      const setup = await setupOf(
        wordFile({
          body: [
            `<w:p><w:pPr><w:jc w:val="${value}"/><w:tabs><w:tab w:val="${value}" w:pos="720" w:leader="${value}"/></w:tabs><w:sectPr><w:type w:val="${value}"/><w:pgNumType w:fmt="${value}"/></w:sectPr></w:pPr>${run("Body")}</w:p>`,
          ].join(""),
          sectPr: '<w:footerReference w:type="default" r:id="rIdF1"/>',
          footers: {
            rIdF1: `<w:p><w:pPr><w:jc w:val="${value}"/><w:tabs><w:tab w:val="${value}" w:pos="720" w:leader="${value}"/></w:tabs></w:pPr>${field(`PAGE \\* ${value}`, "1")}</w:p>`,
          },
        }),
      );

      expect(() => structuredClone(setup)).not.toThrow();
      const [first, last] = setup.sections;
      expect(first).toMatchObject({ start: "nextPage", pageNumbers: { format: "decimal" } });
      expect(last?.footers.default?.paragraphs[0]).toEqual({
        align: "left",
        tabStops: [{ position: 720, align: "left" }],
        runs: [{ kind: "field", field: "PAGE", format: null }],
      });
    },
  );

  // protects=a section's orientation is the one its box has, whatever w:orient says; fails_when=a portrait box is called landscape; no_claim=none beyond protects.
  test("orientation follows the page box", async () => {
    const setup = await setupOf(
      wordFile({
        body: [
          SECTION('<w:pgSz w:w="12240" w:h="15840" w:orient="landscape"/>'),
          SECTION('<w:pgSz w:w="15840" w:h="12240"/>'),
        ].join(""),
      }),
    );
    expect(setup.sections.map((each) => each.orientation)).toEqual([
      "portrait",
      "landscape",
      "portrait",
    ]);
  });
});

describe("The pages of a native Mind", () => {
  // protects=a Mind that wasn't imported takes the native Word export's paper by region and its margins: A4 where the region isn't one that prints on Letter; fails_when=Letter in Europe or A4 in the US, or margins other than the export's; no_claim=the export itself, which its own tests cover.
  test.each([
    ["GB", "a4", 11906, 16838],
    ["US", "letter", 12240, 15840],
  ] as const)(
    "in %s it is %s, with one inch margins, in one section",
    async (region, _paper, width, height) => {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { systemRegion: () => region });
      const mind = await core.createMind({ title: "Notes" });

      const setup: PageSetup = await core.getPageSetup(mind.id);

      expect(setup.source).toBe("native");
      expect(setup.oddAndEven).toBe(false);
      expect(setup.sections).toEqual([
        {
          breakPlace: null,
          start: "nextPage",
          width,
          height,
          orientation: "portrait",
          margins: {
            top: 1440,
            right: 1440,
            bottom: 1440,
            left: 1440,
            gutter: 0,
            header: 720,
            footer: 720,
          },
          differentFirstPage: false,
          pageNumbers: { start: null, format: "decimal" },
          headers: { default: null, first: null, even: null },
          footers: { default: null, first: null, even: null },
        },
      ]);
    },
  );

  test("a Mind that doesn't exist has no pages", async () => {
    const core = startCore(await createTempDataFolder());
    await expect(core.getPageSetup("no-such-mind")).rejects.toThrow();
  });
});

const FLOW = new Set(["w:sdt", "w:sdtContent", "w:customXml"]);
const FORMATS = new Set(["decimal", "lowerRoman", "upperRoman", "lowerLetter", "upperLetter"]);
const PAGE_FIELDS = new Set(["PAGE", "NUMPAGES", "SECTIONPAGES"]);
const KINDS = ["default", "first", "even"] as const;

const elementsOf = (node: Node, name: string): Element[] =>
  Array.from(node.childNodes).filter((each): each is Element => (each as Element).tagName === name);

/** Whether a paragraph is in the body's flow: Word honours its section break there, in controls and custom XML too, not in a table or a text box. */
function inBodyFlow(paragraph: Element): boolean {
  for (
    let node = paragraph.parentNode as Element | null;
    node;
    node = node.parentNode as Element | null
  ) {
    if (node.tagName === "w:body") return true;
    if (!FLOW.has(node.tagName)) return false;
  }
  return false;
}

/** A part's paragraphs, as another parser reads them: their text, outside a text box's fallback. */
function paragraphTexts(xml: string): string[] {
  const document = new DOMParser().parseFromString(xml.replace(/^﻿/, ""), "text/xml");
  return Array.from(document.getElementsByTagName("w:p"))
    .filter((each) => {
      for (
        let node = each.parentNode as Element | null;
        node;
        node = node.parentNode as Element | null
      ) {
        if (node.tagName === "mc:Fallback") return false;
      }
      return true;
    })
    .map((paragraph) => {
      const texts: string[] = [];
      const visit = (node: Node) => {
        for (const each of Array.from(node.childNodes) as Element[]) {
          if (each.tagName === "w:t") texts.push(each.textContent ?? "");
          else if (each.tagName === "w:tab") texts.push("\t");
          else if (each.tagName === "w:br" || each.tagName === "w:cr") texts.push("\n");
          else if (!["w:instrText", "w:pPr", "w:rPr"].includes(each.tagName)) visit(each);
        }
      };
      visit(paragraph);
      return texts.join("");
    });
}

/** What the file says of its sections, read with another parser than the one under test. */
function expectedSections(xml: string, settingsXml: string | null) {
  const document = new DOMParser().parseFromString(xml.replace(/^﻿/, ""), "text/xml");
  const body = document.getElementsByTagName("w:body")[0] as Element;
  const sectPrs = Array.from(document.getElementsByTagName("w:sectPr")).filter((sectPr) => {
    const pPr = sectPr.parentNode as Element;
    const paragraph = pPr.parentNode as Element;
    return pPr.tagName === "w:pPr" && paragraph.tagName === "w:p" && inBodyFlow(paragraph);
  });
  const last = elementsOf(body, "w:sectPr")[0];
  if (last) sectPrs.push(last);
  const evenAndOdd = settingsXml
    ? (() => {
        const element = new DOMParser()
          .parseFromString(settingsXml.replace(/^﻿/, ""), "text/xml")
          .getElementsByTagName("w:evenAndOddHeaders")[0];
        return !!element && !["0", "false", "off"].includes(element.getAttribute("w:val") ?? "1");
      })()
    : false;
  const sections = sectPrs.map((sectPr) => {
    const number = (element: Element | undefined, attribute: string, fallback: number) => {
      const value = element?.getAttribute(attribute);
      return value ? Number(value) : fallback;
    };
    const size = elementsOf(sectPr, "w:pgSz")[0];
    const margins = elementsOf(sectPr, "w:pgMar")[0];
    const titlePg = elementsOf(sectPr, "w:titlePg")[0];
    const numbering = elementsOf(sectPr, "w:pgNumType")[0];
    const width = number(size, "w:w", 12240);
    const height = number(size, "w:h", 15840);
    const references = (name: string) =>
      elementsOf(sectPr, name).map((each) => ({
        type: each.getAttribute("w:type") ?? "default",
        id: each.getAttribute("r:id") ?? "",
      }));
    return {
      width,
      height,
      orientation: width > height ? "landscape" : "portrait",
      start: elementsOf(sectPr, "w:type")[0]?.getAttribute("w:val") ?? "nextPage",
      margins: {
        top: number(margins, "w:top", 1440),
        right: number(margins, "w:right", 1440),
        bottom: number(margins, "w:bottom", 1440),
        left: number(margins, "w:left", 1440),
        gutter: number(margins, "w:gutter", 0),
        header: number(margins, "w:header", 720),
        footer: number(margins, "w:footer", 720),
      },
      differentFirstPage:
        !!titlePg && !["0", "false", "off"].includes(titlePg.getAttribute("w:val") ?? "1"),
      pageNumbers: {
        start: numbering?.getAttribute("w:start")
          ? Number(numbering.getAttribute("w:start"))
          : null,
        format: FORMATS.has(numbering?.getAttribute("w:fmt") ?? "")
          ? numbering?.getAttribute("w:fmt")
          : "decimal",
      },
      headerReferences: references("w:headerReference"),
      footerReferences: references("w:footerReference"),
    };
  });
  return { sections, evenAndOdd };
}

/** The page fields a part's XML names, counted from its text with a pattern. */
function fieldsNamedIn(whole: string): string[] {
  const xml = whole.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  return [
    ...xml.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g),
    ...xml.matchAll(/w:instr="([^"]*)"/g),
  ].flatMap((each) => {
    const first = (each[1] ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    return PAGE_FIELDS.has(first) ? [first] : [];
  });
}

const textRuns = (furniture: PageFurniture): string[] =>
  furniture.paragraphs.map((each) =>
    each.runs.map((piece) => (piece.kind === "text" ? piece.text : "")).join(""),
  );

describe("The Word corpus's pages", () => {
  const files = readManifest().map((entry) => entry.file);

  // protects=a footer whose style right-aligns it is right-aligned, in a frame, and a table of contents' section break is a section that has its header; fails_when=the footer reads left-aligned, or the contents' first section is lost with its header; no_claim=files outside the corpus.
  test("a footer its style right-aligns, and a section break inside a table of contents", async () => {
    const read = async (file: string) =>
      readPageSetup(await openWordPackage(readFileSync(join(WORD_DIR, file))));

    const footer = (await read("documents/libreoffice/tdf103976.docx")).sections[0]?.footers
      .default;
    expect(footer?.paragraphs[0]).toMatchObject({ align: "right", framed: true });

    const contents = await read("documents/libreoffice/multi-page-toc.docx");
    expect(contents.sections.map((each) => each.breakPlace)).toEqual(["w:sdt#0", null]);
    expect(plain(contents.sections[0]?.headers.default ?? null)).not.toBeNull();
  });

  // protects=for every file of the corpus, the sections (counted as Word counts them, controls and custom XML included), each one's size, orientation, margins, break type, page numbering and first-page rule, and the header and footer part each kind of page shows, with its text, come through as the file has them; fails_when=a section is missed, a field of a section has another value, a kind is mapped to another part, or a part's text is lost; no_claim=files outside the corpus, and what a header holds beyond its text and page fields.
  test.each(files)(
    "%s: every section, and the headers and footers each shows, are the file's",
    async (file) => {
      const bytes = readFileSync(join(WORD_DIR, file));
      const setup = await readPageSetup(await openWordPackage(bytes));
      const parts = unzip(bytes);
      const relationships = new Map(
        [...part(parts, "word/_rels/document.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map(
          (each) => {
            const tag = each[0];
            return [
              /Id="([^"]*)"/.exec(tag)?.[1] ?? "",
              /Target="([^"]*)"/.exec(tag)?.[1] ?? "",
            ] as const;
          },
        ),
      );
      const settingsPath = [...relationships.values()].find((target) =>
        target.endsWith("settings.xml"),
      );
      const expected = expectedSections(
        part(parts, "word/document.xml"),
        settingsPath ? part(parts, `word/${settingsPath.replace(/^\/?(word\/)?/, "")}`) : null,
      );

      expect(setup.oddAndEven).toBe(expected.evenAndOdd);
      expect(setup.sections).toHaveLength(expected.sections.length);
      const shown = {
        header: { default: "", first: "", even: "" },
        footer: { default: "", first: "", even: "" },
      };
      for (const [index, want] of expected.sections.entries()) {
        const got = setup.sections[index] as PageSection;
        const label = `section ${index + 1}`;
        expect(
          {
            width: got.width,
            height: got.height,
            orientation: got.orientation,
            start: got.start,
            margins: got.margins,
            differentFirstPage: got.differentFirstPage,
            pageNumbers: got.pageNumbers,
          },
          label,
        ).toEqual({
          width: want.width,
          height: want.height,
          orientation: want.orientation,
          start: want.start,
          margins: want.margins,
          differentFirstPage: want.differentFirstPage,
          pageNumbers: want.pageNumbers,
        });
        for (const [kind, references, resolved] of [
          ["header", want.headerReferences, got.headers],
          ["footer", want.footerReferences, got.footers],
        ] as const) {
          for (const reference of references) {
            const target = relationships.get(reference.id);
            if (target && KINDS.some((each) => each === reference.type)) {
              shown[kind][reference.type as (typeof KINDS)[number]] =
                `word/${target.replace(/^\/?(word\/)?/, "")}`;
            }
          }
          // A kind the section doesn't name is the one before's: the part last named for it.
          for (const type of KINDS) {
            const name = shown[kind][type];
            const held = resolved[type];
            if (name === "" || !parts.has(name)) {
              expect(held, `${label} ${kind} ${type}`).toBeNull();
              continue;
            }
            const xml = part(parts, name);
            expect(held, `${label} ${kind} ${type}`).not.toBeNull();
            if (!held) continue;
            const texts = paragraphTexts(xml);
            expect(held.paragraphs, `${label} ${kind} ${type} paragraphs`).toHaveLength(
              texts.length,
            );
            const has = fieldsNamedIn(xml);
            const fields = held.paragraphs.flatMap((each) =>
              each.runs.flatMap((piece) => (piece.kind === "field" ? [piece.field] : [])),
            );
            expect(fields.sort(), `${label} ${kind} ${type} fields`).toEqual(has.sort());
            // Without fields the text is the part's; with them, each run of text is in the paragraph.
            textRuns(held).forEach((text, at) => {
              const want = texts[at] ?? "";
              if (has.length === 0 && !/w:fld/.test(xml)) {
                expect(text, `${label} ${kind} ${type} text ${at}`).toBe(want);
              } else {
                for (const run of held.paragraphs[at]?.runs ?? []) {
                  if (run.kind === "text") expect(want).toContain(run.text);
                }
              }
            });
          }
        }
      }
    },
    60_000,
  );
});

describe("The page of a native Mind's Word export", () => {
  // protects=the Word export's paper goes by the computer's region as the PDF and Page view do, whatever the interface language, and A4 where the region is unknown; the margins stay one inch; fails_when=the interface language picks the paper, or an unknown region exports Letter; no_claim=a Mind imported from a Word file, which keeps its file's page (above).
  test.each([
    ["GB", ["en-GB"], "en", 11906, 16838],
    ["US", ["en-US"], "zh-CN", 12240, 15840],
    ["", [], "en", 11906, 16838],
  ] as const)(
    "on a computer in %j (languages %j) with the %s interface the .docx page is %d by %d twips",
    async (region, languages, language, width, height) => {
      const core = startCore(await createTempDataFolder(), {
        systemRegion: () => region,
        systemLanguages: () => languages,
      });
      await core.updateSettings({ user: { language } });
      const mind = await core.createMind({ title: "Notes" });
      const client = await connectToMind(core, mind.id);
      appendParagraph(client, "Rent rises with inflation.");
      await client.settled();

      const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      const document = part(files, "word/document.xml");

      expect(document).toContain(`<w:pgSz w:w="${width}" w:h="${height}"/>`);
      expect(document).toContain(
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"',
      );
    },
  );
});
