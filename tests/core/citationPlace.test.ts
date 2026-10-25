import type { JSONContent } from "@tiptap/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import {
  type CitationCheck,
  type Document,
  MIND_SETTINGS_FIELD,
  type Printer,
} from "../../src/core";
import { setBibliographyShown } from "../../src/shared/mindBibliography";
import { recordProposalRequest } from "../../src/shared/proposals";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";
import { zipFingerprint } from "../helpers/zip";

const text = (value: string): JSONContent => ({ type: "text", text: value });

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function cite(
  document: Document,
  page: number | null,
  check: CitationCheck = "found",
  location: unknown = null,
  proposal: { id: string; request: string; kind: "insert" | "delete" } | null = null,
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
      ...(proposal && { proposal }),
      quote: "Spring tides happen at new moon.",
      check,
      checkReason: check === "found" ? null : "quote-not-on-pages",
    },
  };
}

async function setUp(printer?: Printer) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock().now, ...(printer && { printer }) });
  const [tides, chinese] = (await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon."),
    await writeSourceFile(sources, "潮汐.txt", "大潮出现在新月和满月前后。"),
  ])) as [Document, Document];
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, tides: tides as Document, chinese: chinese as Document };
}

async function write(client: MindClient, blocks: JSONContent[]) {
  writeMind(client, blocks);
  await client.settled();
}

const body = (data: Uint8Array) => {
  const files = unzip(data);
  return { files, document: part(files, "word/document.xml") };
};

const listIn = (document: string) =>
  paragraphsOf(document)
    .map((each) => each.text)
    .filter((each) => /^\[\d+\]\t/.test(each));

describe("Citations in a list at the end", () => {
  test("Word: no footnotes, [1] in the text, and one entry for a Document cited twenty times", async () => {
    const { core, mind, client, tides } = await setUp();
    await write(client, [
      paragraph(
        text("Tides "),
        ...Array.from({ length: 20 }, (_, index) => cite(tides, index < 10 ? 2 : 3)),
        text("."),
      ),
    ]);

    const { data, citations } = await core.exportMind(mind.id, {
      format: "docx",
      citationPlace: "list",
    });
    const { files, document } = body(data);

    expect(citations).toBe(20);
    expect(paragraphsOf(document)[0]?.text).toBe("Tides [1].");
    expect(document).not.toContain("w:footnoteReference");
    expect(footnotesOf(part(files, "word/footnotes.xml"))).toEqual({});
    const paragraphs = paragraphsOf(document);
    expect(paragraphs.at(-2)?.text).toBe("Bibliography");
    expect(listIn(document)).toEqual(["[1]\tTides. Cited: p. 2; p. 3"]);
  });

  test("two Documents are numbered in the order first cited, in the text and in the list", async () => {
    const { core, mind, client, tides, chinese } = await setUp();
    await write(client, [
      paragraph(text("大潮 "), cite(chinese, 1), text("。")),
      paragraph(text("Spring tides "), cite(tides, 2), text(", again "), cite(chinese, 1)),
      paragraph(text("Neap tides "), cite(tides, 2), cite(chinese, 1), text(".")),
    ]);

    const { data } = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });
    const { document } = body(data);

    expect(paragraphsOf(document).map((each) => each.text)).toEqual([
      "大潮 [1]。",
      "Spring tides [2], again [1]",
      "Neap tides [1, 2].",
      "Bibliography",
      "[1]\t潮汐. Cited: p. 1",
      "[2]\tTides. Cited: p. 2",
    ]);
  });

  test("a quote not found keeps its unverified mark in the list, and a Citation with no place is listed by name", async () => {
    const { core, mind, client, tides, chinese } = await setUp();
    await write(client, [
      paragraph(text("Tides "), cite(tides, 2), text(", then "), cite(tides, 4, "not-found")),
      paragraph(text("大潮 "), cite(chinese, null, "not-found")),
    ]);

    const { data } = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });

    expect(listIn(body(data).document)).toEqual([
      "[1]\tTides. Cited: p. 2; p. 4 [unverified]",
      "[2]\t潮汐 [unverified]",
    ]);
  });

  test("the list is written whether the Mind shows its Bibliography or not, and the Mind is as it was", async () => {
    const { core, mind, client, tides } = await setUp();
    await write(client, [paragraph(text("Tides "), cite(tides, 2), text("."))]);
    const before = JSON.stringify(readMind(client).toJSON());

    for (const shown of [false, true]) {
      setBibliographyShown(client.doc.getMap(MIND_SETTINGS_FIELD), shown);
      await client.settled();
      const { data } = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });
      expect(listIn(body(data).document)).toEqual(["[1]\tTides. Cited: p. 2"]);
    }
    setBibliographyShown(client.doc.getMap(MIND_SETTINGS_FIELD), false);
    await client.settled();
    expect(JSON.stringify(readMind(client).toJSON())).toBe(before);
  });

  test("Footnotes is the default, and the file is as it was", async () => {
    const { core, mind, client, tides, chinese } = await setUp();
    await write(client, [
      paragraph(text("Tides "), cite(tides, 2), text(" and "), cite(chinese, 1), text(".")),
    ]);

    const plain = await core.exportMind(mind.id, { format: "docx" });
    const footnotes = await core.exportMind(mind.id, {
      format: "docx",
      citationPlace: "footnotes",
    });

    expect(zipFingerprint(footnotes.data)).toBe(zipFingerprint(plain.data));
    const { files, document } = body(plain.data);
    expect(document).toContain("w:footnoteReference");
    expect(Object.values(footnotesOf(part(files, "word/footnotes.xml")))).toEqual([
      "Tides, p. 2",
      "潮汐, p. 1",
    ]);
  });

  test("PDF: no footnotes, [1] in the text, the list at the end", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, chinese } = await setUp(printer);
    await write(client, [
      paragraph(text("Tides "), cite(tides, 2), text(". 大潮 "), cite(chinese, 1), text(".")),
    ]);

    await core.exportMind(mind.id, { format: "pdf", citationPlace: "list" });

    const [document] = printed;
    if (!document) throw new Error("Nothing was printed.");
    expect(document.notes).toEqual([]);
    const { document: page } = parseHTML(`<html><body>${document.body}</body></html>`);
    expect(page.querySelector("p")?.textContent).toBe("Tides [1]. 大潮 [2].");
    expect(page.querySelector("sup.note-ref")).toBeNull();
    expect(page.querySelector("section.bibliography h2")?.textContent).toBe("Bibliography");
    expect(
      [...page.querySelectorAll("section.bibliography p.entry")].map((each) => each.textContent),
    ).toEqual(["[1] Tides. Cited: p. 2", "[2] 潮汐. Cited: p. 1"]);

    await core.exportMind(mind.id, { format: "pdf" });
    expect(printed[1]?.notes).toEqual(["Tides, p. 2", "潮汐, p. 1"]);
  });

  test("the list is in Chinese when the interface is", async () => {
    const { core, mind, client, tides } = await setUp();
    await write(client, [paragraph(text("Tides "), cite(tides, 2), text("."))]);
    await core.updateSettings({ user: { language: "zh-CN" } });

    const { data } = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });
    const paragraphs = paragraphsOf(body(data).document).map((each) => each.text);

    expect(paragraphs.slice(-2)).toEqual(["参考文献", "[1]\tTides。引用位置：第 2 页"]);
  });

  test("a citation style other than Numbered decides for itself", async () => {
    const { core, mind, client, tides } = await setUp();
    await write(client, [paragraph(text("Tides "), cite(tides, 2), text("."))]);
    await core.setMindCitationStyle(mind.id, "apa");

    const listed = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });
    const plain = await core.exportMind(mind.id, { format: "docx" });

    expect(zipFingerprint(listed.data)).toBe(zipFingerprint(plain.data));
    expect(listed.numbered).toBe(false);
  });

  test("Markdown, HTML and the web page to share are not touched", async () => {
    const { core, mind, client, tides } = await setUp();
    await write(client, [paragraph(text("Tides "), cite(tides, 2), text("."))]);

    for (const format of ["markdown", "html"] as const) {
      const plain = await core.exportMind(mind.id, { format });
      const listed = await core.exportMind(mind.id, { format, citationPlace: "list" });
      expect(new TextDecoder().decode(listed.data)).toBe(new TextDecoder().decode(plain.data));
    }
  });

  test("an unknown choice is refused", async () => {
    const { core, mind } = await setUp();
    await expect(
      core.exportMind(mind.id, { format: "docx", citationPlace: "margin" as never }),
    ).rejects.toThrow("citationPlace");
  });
});

describe("What an export tells the question about where Citations go", () => {
  test("the Citations and the Documents they cite, for a Numbered Mind", async () => {
    const { core, mind, client, tides, chinese } = await setUp();
    await write(client, [
      paragraph(text("a"), cite(tides, 2), cite(tides, 3), text("b"), cite(chinese, 1)),
      paragraph(text("c"), cite(tides, 2)),
    ]);

    expect(await core.previewMindExport(mind.id, { format: "docx" })).toMatchObject({
      citations: 4,
      citedDocuments: 2,
      numbered: true,
    });
    await core.setMindCitationStyle(mind.id, "ieee");
    expect(await core.previewMindExport(mind.id, { format: "pdf" })).toMatchObject({
      citations: 4,
      numbered: false,
    });
  });

  test("none for a Mind with no Citations", async () => {
    const { core, mind, client } = await setUp();
    await write(client, [paragraph(text("Nothing cited."))]);

    expect(await core.previewMindExport(mind.id, { format: "docx" })).toMatchObject({
      citations: 0,
      citedDocuments: 0,
    });
  });
});

describe("Citations in changes still waiting, in a list at the end", () => {
  const ASKED = "2026-10-12T14:30:00.000Z";

  const asked = (client: MindClient) =>
    recordProposalRequest(client.doc, "r1", {
      source: "edit-with-ai",
      providerId: "anthropic",
      modelId: "claude",
      createdAt: ASKED,
    });

  async function waiting() {
    const setup = await setUp();
    asked(setup.client);
    await write(setup.client, [
      paragraph(
        text("Kept "),
        cite(setup.tides, 2),
        text(", added "),
        cite(setup.chinese, 1, "found", null, { id: "c1", request: "r1", kind: "insert" }),
        text(", removed "),
        cite(setup.tides, 3, "found", null, { id: "c2", request: "r1", kind: "delete" }),
        text("."),
      ),
    ]);
    return setup;
  }

  const markersIn = (document: string) =>
    [
      ...[...document.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<\/w:(?:t|delText)>/g)]
        .map((each) => each[1])
        .join("")
        .matchAll(/\[(\d+)\]/g),
    ].map((each) => each[1]);

  test("Word: they are markers in the tracked insertion and deletion, and every marker has its entry", async () => {
    const { core, mind } = await waiting();

    const { data } = await core.exportMind(mind.id, { format: "docx", citationPlace: "list" });
    const { document } = body(data);

    const entries = listIn(document);
    expect(entries).toEqual(["[1]\tTides. Cited: p. 2; p. 3", "[2]\t潮汐. Cited: p. 1"]);
    expect(document.match(/<w:ins [^>]*>[\s\S]*?<\/w:ins>/g)?.join("")).toContain("[2]");
    expect(document.match(/<w:del [^>]*>[\s\S]*?<\/w:del>/g)?.join("")).toContain("[1]");
    for (const number of markersIn(document)) {
      expect(entries.some((each) => each.startsWith(`[${number}]`))).toBe(true);
    }
    expect(document).not.toContain("w:footnoteReference");
  });

  test("PDF: a pending insertion is left out, and the rest is numbered from 1", async () => {
    const { printed, printer } = fakePrinter();
    const setup = await setUp(printer);
    asked(setup.client);
    await write(setup.client, [
      paragraph(
        text("Kept "),
        cite(setup.tides, 2),
        text(", added "),
        cite(setup.chinese, 1, "found", null, { id: "c1", request: "r1", kind: "insert" }),
        text("."),
      ),
    ]);

    await setup.core.exportMind(setup.mind.id, { format: "pdf", citationPlace: "list" });

    const [document] = printed;
    if (!document) throw new Error("Nothing was printed.");
    const { document: page } = parseHTML(`<html><body>${document.body}</body></html>`);
    expect(page.querySelector("p")?.textContent).not.toContain("[2]");
    expect(
      [...page.querySelectorAll("section.bibliography p.entry")].map((each) => each.textContent),
    ).toEqual(["[1] Tides. Cited: p. 2"]);
  });
});
