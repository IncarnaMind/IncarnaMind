import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import type {
  CitationCheck,
  CitationLocation,
  Core,
  Document,
  Printer,
  SavedMindExport,
} from "../../src/core";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, question, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";
import { zipFingerprint } from "../helpers/zip";

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function citation(
  document: Document,
  page: number,
  check: CitationCheck,
  overrides: { contentHash?: string; location?: CitationLocation } = {},
): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: document.name,
      contentHash: overrides.contentHash ?? document.contentHash,
      pageFrom: page,
      pageTo: page,
      location: overrides.location ?? null,
      quote: "Spring tides happen at new moon.",
      check,
      checkReason: check === "found" ? null : "quote-not-on-pages",
    },
  };
}

const cell = (type: "tableHeader" | "tableCell", ...content: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(...content)],
});

/** A core with an English and a Chinese Document, and a Mind that cites both. */
async function setUp({ printer, region }: { printer?: Printer; region?: string } = {}) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    now: manualClock().now,
    ...(printer && { printer }),
    ...(region !== undefined && { systemRegion: () => region }),
  });
  const [tides, chinese] = (await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon."),
    await writeSourceFile(sources, "潮汐.txt", "大潮出现在新月和满月前后。"),
  ])) as [Document, Document];
  const mind = await core.createMind({ title: "Tides 潮汐" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, tides, chinese, sources, dataDir };
}

/** English and Chinese Citations, maths in a sentence and on its own line, and a table. */
function writeBilingual(client: MindClient, tides: Document, chinese: Document): void {
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
      text("The pull that raises them falls off as "),
      { type: "inlineMath", attrs: { latex: "1/r^3" } },
      text(", faster than gravity itself:"),
    ),
    { type: "blockMath", attrs: { latex: "F = G\\frac{m_1 m_2}{r^2}" } },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [cell("tableHeader", text("Tide 潮")), cell("tableHeader", text("Range 潮差"))],
        },
        {
          type: "tableRow",
          content: [
            cell("tableCell", text("Spring 大潮")),
            cell("tableCell", text("4 m"), citation(tides, 1, "found")),
          ],
        },
        {
          type: "tableRow",
          content: [
            cell("tableCell", text("Neap 小潮")),
            cell("tableCell", text("2 m"), citation(chinese, 1, "not-found")),
          ],
        },
      ],
    },
    paragraph(text("Neap tides come at the quarter moons"), citation(tides, 2, "not-found")),
  ]);
}

/** A footnote's marker, as the print page finds it. */
const marker = (number: number) => `<sup class="note-ref" data-note="${number}">${number}</sup>`;

describe("exporting a Mind to PDF", () => {
  test("the print page separates adjacent notes without adding commas across prose", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, chinese } = await setUp({ printer });
    writeMind(client, [
      paragraph(
        text("Spring tides"),
        citation(tides, 1, "found"),
        text(". 大潮"),
        citation(chinese, 1, "found"),
        citation(tides, 1, "found"),
      ),
    ]);
    await client.settled();
    await core.exportMind(mind.id, { format: "pdf" });
    const { document } = parseHTML(`<html><body>${printed[0]?.body ?? ""}</body></html>`);
    expect(document.body.textContent).toBe("Spring tides1. 大潮2,3");
    expect(
      [...document.querySelectorAll("sup.note-ref")].map((node) => node.getAttribute("data-note")),
    ).toEqual(["1", "2", "3"]);
  });

  test("Word and Markdown are as they were: a fingerprint of the bilingual fixture's", async () => {
    const { core, mind, client, tides, chinese } = await setUp();
    writeBilingual(client, tides, chinese);
    await client.settled();

    const markdown = (await core.exportMind(mind.id, { format: "markdown" })).data;
    expect(createHash("sha256").update(markdown).digest("hex")).toBe(
      "742f3922386f489bb3bf316db04081492724af4a4755ece4b4b40a7740189cf5",
    );
    const docx = (await core.exportMind(mind.id, { format: "docx" })).data;
    expect(zipFingerprint(docx)).toBe(
      "9f081a86e0c52e4e709d2607c95f38838fe76c5392f8097516db18c466efa9a2",
    );
  });

  test("the printer gets the Mind as HTML: each Citation a numbered footnote naming its Document and Location, maths typeset, the table whole", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides, chinese } = await setUp({ printer });
    writeBilingual(client, tides, chinese);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "pdf" });

    expect(exported).toMatchObject({
      fileName: "Tides 潮汐.pdf",
      citations: 5,
      footnotes: 5,
      unverifiedCitations: 2,
      questions: 0,
    });
    expect(new TextDecoder().decode(exported.data)).toBe("%PDF-stand-in");
    const [document] = printed;
    if (!document) throw new Error("Nothing was printed.");
    expect(document).toMatchObject({ language: "en", paper: "letter", title: "Tides 潮汐" });
    const unverified = ' <span class="unverified">[unverified]</span>';
    expect(document.notes).toEqual([
      "Tides, p. 1",
      "潮汐, p. 1",
      "Tides, p. 1",
      `潮汐, p. 1${unverified}`,
      `Tides, p. 2${unverified}`,
    ]);
    const { body } = document;
    expect(body).toMatch(
      new RegExp(
        `^${escapeRegExp(
          "<h2>Spring tides</h2>" +
            `<p>Spring tides happen at new moon and at <em>full moon</em>${marker(1)}.</p>` +
            `<p>大潮出现在新月和满月前后${marker(2)}。</p>` +
            "<p>The pull that raises them falls off as ",
        )}<span class="katex"><math [^>]*>.*<annotation encoding="application/x-tex">1/r\\^3</annotation></semantics></math></span>, faster than gravity itself:</p>` +
          '<div class="math-display"><span class="katex"><math [^>]*display="block"',
      ),
    );
    expect(body).toContain('<annotation encoding="application/x-tex">F = G\\frac{m_1 m_2}{r^2}');
    expect(body).toContain(
      "<table><tr><th><p>Tide 潮</p></th><th><p>Range 潮差</p></th></tr>" +
        `<tr><td><p>Spring 大潮</p></td><td><p>4 m${marker(3)}</p></td></tr>` +
        `<tr><td><p>Neap 小潮</p></td><td><p>2 m${marker(4)}</p></td></tr></table>`,
    );
    expect(body.endsWith(`<p>Neap tides come at the quarter moons${marker(5)}</p>`)).toBe(true);
  });

  test("the deliverable leaves Questions out unless asked; in Chinese, on a computer in China, the paper is A4 and the footnotes speak Chinese", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides } = await setUp({ printer, region: "CN" });
    await core.updateSettings({ user: { language: "zh-CN" } });
    writeMind(client, [
      question("大潮什么时候出现？"),
      paragraph(text("新月和满月时"), citation(tides, 2, "not-found"), text("。")),
    ]);
    await client.settled();

    const left = await core.exportMind(mind.id, { format: "pdf" });
    await core.exportMind(mind.id, { format: "pdf", includeQuestions: true });

    expect(left.questions).toBe(1);
    const [without, withQuestions] = printed;
    expect(without).toMatchObject({ language: "zh-CN", paper: "a4" });
    expect(without?.body).not.toContain("大潮什么时候出现");
    expect(without?.notes).toEqual(['Tides，第 2 页 <span class="unverified">[未核实]</span>']);
    expect(withQuestions?.body).toContain(
      '<p class="question"><span class="question-label">问题：</span> 大潮什么时候出现？</p>',
    );
  });

  test("the paper goes by the computer's region, not the interface language: A4 in Britain in English, Letter in the US in Chinese", async () => {
    const british = fakePrinter();
    const inBritain = await setUp({ printer: british.printer, region: "GB" });
    await inBritain.core.exportMind(inBritain.mind.id, { format: "pdf" });
    expect(british.printed[0]).toMatchObject({ language: "en", paper: "a4" });

    const american = fakePrinter();
    const inTheUs = await setUp({ printer: american.printer, region: "US" });
    await inTheUs.core.updateSettings({ user: { language: "zh-CN" } });
    await inTheUs.core.exportMind(inTheUs.mind.id, { format: "pdf" });
    expect(american.printed[0]).toMatchObject({ language: "zh-CN", paper: "letter" });
  });

  test("an empty Mind prints nothing, its name only the PDF's title (#908); a Mind with no title takes its first line", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind } = await setUp({ printer });
    const untitled = await core.createMind({ title: "" });

    await core.exportMind(mind.id, { format: "pdf" });
    const exported = await core.exportMind(untitled.id, { format: "pdf" });

    expect(printed[0]).toMatchObject({ body: "", notes: [], title: "Tides 潮汐" });
    expect(exported.fileName).toBe("Untitled.pdf");
    expect(printed[1]).toMatchObject({ body: "", notes: [], title: "Untitled" });
  });

  test("a PDF is refused where nothing can print one, and a failed print saves nothing", async () => {
    const { core, mind, client, tides, chinese, sources } = await setUp();
    writeBilingual(client, tides, chinese);
    await client.settled();
    await expect(core.exportMind(mind.id, { format: "pdf" })).rejects.toMatchObject({
      wording: { key: "error.checkRecord.noPdf" },
    });

    const failing = startCore(await createTempDataFolder(), {
      printer: {
        print: async () => {
          throw new Error("The PDF took too long to lay out.");
        },
      },
    });
    const other = await failing.createMind({ title: "Tides" });
    await failing.setOutputLocation(sources);
    await expect(failing.saveMindExport(other.id, { format: "pdf" })).rejects.toMatchObject({
      name: "PdfLayoutError",
      message: "Couldn’t lay out the PDF.",
      wording: { key: "error.pdf.notLaidOut" },
      cause: new Error("The PDF took too long to lay out."),
    });
    expect(readdirSync(sources)).not.toContain("Tides.pdf");
  });

  test("saving says how many Citations went out and how many quotes weren't found, for the result line, and records the file as IncarnaMind's", async () => {
    const { printer } = fakePrinter();
    const { core, mind, client, tides, chinese, sources, dataDir } = await setUp({ printer });
    writeBilingual(client, tides, chinese);
    await client.settled();
    await core.setOutputLocation(sources);

    const saved: SavedMindExport = await core.saveMindExport(mind.id, { format: "pdf" });

    expect(saved).toMatchObject({
      status: "saved",
      file: { name: "Tides 潮汐.pdf" },
      citations: 5,
      unverifiedCitations: 2,
      questions: 0,
    });
    expect(readFileSync(saved.status === "saved" ? saved.file.path : "", "utf8")).toBe(
      "%PDF-stand-in",
    );
    // Its fingerprint is kept, so checks leave it out of their evidence wherever it goes (#80).
    expect(queryDatabase(dataDir, "SELECT content_hash, kind FROM own_files")).toContainEqual({
      content_hash: createHash("sha256").update("%PDF-stand-in").digest("hex"),
      kind: "export",
    });
  });
});

const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
const ADDRESS = "https://reader.example/tea";
const HISTORY: CitationLocation = {
  kind: "section",
  heading: "History",
  paragraphs: { from: 3, to: 3 },
};
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A web page fetched twice, two days apart, changed in between: two versions. The page is
 * served by a stand-in for the network.
 */
async function savedTwice(printer: Printer, html = ARTICLE) {
  const clock = manualClock("2026-10-06T12:00:00.000Z");
  let page = html;
  const core = startCore(await createTempDataFolder(), {
    now: clock.now,
    printer,
    webPages: {
      fetch: async () =>
        new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    },
  });
  const first = await core.saveWebPage({ address: ADDRESS });
  if (first.outcome !== "saved") throw new Error("Not saved.");
  const [before] = (await waitForProcessing(core, [first.document.id])) as [Document];
  clock.advance(2 * DAY_MS);
  page = html.replace("Tea is an aromatic beverage", "Tea is a fragrant beverage");
  await core.fetchWebPageAgain(before.id);
  const [after] = (await waitForProcessing(core, [before.id])) as [Document];
  return { core, before, after };
}

async function webMind(core: Core, before: Document, after: Document) {
  const mind = await core.createMind({ title: "Tea" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    paragraph(
      text("Tea reached Europe through Portuguese merchants"),
      citation(after, 1, "found", { contentHash: before.contentHash, location: HISTORY }),
      text(". It is the most drunk after water"),
      citation(after, 1, "found", {
        location: { kind: "section", heading: null, start: true },
      }),
      text("."),
    ),
  ]);
  await client.settled();
  return mind;
}

describe("a web page Citation's footnote", () => {
  test("names the page, its site (once), its address and the day the version it quotes was fetched, in every format", async () => {
    const { printed, printer } = fakePrinter();
    const { core, before, after } = await savedTwice(printer);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.name).toBe("Tea - The Open Encyclopedia");
    const mind = await webMind(core, before, after);

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    // The title, "Tea - The Open Encyclopedia", doesn't name the site twice.
    const site = "Tea, The Open Encyclopedia";
    const older = `${site}, § History, ¶\u00a03, ${ADDRESS}, accessed 6 October 2026`;
    const newer = `${site}, § Start, ${ADDRESS}, accessed 8 October 2026`;
    expect(markdown).toContain(`[^1]: ${older}\n[^2]: ${newer}\n`);

    const docx = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(footnotesOf(part(docx, "word/footnotes.xml"))).toEqual({ "1": older, "2": newer });

    await core.exportMind(mind.id, { format: "pdf" });
    const link = `<a href="${ADDRESS}">${ADDRESS}</a>`;
    expect(printed[0]?.notes).toEqual([
      `${site}, § History, ¶\u00a03, ${link}, accessed 6 October 2026`,
      `${site}, § Start, ${link}, accessed 8 October 2026`,
    ]);

    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(chinese).toContain(
      `[^1]: Tea，The Open Encyclopedia，§ History，第 3 段，${ADDRESS}，访问于 2026年10月6日`,
    );
  });

  test("a version that isn't kept gives no accessed day; a deleted page is named as it was cited", async () => {
    const { printer } = fakePrinter();
    const { core, before, after } = await savedTwice(printer);
    const mind = await core.createMind({ title: "Tea" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      paragraph(
        text("Tea"),
        citation(after, 1, "found", { contentHash: "not-a-kept-version", location: HISTORY }),
      ),
    ]);
    await client.settled();

    const kept = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(kept).toContain(`[^1]: Tea, The Open Encyclopedia, § History, ¶\u00a03, ${ADDRESS}\n`);

    await core.deleteDocument(before.id);
    const gone = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(gone).toContain("[^1]: Tea - The Open Encyclopedia, § History, ¶\u00a03 [unverified]\n");
  });

  test("a citation style's notes and Bibliography read it as accessed on that day, where the style asks", async () => {
    const { printed, printer } = fakePrinter();
    // Chicago gives the day a page was read when the page has no date of its own.
    const undated = ARTICLE.replace(/<meta property="article:published_time"[^>]*>/, "");
    const { core, before, after } = await savedTwice(printer, undated);
    const mind = await webMind(core, before, after);
    await core.setMindCitationStyle(mind.id, "chicago-notes");

    await core.exportMind(mind.id, { format: "pdf" });

    const [document] = printed;
    expect(document?.notes[0]).toContain("accessed October 6, 2026");
    expect(document?.notes[0]).toContain("“Tea,” The Open Encyclopedia");
    expect(document?.body).not.toContain("Tea - ");
    expect(document?.notes[1]).toContain("accessed October 8, 2026");
    expect(document?.body).toContain('<section class="bibliography');
    expect(document?.body).toContain("Accessed October 6, 2026");
  });

  test("a Document with no reference details is in the Bibliography by its name alone, with no placeholder, in each style", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client, tides } = await setUp({ printer });
    writeMind(client, [paragraph(text("Spring tides"), citation(tides, 1, "found"))]);
    await client.settled();
    for (const style of ["apa", "chicago-notes", "ieee"] as const) {
      await core.setMindCitationStyle(mind.id, style);
      const result = await core.exportMind(mind.id, { format: "pdf" });
      const body = printed.at(-1)?.body ?? "";
      expect(body, style).toContain("Tides.");
      expect(body, style).not.toContain("needs details");
      expect(body, style).not.toMatch(/added \d/);
      expect(result.needsDetails, style).toEqual([tides.id]);
    }
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
