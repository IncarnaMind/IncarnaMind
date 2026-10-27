/**
 * The source pack (#134): the pages a Mind cites as one PDF, from the pages saved when its
 * Citations were made. The printer gets the pack as HTML: a cover list, then a page for each
 * cited Location with its quotes marked and numbered as the Mind numbers its Citations.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  type CapturePage,
  type CitationAttributes,
  type CitationLocation,
  type CoreAdapters,
  type Document,
  FOOTNOTE_NODE,
  type Printer,
} from "../../src/core";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { PNG, savedPage } from "../helpers/citedPages";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";
import { fakePrinter } from "../helpers/printer";

const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
const ADDRESS = "https://reader.example/tea";
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url)));

/** A mark's left, top, width and height, in percent of its picture. */
const place = (style: string) =>
  [...style.matchAll(/(?:left|top|width|height):([^;]+)/g)].map(([, share]) => share).join(" ");

/** What the printer was given for a pack, taken apart. */
function pack(body: string) {
  const cover = body.slice(0, body.indexOf('<section class="pack-page"'));
  const rows = [
    ...cover.matchAll(
      /<tr><td class="pack-number">(\d+)<\/td><td>([^<]*?)( <span class="unverified">[^<]*<\/span>)?<\/td><td class="pack-ref" data-pack="(\d+)"><\/td><\/tr>/g,
    ),
  ].map(([, number, source, unverified, sheet]) => ({
    number: Number(number),
    source,
    unverified: unverified !== undefined,
    sheet: Number(sheet),
  }));
  const sheets = [
    ...body.matchAll(/<section class="pack-page" data-pack="\d+">([\s\S]*?)<\/section>/g),
  ].map(([, html = ""]) => {
    const heading =
      /<h2 class="pack-title"><span class="pack-numbers">([^<]*)<\/span> ([^<]*)<\/h2>/.exec(html);
    return {
      numbers: heading?.[1],
      source: heading?.[2],
      picture: /<img src="data:([^;]+);base64,/.exec(html)?.[1] ?? null,
      marks: [...html.matchAll(/<span class="pack-mark" style="([^"]+)">/g)].map(([, style = ""]) =>
        place(style),
      ),
      badges: [...html.matchAll(/<span class="pack-badge"[^>]*>(\d+)<\/span>/g)].map(([, number]) =>
        Number(number),
      ),
      notes: [...html.matchAll(/<p class="pack-note[^"]*">([^<]*)<\/p>/g)].map(([, note]) => note),
      quotes: [...html.matchAll(/<p class="pack-quote">.*? (“[^<]*”)<\/p>/g)].map(
        ([, quote]) => quote,
      ),
    };
  });
  return { cover, rows, sheets };
}

/** The pictures a viewer draws are 800 × 600 pixels; its text is drawn in lines of 20-pixel boxes, 10 pixels a character. */
const WIDTH = 800;
const HEIGHT = 600;
const CHARACTER = 10;
const LINE = 30;

/** Where part of a line is, as `place` gives it for a mark: the line, from 0, and its characters. */
function mark(line: number, from: number, to: number): string {
  const share = (value: number, of: number) => `${Math.round((value / of) * 100_000) / 1000}%`;
  return [
    share(40 + from * CHARACTER, WIDTH),
    share(40 + LINE * line, HEIGHT),
    share((to - from) * CHARACTER, WIDTH),
    share(20, HEIGHT),
  ].join(" ");
}

/** A viewer drawing off screen: each Document's text, a line to a run. */
function viewerOf(lines: Readonly<Record<string, readonly string[]>>): CapturePage {
  return async (request) => ({
    data: PNG,
    type: "image/png",
    width: WIDTH,
    height: HEIGHT,
    text: (lines[request.document.name] ?? []).map((text, index) => ({
      text,
      breakAfter: true,
      box: { x: 40, y: 40 + LINE * index, width: text.length * CHARACTER, height: 20 },
    })),
  });
}

/** A core whose model cites what the Documents say, and whose cited pages are saved before the pack is made. */
async function citedMind(plan: {
  files: { name: string; contents: string | Uint8Array }[];
  lines?: Readonly<Record<string, readonly string[]>>;
  query: string;
  records(passages: ShownPassage[]): unknown[];
  answer: string;
  /** Saves this web page too, before the Question is asked. */
  web?: boolean;
  adapters?: Partial<CoreAdapters>;
}) {
  const { printed, printer } = fakePrinter();
  const model = citingModel({ query: plan.query, records: plan.records, answer: plan.answer });
  const setup = await setUpWithDocuments(model, plan.files, {
    capturePage: viewerOf(plan.lines ?? {}),
    printer,
    ...(plan.web && {
      webPages: {
        fetch: async () =>
          new Response(ARTICLE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      },
    }),
    ...plan.adapters,
  });
  if (plan.web) {
    const saved = await setup.core.saveWebPage({ address: ADDRESS });
    if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
    await waitForProcessing(setup.core, [saved.document.id]);
  }
  const { answerId } = await askAndFinish(setup.core, setup.client, setup.mind.id, "Tides?");
  const citations = citationsIn(setup.client, answerId);
  for (const cited of citations) await savedPage(setup.core, cited);
  return { ...setup, printed, citations };
}

const byDocument = (passages: ShownPassage[], name: string) =>
  passages.find((passage) => passage.document === name)?.id ?? "none";

/** A Citation of a Document's page, as a Mind holds one. */
const citation = (
  document: Pick<Document, "id" | "name" | "contentHash">,
  page: number,
  attributes: Partial<CitationAttributes> = {},
): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: page,
    pageTo: page,
    location: { kind: "page", from: page, to: page } satisfies CitationLocation,
    quote: "Spring tides happen at new moon.",
    check: "found",
    checkReason: null,
    ...attributes,
  },
});

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const footnote = (...content: JSONContent[]): JSONContent => ({ type: FOOTNOTE_NODE, content });

/** A core with three Documents and a Mind, whose cited pages were never saved. */
async function setUp({ printer }: { printer?: Printer } = {}) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock().now, ...(printer && { printer }) });
  const [tides, moon, harbour] = (await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon."),
    await writeSourceFile(sources, "Moon.txt", "The Moon's pull raises the tides."),
    await writeSourceFile(sources, "潮汐.txt", "大潮出现在新月和满月前后。"),
  ])) as [Document, Document, Document];
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, tides, moon, harbour, sources, dataDir };
}

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);

describe("the source pack: each format's cited page, its quote highlighted", () => {
  test("a PDF page, a slide, a sheet's rows and a Word section each get a page, the quote marked and numbered", async () => {
    const lines = {
      Deck: ["Quarterly update", "The western region grew fastest"],
      Revenue: ["Region Q1 Q2", "West 350,200 389,600"],
      Review: ["2.1 Sensitivity", "Raising the barrier crest by 40 centimetres halves the damage."],
    };
    const { core, mind, printed, documents, citations } = await citedMind({
      files: [
        { name: "Tides.pdf", contents: TIDES },
        { name: "Deck.pptx", contents: fixture("Quarterly Research Update.pptx") },
        { name: "Revenue.xlsx", contents: fixture("Regional Revenue.xlsx") },
        { name: "Review.docx", contents: fixture("Coastal Flood Risk Review.docx") },
      ],
      lines,
      query: "spring tides western region revenue barrier crest",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "Tides"),
          pageFrom: 2,
          pageTo: 2,
          quote: SPRING,
        },
        {
          marker: 2,
          passage: byDocument(passages, "Deck"),
          location: "slide 3",
          quote: "The western region grew fastest",
        },
        {
          marker: 3,
          passage: byDocument(passages, "Revenue"),
          location: "Revenue, rows 7–8",
          quote: "West 350,200 389,600",
        },
        {
          marker: 4,
          passage: byDocument(passages, "Review"),
          location: "§ 2.1 Sensitivity",
          quote: "Raising the barrier crest by 40 centimetres",
        },
      ],
      answer:
        "Spring tides come at new and full moon [^1]; the west grew [^2] and led [^3]; the crest helps [^4].",
    });
    expect(documents).toHaveLength(4);
    expect(citations).toHaveLength(4);

    const exported = await core.exportMind(mind.id, { format: "source-pack" });

    expect(exported).toMatchObject({
      fileName: "Tides - source pack.pdf",
      citations: 4,
      unverifiedCitations: 0,
    });
    const [printedPack] = printed;
    expect(printedPack).toMatchObject({ title: "Tides - source pack", notes: [] });
    const { rows, sheets } = pack(printedPack?.body ?? "");
    // The cover list: each Citation by the number the Mind gives it, and the sheet it is on.
    expect(rows.map(({ number, source, sheet }) => [number, source, sheet])).toEqual([
      [1, "Tides, p. 2", 0],
      [2, "Deck, slide 3", 1],
      [3, "Revenue, Revenue, row 7", 2],
      [4, "Review, § 2.1 Sensitivity", 3],
    ]);
    // A page for each, from its saved picture: a PDF's is a JPEG, the others' what a viewer drew.
    expect(sheets.map(({ numbers, picture }) => [numbers, picture])).toEqual([
      ["1", "image/jpeg"],
      ["2", "image/png"],
      ["3", "image/png"],
      ["4", "image/png"],
    ]);
    for (const [index, sheet] of sheets.entries()) {
      expect(sheet.marks.length, `page ${index + 1}'s quote is marked`).toBeGreaterThan(0);
      expect(sheet.badges).toEqual([index + 1]);
      expect(sheet.notes).toEqual([]);
    }
    // Where each quote is drawn, as a share of its picture: part of a line, for the Word section's.
    expect(sheets[1]?.marks).toEqual([mark(1, 0, 31)]);
    expect(sheets[2]?.marks).toEqual([mark(1, 0, 20)]);
    expect(sheets[3]?.marks).toEqual([mark(1, 0, 43)]);
    // On the PDF's page, from its own text, whatever size it is drawn at: inside the picture.
    for (const style of sheets[0]?.marks ?? []) {
      for (const share of style.split(" ")) {
        expect(Number.parseFloat(share)).toBeGreaterThanOrEqual(0);
        expect(Number.parseFloat(share)).toBeLessThanOrEqual(100);
      }
    }
  });

  test("a web page's page names its site, its address and the day the version quoted was fetched", async () => {
    const { core, mind, printed } = await citedMind({
      files: [{ name: "Notes.md", contents: "# Notes\n\nTea is a drink.\n" }],
      web: true,
      lines: {
        "Tea - The Open Encyclopedia": [
          "Tea",
          "Tea is an aromatic beverage prepared by pouring hot or boiling water over cured leaves",
        ],
      },
      query: "tea aromatic beverage",
      records: (passages) => {
        const tea = passages.find((passage) => passage.document.startsWith("Tea"));
        return [
          {
            marker: 1,
            passage: tea?.id ?? "none",
            ...(tea?.location && { location: tea.location }),
            quote: "Tea is an aromatic beverage prepared by pouring hot or boiling water",
          },
        ];
      },
      answer: "Tea is an aromatic beverage [^1].",
    });

    await core.exportMind(mind.id, { format: "source-pack" });

    const { rows, sheets } = pack(printed[0]?.body ?? "");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toMatch(
      /^Tea, The Open Encyclopedia, § Start, ¶.1, https:\/\/reader\.example\/tea, accessed \d+ \w+ \d{4}$/,
    );
    expect(sheets.map(({ numbers, picture, marks }) => [numbers, picture, marks])).toEqual([
      ["1", "image/png", [mark(1, 0, 68)]],
    ]);
  });

  test("a quote across two lines is marked on both; Citations of one Location share its page; a quote not on the saved page is said so", async () => {
    const { core, mind, printed } = await citedMind({
      files: [
        {
          name: "Tides.md",
          contents:
            "# Tides\n\nSpring tides happen at new moon and at full moon, when the Sun and Moon line up.\n\nNeap tides come at the quarter moons.\n",
        },
      ],
      lines: {
        Tides: [
          "Tides",
          "Spring tides happen at new moon and",
          "at full moon, when the Sun and Moon line up.",
        ],
      },
      query: "spring neap tides",
      records: (passages) =>
        [
          "Spring tides happen at new moon",
          "new moon and at full moon, when the Sun",
          "Neap tides come at the quarter moons.",
        ].map((quote, index) => ({
          marker: index + 1,
          passage: byDocument(passages, "Tides"),
          location: "§ Tides",
          quote,
        })),
      answer: "Spring tides [^1] come when the Sun lines up [^2]; neap tides at the quarters [^3].",
    });

    await core.exportMind(mind.id, { format: "source-pack" });

    const { rows, sheets } = pack(printed[0]?.body ?? "");
    // One page for the one Location, with all three Citations.
    expect(sheets).toHaveLength(1);
    expect(rows.map(({ number, sheet }) => [number, sheet])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const [sheet] = sheets;
    expect(sheet?.numbers).toBe("1, 2, 3");
    // The first quote is part of a line; the second runs from the middle of one line to the next.
    expect(sheet?.marks).toEqual([mark(1, 0, 31), mark(1, 23, 35), mark(2, 0, 26)]);
    expect(sheet?.badges).toEqual([1, 2]);
    // The third is in the file but wasn't drawn on the saved page.
    expect(sheet?.notes).toEqual(["3 · Quote not found on this page"]);
  });
});

describe("the source pack: after the file is gone, and without the page", () => {
  test("a deleted source still exports, from its saved page, across a restart", async () => {
    const { core, mind, dataDir, documents, printed } = await citedMind({
      files: [{ name: "Tides.pdf", contents: TIDES }],
      query: "spring tides",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "Tides"),
          pageFrom: 2,
          pageTo: 2,
          quote: SPRING,
        },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const [document] = documents;
    if (!document?.path) throw new Error("Nothing was added.");
    await core.exportMind(mind.id, { format: "source-pack" });
    expect(pack(printed[0]?.body ?? "").sheets[0]?.picture).toBe("image/jpeg");

    await rm(document.path);
    await core.reconcileDocuments();
    await core.deleteDocument(document.id);
    core.close();
    const again = fakePrinter();
    const restarted = startCore(dataDir, { printer: again.printer });
    await restarted.exportMind(mind.id, { format: "source-pack" });

    // The same pack: its picture, the quote marked where it was, and the cover list's words.
    expect(again.printed[0]?.body).toBe(printed[0]?.body);
    expect(pack(again.printed[0]?.body ?? "").rows.map((row) => row.source)).toEqual([
      "Tides, p. 2",
    ]);
  });

  test("a Citation whose page wasn't saved gets a page with its quote as words, and says so; a deleted Document is named as it was", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, moon } = await setUp({ printer });
    writeMind(client, [
      paragraph(text("Spring tides"), citation(tides, 2), text(".")),
      paragraph(
        text("The Moon"),
        citation(moon, 1, { quote: "The Moon's pull raises the tides.", check: "not-found" }),
      ),
    ]);
    await client.settled();
    await core.deleteDocument(moon.id);

    await core.exportMind(mind.id, { format: "source-pack" });

    const { rows, sheets } = pack(printed[0]?.body ?? "");
    expect(rows).toEqual([
      { number: 1, source: "Tides, p. 2", unverified: false, sheet: 0 },
      { number: 2, source: "Moon, p. 1", unverified: true, sheet: 1 },
    ]);
    expect(sheets.map((sheet) => [sheet.numbers, sheet.picture, sheet.marks])).toEqual([
      ["1", null, []],
      ["2", null, []],
    ]);
    const unsaved = "This page wasn’t saved when it was cited, so only the quotes are shown.";
    expect(sheets.map((sheet) => sheet.notes)).toEqual([[unsaved], [unsaved]]);
    expect(sheets.map((sheet) => [sheet.badges, sheet.quotes])).toEqual([
      [[1], ["“Spring tides happen at new moon.”"]],
      [[2], ["“The Moon&#39;s pull raises the tides.”"]],
    ]);
  });

  test("a quote a PDF's line end cut is words on a page that wasn't saved, and a quote with nothing to read it by is joined", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, moon } = await setUp({ printer });
    writeMind(client, [
      paragraph(
        text("Spring tides"),
        citation(tides, 2, {
          quote: "Spring tides happen at new moon.\nThen, em-\nployment ends.",
        }),
        text("."),
      ),
      paragraph(
        text("The Moon"),
        citation(moon, 1, {
          quote: "The Moon's pull raises the av-\nerage tide.",
          check: "not-found",
        }),
      ),
    ]);
    await client.settled();
    await core.deleteDocument(moon.id);

    await core.exportMind(mind.id, { format: "source-pack" });

    const { sheets } = pack(printed[0]?.body ?? "");
    expect(sheets.map((sheet) => sheet.quotes)).toEqual([
      ["“Spring tides happen at new moon. Then, employment ends.”"],
      ["“The Moon&#39;s pull raises the average tide.”"],
    ]);
  });

  test("a Mind with no Citations has no pack: the preview counts none, and the export says so, in the interface language", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client } = await setUp({ printer });
    writeMind(client, [paragraph(text("Nothing is cited."))]);
    await client.settled();

    expect(await core.previewMindExport(mind.id, { format: "source-pack" })).toMatchObject({
      fileName: "Tides - source pack.pdf",
      citations: 0,
    });
    await expect(core.exportMind(mind.id, { format: "source-pack" })).rejects.toThrow(
      "No Citations yet, so no cited pages to export.",
    );
    await core.updateSettings({ user: { language: "zh-CN" } });
    await expect(core.exportMind(mind.id, { format: "source-pack" })).rejects.toThrow(
      "还没有引用，没有可导出的引用页面。",
    );
    expect(printed).toEqual([]);
  });

  test("a pack is refused where nothing can print a PDF", async () => {
    const { core, mind, client, tides } = await setUp();
    writeMind(client, [paragraph(text("Tides"), citation(tides, 2))]);
    await client.settled();

    await expect(core.exportMind(mind.id, { format: "source-pack" })).rejects.toThrow(
      "This copy of IncarnaMind can't make PDFs.",
    );
  });
});

describe("the source pack: the numbers of the Mind's Citations", () => {
  /** Two Citations side by side, a footnote of the User's, one Citation on its own, and the first again. */
  async function numbered(style: "numbered" | "chicago-notes" | "apa") {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, moon, harbour } = await setUp({ printer });
    writeMind(client, [
      paragraph(
        text("Tides "),
        citation(tides, 2),
        text(" "),
        citation(moon, 2),
        text(" rise"),
        footnote(text("Mine.")),
        text(". Harbours "),
        citation(harbour, 2),
      ),
      paragraph(text("Again"), citation(tides, 2)),
    ]);
    await client.settled();
    await core.setMindCitationStyle(mind.id, style);
    await core.exportMind(mind.id, { format: "source-pack" });
    const { rows, sheets } = pack(printed[0]?.body ?? "");
    return {
      cover: rows.map((row) => row.number),
      pages: sheets.map((sheet) => `${sheet.source?.split(",")[0]} ${sheet.numbers}`),
    };
  }

  // The same Mind, numbered as the editor numbers it (tests/renderer/citationClusters.test.ts).
  test("Numbered: each Citation takes the next number, the User's footnote one too", async () => {
    expect(await numbered("numbered")).toEqual({
      cover: [1, 2, 4, 5],
      pages: ["Tides 1, 5", "Moon 2", "潮汐 4"],
    });
  });

  test("a note style: Citations side by side are one note, one number", async () => {
    expect(await numbered("chicago-notes")).toEqual({
      cover: [1, 1, 3, 4],
      pages: ["Tides 1, 4", "Moon 1", "潮汐 3"],
    });
  });

  test("a style that cites in the text: the Citations are numbered among themselves", async () => {
    expect(await numbered("apa")).toEqual({
      cover: [1, 2, 3, 4],
      pages: ["Tides 1, 4", "Moon 2", "潮汐 3"],
    });
  });
});

describe("the source pack: Chinese, a huge Mind, and the file", () => {
  test("a Chinese Document's quote is marked, and the pack speaks Chinese", async () => {
    const { core, mind, printed } = await citedMind({
      files: [{ name: "潮汐.md", contents: "# 潮汐\n\n大潮出现在新月和满月前后。\n" }],
      lines: { 潮汐: ["潮汐", "大潮出现在新月和满月前后。"] },
      query: "大潮 新月",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "潮汐"),
          location: "§ 潮汐",
          quote: "大潮出现在新月和满月前后",
        },
      ],
      answer: "大潮出现在新月和满月前后 [^1]。",
    });
    await core.updateSettings({ user: { language: "zh-CN" } });

    const exported = await core.exportMind(mind.id, { format: "source-pack" });

    expect(exported.fileName).toBe("Tides - 引用页面合集.pdf");
    const [printedPack] = printed;
    const { cover, rows, sheets } = pack(printedPack?.body ?? "");
    expect(printedPack).toMatchObject({ language: "zh-CN", title: "Tides - 引用页面合集" });
    expect(cover).toContain("此笔记引用的页面。引文已高亮，编号与笔记中的引用一致。");
    expect(cover).toContain("<th>引用</th><th>文档和位置</th><th>页码</th>");
    expect(rows.map((row) => row.source)).toEqual(["潮汐，§ 潮汐"]);
    expect(sheets[0]?.marks).toEqual([mark(1, 0, 12)]);
  });

  test("a Mind of 300 Citations of as many Locations gets 300 pages and a cover list of 300 rows", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides } = await setUp({ printer });
    writeMind(
      client,
      Array.from({ length: 300 }, (_, index) =>
        paragraph(text(`Claim ${index + 1}`), citation(tides, index + 1)),
      ),
    );
    await client.settled();

    await core.exportMind(mind.id, { format: "source-pack" });

    const { rows, sheets } = pack(printed[0]?.body ?? "");
    expect(rows.map((row) => row.number)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(sheets.map((sheet) => sheet.numbers)).toEqual(
      Array.from({ length: 300 }, (_, i) => String(i + 1)),
    );
  });

  test("saved, the file's fingerprint is recorded as a source pack's; saved again it takes the next free name", async () => {
    const { printer } = fakePrinter();
    const { core, mind, client, tides, sources, dataDir } = await setUp({ printer });
    writeMind(client, [paragraph(text("Spring tides"), citation(tides, 2))]);
    await client.settled();
    await core.setOutputLocation(sources);

    const first = await core.saveMindExport(mind.id, { format: "source-pack" });
    const second = await core.saveMindExport(mind.id, { format: "source-pack" });

    expect(first).toMatchObject({
      status: "saved",
      file: { name: "Tides - source pack.pdf" },
      citations: 1,
    });
    expect(second).toMatchObject({ status: "saved", file: { name: "Tides - source pack 2.pdf" } });
    expect(
      readdirSync(sources)
        .filter((name) => name.endsWith(".pdf"))
        .sort(),
    ).toEqual(["Tides - source pack 2.pdf", "Tides - source pack.pdf"]);
    // Checks leave it out of their evidence wherever it goes (#80): one fingerprint, for the same bytes.
    expect(queryDatabase(dataDir, "SELECT content_hash, kind FROM own_files")).toEqual([
      {
        content_hash: createHash("sha256").update("%PDF-stand-in").digest("hex"),
        kind: "source-pack",
      },
    ]);
  });
});
