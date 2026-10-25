import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { HtmlValidate } from "html-validate/node";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import {
  CHART_NODE,
  type CitationCheck,
  type CitationLocation,
  type Document,
  type Pictures,
  type SavedMindExport,
} from "../../src/core";
import { tableGrid } from "../../src/renderer/src/editor/chartCommands";
import { chartFromTable } from "../../src/shared/charts";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, heading, readMind, writeMind } from "../helpers/minds";

const ADDRESS = "https://reader.example/tea";
const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
const HISTORY: CitationLocation = {
  kind: "section",
  heading: "History",
  paragraphs: { from: 3, to: 3 },
};
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const pictures: Pictures = { png: async () => PNG };

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (type: "tableHeader" | "tableCell", ...content: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(...content)],
});
const row = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });

function citation(
  document: Document,
  page: number,
  check: CitationCheck,
  location: CitationLocation | null = null,
): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: page,
      pageTo: page,
      location,
      quote: "Spring tides happen at new moon.",
      check,
      checkReason: check === "found" ? null : "quote-not-on-pages",
    },
  };
}

/** The last table in the Mind, as the editor holds it. */
function lastTable(blocks: ProseMirrorNode): ProseMirrorNode {
  let found: ProseMirrorNode | null = null;
  blocks.descendants((node) => {
    if (node.type.name === "table") found = node;
    return true;
  });
  if (!found) throw new Error("No table in the Mind.");
  return found;
}

/**
 * A Mind with English and Chinese Citations, a table, maths, a chart and a web page's
 * Citation: everything the HTML file has to carry.
 */
async function setUp() {
  const sources = await createTempDataFolder();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    now: manualClock("2026-10-06T12:00:00.000Z").now,
    pictures,
    webPages: {
      fetch: async () =>
        new Response(ARTICLE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    },
  });
  const [tides, chinese] = (await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon."),
    await writeSourceFile(sources, "潮汐.txt", "大潮出现在新月和满月前后。"),
  ])) as [Document, Document];
  const saved = await core.saveWebPage({ address: ADDRESS });
  if (saved.outcome !== "saved") throw new Error("Not saved.");
  const [tea] = (await waitForProcessing(core, [saved.document.id])) as [Document];
  const mind = await core.createMind({ title: "Tides 潮汐 <&>" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    heading(1, "Spring tides"),
    paragraph(
      text("Spring tides happen at new moon and at "),
      text("full moon", "italic"),
      citation(tides, 1, "found"),
      text("."),
    ),
    paragraph(text("大潮出现在新月和满月前后"), citation(chinese, 1, "found"), text("。")),
    paragraph(
      text("The pull falls off as "),
      { type: "inlineMath", attrs: { latex: "1/r^3" } },
      text(":"),
    ),
    { type: "blockMath", attrs: { latex: "F = G\\frac{m_1 m_2}{r^2}" } },
    {
      type: "table",
      content: [
        row(cell("tableHeader", text("Tide 潮")), cell("tableHeader", text("Range 潮差"))),
        row(cell("tableCell", text("Spring 大潮")), cell("tableCell", text("4 m"))),
      ],
    },
    paragraph(text("Neap tides come at the quarter moons"), citation(tides, 2, "not-found")),
    {
      type: "table",
      content: [
        row(cell("tableHeader", text("Quarter")), cell("tableHeader", text("Range"))),
        row(
          cell("tableCell", text("Q1")),
          cell("tableCell", text("4.1"), citation(tides, 1, "found")),
        ),
        row(cell("tableCell", text("Q2")), cell("tableCell", text("5.2"))),
      ],
    },
    paragraph(
      text("Tea reached Europe through Portuguese merchants"),
      citation(tea, 1, "found", HISTORY),
      text("."),
    ),
  ]);
  await client.settled();
  const table = lastTable(readMind(client));
  const chart = chartFromTable(tableGrid(table), {
    blockId: String(table.attrs.id),
    title: "Tide range",
    language: "en",
  });
  if (!chart) throw new Error("The table made no chart.");
  editMind(client, (blocks) => [
    ...blocks,
    { type: CHART_NODE, attrs: { id: randomUUID(), ...chart } },
  ]);
  await client.settled();
  return { core, mind, sources, client, dataDir, tides };
}

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

describe("exporting a Mind to HTML", () => {
  test("only consecutive note markers have a comma, with English, Chinese, spaces and line breaks", async () => {
    const { core, mind, client, tides } = await setUp();
    const cite = () => citation(tides, 1, "found");
    writeMind(client, [
      paragraph(text("First sentence"), cite(), text(". Another sentence"), cite(), cite()),
      paragraph(text("第一句"), cite(), text("。下一句"), cite(), cite()),
      paragraph(cite(), text(" "), cite(), { type: "hardBreak" }, cite()),
      paragraph(cite(), text("Emphasis", "bold"), cite()),
    ]);
    await client.settled();
    const { document } = parseHTML(
      decode((await core.exportMind(mind.id, { format: "html" })).data),
    );
    expect([...document.querySelectorAll("main > p")].map((p) => p.textContent)).toEqual([
      "First sentence1. Another sentence2,3",
      "第一句4。下一句5,6",
      "7,89",
      "10Emphasis11",
    ]);
    expect(document.querySelector("main > p:nth-child(3) > br")).not.toBeNull();
    const markers = [...document.querySelectorAll("sup.note-ref")];
    expect(markers.map((marker) => marker.querySelector("a")?.textContent)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1)),
    );
    for (const [index, marker] of markers.entries()) {
      expect(marker.querySelector("a")?.getAttribute("href")).toBe(`#note-${index + 1}`);
      expect(
        document
          .getElementById(`note-${index + 1}`)
          ?.querySelector(".backref")
          ?.getAttribute("href"),
      ).toBe(`#ref-${index + 1}`);
    }
  });

  test("one self-contained file: the text, notes naming Document and Location, a table, maths, a chart and a web page's address", async () => {
    const { core, mind } = await setUp();

    const exported = await core.exportMind(mind.id, { format: "html" });
    const html = decode(exported.data);

    expect(exported).toMatchObject({
      fileName: "Tides 潮汐 &.html",
      citations: 6,
      unverifiedCitations: 1,
    });
    const { document } = parseHTML(html);
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.title).toBe("Tides 潮汐 &");
    // No title line (#908): the name is the page's title alone.
    expect(document.querySelector("h1")).toBeNull();
    const main = document.querySelector("main");
    expect(main?.textContent).toContain("Spring tides happen at new moon and at full moon1.");
    expect(main?.textContent).toContain("大潮出现在新月和满月前后2。");
    expect(main?.querySelector("em")?.textContent).toBe("full moon");
    expect(main?.querySelectorAll("math")).toHaveLength(2);
    expect(main?.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "1/r^3",
    );
    expect(
      [...(main?.querySelectorAll("table") ?? [])].map((table) =>
        [...table.querySelectorAll("tr")].map((tr) => tr.textContent),
      ),
    ).toEqual([
      ["Tide 潮Range 潮差", "Spring 大潮4 m"],
      ["QuarterRange", "Q14.14", "Q25.2"],
    ]);
    const picture = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    expect(main?.querySelector("img")?.getAttribute("src")).toBe(picture);
    expect(main?.querySelector("img")?.getAttribute("alt")).toBe("Bar chart: Tide range");
    expect(main?.textContent).toContain("Chart: Tide range");

    const notes = [...document.querySelectorAll(".notes li")].map((li) =>
      (li.textContent ?? "").replace(/↩\ufe0e/g, ""),
    );
    expect(document.querySelector(".notes h2")?.textContent).toBe("Notes");
    expect(notes).toEqual([
      "Tides, p. 1",
      "潮汐, p. 1",
      "Tides, p. 2 [unverified]",
      "Tides, p. 1",
      expect.stringMatching(
        /^Tea, The Open Encyclopedia, § History, ¶ 3, https:\/\/reader\.example\/tea, accessed 6 October 2026$/,
      ),
      "Tides, p. 1",
    ]);
    expect(document.querySelector(".notes a[href='https://reader.example/tea']")).not.toBeNull();
  });

  test("every marker links to its note and every note back to its marker", async () => {
    const { core, mind } = await setUp();
    const { document } = parseHTML(
      decode((await core.exportMind(mind.id, { format: "html" })).data),
    );

    const markers = [...document.querySelectorAll("sup.note-ref")];
    const notes = [...document.querySelectorAll(".notes li")];
    expect(markers).toHaveLength(6);
    expect(notes).toHaveLength(6);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    markers.forEach((marker, index) => {
      const number = index + 1;
      expect(marker.id).toBe(`ref-${number}`);
      const link = marker.querySelector("a");
      expect(link?.getAttribute("href")).toBe(`#note-${number}`);
      expect(link?.textContent).toBe(String(number));
      const note = document.getElementById(`note-${number}`);
      expect(note).toBe(notes[index]);
      expect(note?.querySelector("a.backref")?.getAttribute("href")).toBe(`#ref-${number}`);
    });
  });

  test("nothing is fetched: no scripts, no external styles, fonts or pictures; the only web addresses are the pages' own, in notes", async () => {
    const { core, mind } = await setUp();
    const html = decode((await core.exportMind(mind.id, { format: "html" })).data);
    const { document } = parseHTML(html);

    expect(document.querySelectorAll("script, link, iframe, object, embed")).toHaveLength(0);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/url\(|@import/);
    for (const picture of document.querySelectorAll("img")) {
      expect(picture.getAttribute("src")).toMatch(/^data:image\//);
    }
    // MathML's namespace names the language; it is not an address anything is fetched from.
    const addresses = (html.match(/https?:\/\/[^\s"'<)]+/g) ?? []).filter(
      (address) => !address.startsWith("http://www.w3.org/"),
    );
    expect(new Set(addresses)).toEqual(new Set([ADDRESS]));
    for (const link of document.querySelectorAll("a[href^='http']")) {
      expect(link.closest(".notes")).not.toBeNull();
    }
  });

  test("it passes an HTML validator", async () => {
    const { core, mind } = await setUp();
    const html = decode((await core.exportMind(mind.id, { format: "html" })).data);

    const report = await new HtmlValidate({
      extends: ["html-validate:recommended"],
    }).validateString(html);

    expect(
      report.results.flatMap((result) =>
        result.messages.map((message) => `${message.ruleId}: ${message.message}`),
      ),
    ).toEqual([]);
  });

  test("in Chinese, the page and its notes speak Chinese", async () => {
    const { core, mind } = await setUp();
    await core.updateSettings({ user: { language: "zh-CN" } });

    const { document } = parseHTML(
      decode((await core.exportMind(mind.id, { format: "html" })).data),
    );

    expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");
    expect(document.querySelector(".notes h2")?.textContent).toBe("脚注");
    expect(document.querySelector("a.backref")?.getAttribute("aria-label")).toBe("返回正文");
    expect(document.querySelector(".notes li")?.textContent).toContain("Tides，第 1 页");
  });

  test("an empty Mind is an empty page with no notes; a deleted Document's Citation is named as it was cited and marked unverified", async () => {
    const { core, mind } = await setUp();
    const empty = await core.createMind({ title: "Empty" });
    const emptyHtml = decode((await core.exportMind(empty.id, { format: "html" })).data);
    const { document: emptyPage } = parseHTML(emptyHtml);
    expect(emptyPage.querySelector("main")?.textContent).toBe("");
    expect(emptyPage.title).toBe("Empty");
    expect(emptyHtml).not.toContain('class="notes"');
    const report = await new HtmlValidate({
      extends: ["html-validate:recommended"],
    }).validateString(emptyHtml);
    expect(report.valid).toBe(true);

    const [tides] = (await core.listDocuments()).filter((each) => each.name === "Tides");
    if (!tides) throw new Error("No Tides.");
    await core.deleteDocument(tides.id);
    const { document } = parseHTML(
      decode((await core.exportMind(mind.id, { format: "html" })).data),
    );
    expect(document.querySelector("#note-1")?.textContent).toContain("Tides, p. 1 [unverified]");
  });

  test("it is saved under a free name and fingerprinted like the other exports (#80), and its option is remembered", async () => {
    const { core, mind, sources, dataDir } = await setUp();
    await core.setOutputLocation(sources);

    const saved: SavedMindExport = await core.saveMindExport(mind.id, { format: "html" });
    const again: SavedMindExport = await core.saveMindExport(mind.id, { format: "html" });

    if (saved.status !== "saved" || again.status !== "saved") throw new Error("Not saved.");
    expect(saved.file.name).toMatch(/\.html$/);
    expect(again.file.name).not.toBe(saved.file.name);
    expect(queryDatabase(dataDir, "SELECT content_hash, kind FROM own_files")).toContainEqual({
      content_hash: createHash("sha256").update(readFileSync(saved.file.path)).digest("hex"),
      kind: "export",
    });

    await core.updateSettings({
      user: {
        exportOptions: {
          format: "html",
          docx: {
            includeQuestions: false,
            trackChanges: true,
            markAiText: "mark",
            commentFailedChecks: true,
          },
          pdf: { includeQuestions: false },
          html: { includeQuestions: true },
          "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
        },
      },
    });
    expect((await core.getSettings()).user.exportOptions.format).toBe("html");
  });
});
