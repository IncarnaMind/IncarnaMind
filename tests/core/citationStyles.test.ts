/**
 * Citation styles through the core (#289): a Mind's style, its Citations and Bibliography from
 * the Documents' reference records, formatted on the style thread, and the exports in the style.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import type {
  CitationCheck,
  CitationLocation,
  Core,
  Document,
  FormattedCitations,
  ReferencePatch,
} from "../../src/core";
import { FOOTNOTE_NODE } from "../../src/core/api";
import { locatorOf } from "../../src/core/citationStyles/csl";
import { COMMON_CITATION_STYLE_IDS } from "../../src/shared/citationStyles";
import { shippedLocale, shippedStyle, writePack } from "../helpers/citationStyles";
import { CITATION_STYLES, createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, textOf, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

const KAHNEMAN: ReferencePatch = {
  type: "article-journal",
  title: "Prospect theory: An analysis of decision under risk",
  authors: [
    { family: "Kahneman", given: "Daniel" },
    { family: "Tversky", given: "Amos" },
  ],
  issued: "1979-03",
  containerTitle: "Econometrica",
  volume: "47",
  issue: "2",
  pages: "263–291",
  doi: "10.2307/1914185",
  language: "en",
};

const QIAN: ReferencePatch = {
  type: "article-journal",
  title: "一个科学新领域——开放的复杂巨系统及其方法论",
  authors: [{ literal: "钱学森" }, { literal: "于景元" }, { literal: "戴汝为" }],
  issued: "1990",
  containerTitle: "自然杂志",
  volume: "13",
  issue: "1",
  pages: "3–10",
  language: "zh",
};

/** A core with three Documents: an English paper, a Chinese one, and a file with no details. */
async function setUp() {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock().now });
  const paths = await Promise.all([
    writeSourceFile(sources, "prospect.txt", "Losses loom larger than gains."),
    writeSourceFile(sources, "qian.txt", "开放的复杂巨系统。"),
    writeSourceFile(sources, "Lease agreement.txt", "The tenant pays rent monthly."),
  ]);
  const added = await addAndProcess(core, paths);
  const byName = (name: string) => added.find((each) => each.name === name) as Document;
  const prospect = await core.updateReference(byName("prospect").id, KAHNEMAN);
  const qian = await core.updateReference(byName("qian").id, QIAN);
  const lease = byName("Lease agreement");
  const mind = await core.createMind({ title: "Thesis" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client, prospect, qian, lease };
}

/** A Citation of a Document, as the core writes one into an Answer. */
function citation(
  document: Document,
  location: CitationLocation | null,
  check: CitationCheck = "found",
): JSONContent {
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: location?.kind === "page" ? location.from : null,
      pageTo: location?.kind === "page" ? location.to : null,
      location,
      quote: "Losses loom larger than gains.",
      check,
      checkReason: null,
    },
  };
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const page = (from: number, to = from): CitationLocation => ({ kind: "page", from, to });

const plain = (runs: readonly { text: string }[] | null | undefined) =>
  (runs ?? []).map((run) => run.text).join("");

const work = (document: Document, location: CitationLocation | null = null) => ({
  documentId: document.id,
  documentName: document.name,
  location,
});

async function format(
  core: Core,
  style: FormattedCitations["style"],
  ...clusters: ReturnType<typeof work>[][]
) {
  return core.formatCitations({ style, clusters: clusters.map((works) => ({ works })) });
}

describe("a Mind's citation style", () => {
  test("is Numbered until the Mind chooses one, in either language, and keeps its choice", async () => {
    const { core, mind } = await setUp();
    const numbered = { style: "numbered", chosen: false, folderDefault: null };
    expect(await core.getMindCitationStyle(mind.id)).toEqual(numbered);
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await core.getMindCitationStyle(mind.id)).toEqual(numbered);
    expect(await core.setMindCitationStyle(mind.id, "mla")).toEqual({
      style: "mla",
      chosen: true,
      folderDefault: null,
    });
    // Undo puts back "no choice": Numbered again.
    expect(await core.setMindCitationStyle(mind.id, null)).toEqual(numbered);
  });

  test("chosen for a Mind in a Folder, it is the style new Minds there start in; Undo puts both back", async () => {
    const { core } = await setUp();
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    const first = await core.createMind({ title: "Chapter 1", folderId: folder.id });
    const elsewhere = await core.createMind({ title: "Contracts" });
    expect(await core.setMindCitationStyle(first.id, "chicago-notes")).toEqual({
      style: "chicago-notes",
      chosen: true,
      folderDefault: "chicago-notes",
    });

    const second = await core.createMind({ title: "Chapter 2", folderId: folder.id });
    expect(await core.getMindCitationStyle(second.id)).toEqual({
      style: "chicago-notes",
      chosen: true,
      folderDefault: "chicago-notes",
    });
    // A Mind in no Folder is as it was, and a new one there is Numbered.
    expect((await core.getMindCitationStyle(elsewhere.id)).style).toBe("numbered");
    const loose = await core.createMind({ title: "Loose" });
    expect((await core.getMindCitationStyle(loose.id)).style).toBe("numbered");

    // Undo of the first choice: the first Mind has none again, and nor has the Folder.
    await core.setMindCitationStyle(first.id, null, { folderDefault: null });
    expect(await core.getMindCitationStyle(first.id)).toEqual({
      style: "numbered",
      chosen: false,
      folderDefault: null,
    });
    const third = await core.createMind({ title: "Chapter 3", folderId: folder.id });
    expect((await core.getMindCitationStyle(third.id)).style).toBe("numbered");
    // The Mind made meanwhile keeps the style it started in.
    expect((await core.getMindCitationStyle(second.id)).style).toBe("chicago-notes");
  });

  test("is part of the Mind's document, so an open window sees the change", async () => {
    const { core, mind, client } = await setUp();
    await core.setMindCitationStyle(mind.id, "ieee");
    await client.settled();
    expect(client.doc.getMap("settings").get("citationStyle")).toBe("ieee");
  });

  test("refuses what can't be a style's name, but keeps one this version doesn't have", async () => {
    const { core, mind } = await setUp();
    for (const name of ["Harvard 2", "../apa", ""]) {
      await expect(core.setMindCitationStyle(mind.id, name)).rejects.toThrow(
        "isn't a citation style",
      );
    }
    expect((await core.setMindCitationStyle(mind.id, "harvard-2")).style).toBe("harvard-2");
  });
});

describe("formatting a Mind's Citations", () => {
  test("in-text, from each Document's reference record, with the page from its Location", async () => {
    const { core, prospect, qian } = await setUp();
    const apa = await format(core, "apa", [work(prospect, page(265))], [work(qian, page(5, 6))]);
    expect(apa.form).toBe("in-text");
    expect(apa.clusters.map((cluster) => plain(cluster.runs))).toEqual([
      "(Kahneman & Tversky, 1979, p. 265)",
      "(钱学森 et al., 1990, pp. 5–6)",
    ]);
    expect(apa.bibliography.map((entry) => entry.documentId)).toEqual([prospect.id, qian.id]);
    expect(plain(apa.bibliography[0]?.runs)).toContain("Econometrica");
    expect(apa.hangingIndent).toBe(true);
  });

  test("a Location that isn't a page is cited in its own words, not as an invented page", async () => {
    const { core, prospect } = await setUp();
    const slide: CitationLocation = { kind: "slide", from: 4, to: 4 };
    const section: CitationLocation = { kind: "section", heading: "Method" };
    const formatted = await format(core, "apa", [work(prospect, slide)], [work(prospect, section)]);
    expect(formatted.clusters.map((cluster) => plain(cluster.runs))).toEqual([
      "(Kahneman & Tversky, 1979, slide 4)",
      "(Kahneman & Tversky, 1979, § Method)",
    ]);
    // In the style's language: Chinese words for a GB/T style. (The CSL project's GB/T styles
    // print no locator in a citation at all, so nothing of it shows there today.)
    expect(locatorOf(slide, "zh-CN")).toEqual({ locator: "第 4 张幻灯片", label: "custom" });
    expect(locatorOf(page(4, 5), "zh-CN")).toEqual({ locator: "4-5", label: "page" });
    expect(locatorOf({ kind: "lines", from: 3, to: 3 }, "en")).toEqual({
      locator: "3",
      label: "line",
    });
    expect(locatorOf(null, "en")).toEqual({});
    // A Meeting's Citation says who spoke in the app, but a style's locator is the time alone.
    const said: CitationLocation = { kind: "time", from: 723_000, to: 725_000, speaker: "Me" };
    expect(locatorOf(said, "en")).toEqual({ locator: "12:03", label: "custom" });
    expect(locatorOf(said, "zh-CN")).toEqual({ locator: "12:03", label: "custom" });
  });

  test("a PDF page is cited by the page it prints, not by its number in the PDF", async () => {
    const { core, prospect } = await setUp();
    const printed = (from: string, to = from): CitationLocation => ({
      kind: "page",
      from: 14,
      to: 14 + (to === from ? 0 : 1),
      printed: { from, to },
    });
    const formatted = await format(
      core,
      "apa",
      [work(prospect, printed("265"))],
      [work(prospect, printed("68", "69"))],
      [work(prospect, printed("xii"))],
      [work(prospect, printed("1-3"))],
      [work(prospect, printed("A-3"))],
      [work(prospect, printed("iii", "iv"))],
      [work(prospect, printed("5-12", "5-13"))],
    );
    expect(formatted.clusters.map((cluster) => plain(cluster.runs))).toEqual([
      "(Kahneman & Tversky, 1979, p. 265)",
      "(Kahneman & Tversky, 1979, pp. 68–69)",
      "(Kahneman & Tversky, 1979, p. xii)",
      "(Kahneman & Tversky, 1979, p. 1-3)",
      "(Kahneman & Tversky, 1979, p. A-3)",
      "(Kahneman & Tversky, 1979, pp. iii–iv)",
      "(Kahneman & Tversky, 1979, pp. 5-12–5-13)",
    ]);
    expect(locatorOf(printed("1-3"), "en")).toEqual({ locator: "p. 1-3", label: "custom" });
    expect(locatorOf(printed("iii", "iv"), "en")).toEqual({
      locator: "pp. iii–iv",
      label: "custom",
    });
    expect(locatorOf(printed("iii", "iv"), "zh-CN")).toEqual({
      locator: "第 iii–iv 页",
      label: "custom",
    });
    expect(locatorOf(printed("5-12", "5-13"), "en")).toEqual({
      locator: "pp. 5-12–5-13",
      label: "custom",
    });
    expect(locatorOf(printed("68", "69"), "en")).toEqual({ locator: "68-69", label: "page" });
  });

  test("Citations side by side are one cluster, its runs marked with the Citation each belongs to", async () => {
    const { core, prospect, qian } = await setUp();
    const formatted = await format(core, "ieee", [work(qian), work(prospect)]);
    const runs = formatted.clusters[0]?.runs ?? [];
    expect(plain(runs)).toBe("[1], [2]");
    expect(runs.filter((run) => run.work !== undefined).map((run) => [run.text, run.work])).toEqual(
      [
        ["[1]", 0],
        ["[2]", 1],
      ],
    );
  });

  test("a note style writes notes, and the same work again as a short note", async () => {
    const { core, prospect } = await setUp();
    const formatted = await format(
      core,
      "chicago-notes",
      [work(prospect, page(265))],
      [work(prospect, page(270))],
    );
    expect(formatted.form).toBe("note");
    expect(plain(formatted.clusters[0]?.runs)).toContain("Daniel Kahneman and Amos Tversky");
    expect(plain(formatted.clusters[1]?.runs)).toBe(
      "Kahneman and Tversky, “Prospect Theory: An Analysis of Decision under Risk,” 270.",
    );
  });

  test("a Document with no details is listed as it is, marked as needing details", async () => {
    const { core, prospect, lease } = await setUp();
    const formatted = await format(core, "apa", [work(lease, page(2))], [work(prospect)]);
    expect(plain(formatted.clusters[0]?.runs)).toBe("(Lease Agreement, n.d., p. 2)");
    const entry = formatted.bibliography.find((each) => each.documentId === lease.id);
    expect(entry?.needsDetails).toBe(true);
    expect(
      formatted.bibliography.find((each) => each.documentId === prospect.id)?.needsDetails,
    ).toBe(false);
  });

  test("a Document with no details gets an entry from its name alone, never its format or the day it was added, in every style", async () => {
    const { core, prospect, lease } = await setUp();
    const style = (id: FormattedCitations["style"]) => format(core, id, [work(lease)]);
    for (const id of COMMON_CITATION_STYLE_IDS.filter((each) => each !== "numbered")) {
      const { bibliography } = await style(id);
      const entry = bibliography.find((each) => each.documentId === lease.id);
      expect(entry?.needsDetails, id).toBe(true);
      expect(plain(entry?.runs), id).toBe("Lease agreement.");
    }
    // The style's own number stays.
    expect(plain((await style("ieee")).bibliography[0]?.label)).toBe("[1]");
    // A Document with details is written as the style writes it.
    const kahneman = await format(core, "apa", [work(prospect)]);
    expect(plain(kahneman.bibliography[0]?.runs)).toMatch(
      /^Kahneman, D\., & Tversky, A\. \(1979\)\./,
    );
  });

  test("a web page is cited by its section and paragraph, and listed with its site and address", async () => {
    const { core } = await setUp();
    const html = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
    const saved = await core.saveWebPage({ address: "https://encyclopedia.example/tea", html });
    if (saved.outcome !== "saved") throw new Error(saved.failure.message);
    const [tea] = await waitForProcessing(core, [saved.document.id]);
    if (!tea) throw new Error("It went.");
    const history: CitationLocation = {
      kind: "section",
      heading: "History",
      paragraphs: { from: 2, to: 2 },
    };
    const formatted = await format(core, "apa", [work(tea, history)]);
    expect(plain(formatted.clusters[0]?.runs)).toBe("(Lee, 2024, § History, ¶\u00a02)");
    // Its record has the page's author, date, site and address, so it needs no details. The
    // page's title, "Tea - The Open Encyclopedia", doesn't name the site a second time.
    expect(formatted.bibliography.map((entry) => [plain(entry.runs), entry.needsDetails])).toEqual([
      [
        "Lee, A. (2024, May 1). Tea. The Open Encyclopedia. https://encyclopedia.example/tea",
        false,
      ],
    ]);
  });

  test("a deleted Document's Citation is still listed, by the name it had", async () => {
    const { core, prospect } = await setUp();
    const gone = {
      documentId: "00000000-0000-4000-8000-000000000000",
      documentName: "Old notes",
      location: null,
    };
    const formatted = await core.formatCitations({
      style: "apa",
      clusters: [{ works: [gone] }, { works: [work(prospect)] }],
    });
    expect(plain(formatted.clusters[0]?.runs)).toBe("(Old Notes, n.d.)");
    expect(formatted.bibliography.find((each) => each.documentId === null)?.needsDetails).toBe(
      true,
    );
  });

  test("the Bibliography follows an edit to a reference record", async () => {
    const { core, prospect } = await setUp();
    const before = await format(core, "apa", [work(prospect)]);
    expect(plain(before.bibliography[0]?.runs)).toContain("Prospect theory");
    await core.updateReference(prospect.id, { title: "Prospect theory revisited" });
    const after = await format(core, "apa", [work(prospect)]);
    expect(plain(after.bibliography[0]?.runs)).toContain("Prospect theory revisited");
  });

  test("Numbered lists each cited Document once, by the name its footnotes give it", async () => {
    const { core, prospect, lease } = await setUp();
    const formatted = await format(
      core,
      "numbered",
      [work(prospect)],
      [work(lease)],
      [work(prospect, page(2))],
    );
    expect(formatted.form).toBe("numbered");
    expect(formatted.clusters).toEqual([{ runs: [] }, { runs: [] }, { runs: [] }]);
    expect(formatted.bibliography).toEqual([
      {
        documentId: lease.id,
        label: null,
        runs: [{ text: "Lease agreement" }],
        needsDetails: false,
      },
      { documentId: prospect.id, label: null, runs: [{ text: "prospect" }], needsDetails: false },
    ]);
  });

  test("no Citations: an empty Bibliography", async () => {
    const { core } = await setUp();
    expect(await core.formatCitations({ style: "apa", clusters: [] })).toEqual({
      style: "apa",
      form: "in-text",
      clusters: [],
      bibliography: [],
      hangingIndent: false,
    });
  });

  test("refuses a request that isn't one", async () => {
    const { core } = await setUp();
    await expect(core.formatCitations({ style: "apa", clusters: [{ works: [] }] })).rejects.toThrow(
      "one or more cited works",
    );
  });
});

describe("the style thread", () => {
  /** A core whose citation styles are a copy the test can break. */
  async function withStyles(change: (folder: string) => Promise<void> = async () => undefined) {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    await cp(CITATION_STYLES, folder, { recursive: true });
    await change(folder);
    const paths = { dataDir, documents: join(dataDir, "Documents"), citationStyles: folder };
    const core = startCore(dataDir, { paths });
    onTestFinished(() => core.close());
    return core;
  }

  /** A work cited by its name alone, as a deleted Document's Citation is. */
  const named = (name: string) => ({ documentId: null, documentName: name, location: null });

  test("formats 300 references in a note style while the core's thread keeps running", async () => {
    const core = await withStyles();
    const clusters = Array.from({ length: 300 }, (_, index) => ({
      works: [named(`Report ${index + 1}`)],
    }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    try {
      const formatted = await core.formatCitations({ style: "chicago-notes", clusters });
      expect(formatted.bibliography).toHaveLength(300);
      expect(formatted.clusters).toHaveLength(300);
      expect(plain(formatted.clusters[299]?.runs)).toBe("“Report 300,” n.d.");
    } finally {
      clearInterval(timer);
    }
    // Formatting on this thread would have held every tick back until it was done.
    expect(ticks).toBeGreaterThan(5);
  });

  test("a style that can't be read fails its request, and other styles still format", async () => {
    const core = await withStyles(async (folder) =>
      writePack(
        join(folder, "styles.pack"),
        { apa: "<style>not a whole style", ieee: shippedStyle("ieee") },
        Object.fromEntries(["en-US", "en-GB", "zh-CN"].map((code) => [code, shippedLocale(code)])),
      ),
    );
    const request = (style: FormattedCitations["style"]) =>
      core.formatCitations({ style, clusters: [{ works: [named("A book")] }] });
    await expect(request("apa")).rejects.toThrow();
    expect(plain((await request("ieee")).clusters[0]?.runs)).toBe("[1]");
    // Asked again, it fails again, rather than giving an answer it doesn't have.
    await expect(request("apa")).rejects.toThrow();
  });
});

describe("exporting a Mind in its citation style", () => {
  async function written(style: FormattedCitations["style"]) {
    const setup = await setUp();
    const { core, mind, client, prospect, qian } = setup;
    await core.setMindCitationStyle(mind.id, style);
    writeMind(client, [
      paragraph(
        text("Losses loom larger than gains "),
        citation(prospect, page(265)),
        text(" "),
        citation(qian, page(5), "not-found"),
        text(". Systems are open "),
        citation(qian, null),
        text("."),
      ),
    ]);
    await client.settled();
    return setup;
  }

  test("APA to Word: Citations in the text, clustered, unverified marked, and the References", async () => {
    const { core, mind } = await written("apa");
    const exported = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(exported.data);
    const paragraphs = paragraphsOf(part(files, "word/document.xml"));
    expect(paragraphs.map((each) => each.text)).toEqual([
      "Losses loom larger than gains (Kahneman & Tversky, 1979, p. 265; 钱学森 et al., 1990, p. 5) [unverified]. Systems are open (钱学森 et al., 1990).",
      "References",
      expect.stringMatching(/^Kahneman, D., & Tversky, A\. \(1979\)\. Prospect theory/),
      expect.stringMatching(/^钱学森, 于景元, & 戴汝为\. \(1990\)\./),
    ]);
    // No Citation becomes a footnote.
    expect(footnotesOf(part(files, "word/footnotes.xml"))).toEqual({});
    // The journal's name in italics, as APA has it; the Chinese journal's upright.
    const document = part(files, "word/document.xml");
    expect(document).toMatch(/<w:i\/><\/w:rPr><w:t xml:space="preserve">Econometrica<\/w:t>/);
    expect(document).not.toMatch(/<w:i\/><\/w:rPr><w:t xml:space="preserve">自然杂志/);
    expect(document).toContain('w:hanging="720"');
  });

  test("GB/T 7714 numeric to Word: raised numbers right after the word, and 参考文献", async () => {
    const { core, mind } = await written("gb-t-7714-2015-numeric");
    const exported = await core.exportMind(mind.id, { format: "docx" });
    const document = part(unzip(exported.data), "word/document.xml");
    const paragraphs = paragraphsOf(document);
    // Each work with a page is cited on its own, its page raised after its number.
    expect(paragraphs[0]?.text).toBe(
      "Losses loom larger than gains[1]265[2]5 [unverified]. Systems are open[2].",
    );
    expect(document).toContain('<w:vertAlign w:val="superscript"/>');
    expect(paragraphs[1]?.text).toBe("参考文献");
    expect(paragraphs[2]?.text).toMatch(/^\[1\]\tKAHNEMAN D, TVERSKY A\. Prospect theory/);
    expect(paragraphs[3]?.text).toMatch(/^\[2\]\t钱学森, 于景元, 戴汝为\. 一个科学新领域/);
  });

  test("Chicago notes to Word: each cluster a footnote in the style, and the Bibliography", async () => {
    const { core, mind } = await written("chicago-notes");
    const exported = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(exported.data);
    expect(paragraphsOf(part(files, "word/document.xml"))[0]?.text).toBe(
      "Losses loom larger than gains[1]. Systems are open[2].",
    );
    const notes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(
      /Daniel Kahneman and Amos Tversky, “Prospect Theory.*265.*\[unverified\]$/,
    );
    expect(notes[1]).toMatch(/^钱学森 et al\./);
    expect(textOf(part(files, "word/document.xml"))).toContain("Bibliography");
  });

  test("a repeat in Word follows the style's own rule: Bluebook's Id., Chicago's short note, each a note of its own (#1552)", async () => {
    for (const [style, repeat] of [
      ["bluebook-law-review", /^ ?Id\.$/],
      [
        "chicago-notes",
        /^ ?Kahneman and Tversky, “Prospect Theory: An Analysis of Decision under Risk,” 265\.$/,
      ],
    ] as const) {
      const { core, mind, client, prospect } = await setUp();
      await core.setMindCitationStyle(mind.id, style);
      writeMind(client, [
        paragraph(
          text("A "),
          citation(prospect, page(265)),
          text(". B "),
          citation(prospect, page(265)),
          text("."),
        ),
      ]);
      await client.settled();
      const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      const notes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
      expect(notes, style).toHaveLength(2);
      expect(notes[1], style).toMatch(repeat);
      expect(part(files, "word/document.xml"), style).not.toContain("NOTEREF");
    }
  });

  test("two Documents with one name, and another version of one, have a note each in a note style (#1552)", async () => {
    const { core, mind, client, lease } = await setUp();
    await core.setMindCitationStyle(mind.id, "chicago-notes");
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, "lease-copy.txt", "The tenant pays rent monthly.");
    const [copy] = await addAndProcess(core, [path]);
    if (!copy) throw new Error("The copy wasn't added.");
    const twin = await core.renameDocument(copy.id, "Lease agreement");
    const laterVersion = citation(lease, page(2));
    writeMind(client, [
      paragraph(text("A "), citation(lease, page(2)), text(".")),
      paragraph(text("B "), citation(twin, page(2)), text(".")),
      paragraph(
        text("C "),
        { ...laterVersion, attrs: { ...laterVersion.attrs, contentHash: "h2" } },
        text("."),
      ),
    ]);
    await client.settled();
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    const notes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
    expect(notes).toHaveLength(3);
    expect(part(files, "word/document.xml")).not.toContain("NOTEREF");
  });

  test("a Document with no details is in the Bibliography of Markdown and Word, in every style", async () => {
    const { core, mind, client, lease } = await setUp();
    writeMind(client, [paragraph(text("Rent is monthly "), citation(lease, page(2)), text("."))]);
    await client.settled();
    for (const id of COMMON_CITATION_STYLE_IDS.filter((each) => each !== "numbered")) {
      await core.setMindCitationStyle(mind.id, id);
      const markdown = new TextDecoder().decode(
        (await core.exportMind(mind.id, { format: "markdown" })).data,
      );
      expect(markdown, id).toMatch(/Lease agreement[.。]/);
      const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      const entries = paragraphsOf(part(files, "word/document.xml")).map((each) => each.text);
      expect(entries.at(-1), id).toMatch(/Lease agreement[.。]/);
    }
  });

  test("to Markdown: in-text, notes and the Bibliography, in the style", async () => {
    const { core, mind } = await written("apa");
    const apa = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(apa).toContain(
      "Losses loom larger than gains (Kahneman & Tversky, 1979, p. 265; 钱学森 et al., 1990, p. 5) \\[unverified\\].",
    );
    expect(apa).toContain("## References");
    expect(apa).toMatch(/\*Econometrica\*, \*47\*\(2\), 263–291/);

    await core.setMindCitationStyle(mind.id, "gb-t-7714-2015-numeric");
    const gbt = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(gbt).toContain(
      "Losses loom larger than gains<sup>\\[1\\]265\\[2\\]5</sup> \\[unverified\\].",
    );
    expect(gbt).toContain("## 参考文献");

    await core.setMindCitationStyle(mind.id, "chicago-notes");
    const notes = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(notes).toContain("Losses loom larger than gains[^1]. Systems are open[^2].");
    expect(notes).toMatch(
      /\[\^1\]: Daniel Kahneman and Amos Tversky, “Prospect Theory.* \[unverified\]\n/,
    );
  });

  test("switching the style changes the next export, and Numbered exports as before", async () => {
    const { core, mind } = await written("apa");
    await core.setMindCitationStyle(mind.id, "numbered");
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(paragraphsOf(part(files, "word/document.xml")).map((each) => each.text)).toEqual([
      "Losses loom larger than gains[1][2]. Systems are open[3].",
    ]);
    expect(Object.values(footnotesOf(part(files, "word/footnotes.xml")))).toEqual([
      "prospect, p. 265",
      "qian, p. 5 [unverified]",
      "qian",
    ]);
  });

  test("a Mind with no Citations exports with no Bibliography", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [paragraph(text("Nothing cited here."))]);
    await client.settled();
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(paragraphsOf(part(files, "word/document.xml")).map((each) => each.text)).toEqual([
      "Nothing cited here.",
    ]);
  });
});

describe("the User's footnotes beside a citation style", () => {
  const footnote = (...content: JSONContent[]): JSONContent => ({
    type: FOOTNOTE_NODE,
    attrs: { id: randomUUID() },
    content,
  });

  /** A Note with a Citation, a footnote of the User's, and a Citation inside a footnote. */
  async function written(style: FormattedCitations["style"]) {
    const setup = await setUp();
    const { core, mind, client, prospect, qian } = setup;
    await core.setMindCitationStyle(mind.id, style);
    writeMind(client, [
      paragraph(
        text("Losses loom larger "),
        citation(prospect, page(265)),
        text(" than gains "),
        footnote(text("A note of my own.")),
        text(". Systems are open "),
        citation(qian, null),
        footnote(text("Compare "), citation(prospect, page(270)), text(".")),
        text("."),
      ),
    ]);
    await client.settled();
    return setup;
  }

  test("in a style that cites in the text, only the User's footnotes are footnotes, right after the word", async () => {
    const { core, mind } = await written("apa");
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(paragraphsOf(part(files, "word/document.xml"))[0]?.text).toBe(
      "Losses loom larger (Kahneman & Tversky, 1979, p. 265) than gains[1]. Systems are open (钱学森 et al., 1990)[2].",
    );
    // A Citation inside a footnote is written into its text as its source, as in Numbered.
    expect(Object.values(footnotesOf(part(files, "word/footnotes.xml")))).toEqual([
      "A note of my own.",
      "Compare prospect, p. 270.",
    ]);
  });

  test("in a note style, the style's notes and the User's are numbered together, in order", async () => {
    const { core, mind } = await written("chicago-notes");
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(paragraphsOf(part(files, "word/document.xml"))[0]?.text).toBe(
      "Losses loom larger[1] than gains[2]. Systems are open[3][4].",
    );
    const notes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
    expect(notes[0]).toMatch(/^Daniel Kahneman and Amos Tversky, “Prospect Theory/);
    expect(notes[1]).toBe("A note of my own.");
    expect(notes[2]).toMatch(/^钱学森 et al\./);
    expect(notes[3]).toBe("Compare prospect, p. 270.");

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(markdown).toContain("Losses loom larger[^1] than gains[^2]. Systems are open[^3][^4].");
    expect(markdown).toContain("[^2]: A note of my own.");
  });
});
