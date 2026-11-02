import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { HtmlValidate } from "html-validate/node";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import type {
  CitationAttributes,
  CitationCheck,
  Document,
  ExportMindOptions,
  SavedMindExport,
} from "../../src/core";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { type CitationCard, citationCard } from "../../src/core/exports/citationCards";
import { exportLabels } from "../../src/core/exports/labels";
import { renderSharePage } from "../../src/core/exports/sharePage";
import type { Language } from "../../src/core/language";
import type { Footnote } from "../../src/core/mindText";
import { translate } from "../../src/shared/i18n";
import { locationOf, quoteInUnits } from "../../src/shared/locations";
import type { UnitKind, UnitText } from "../../src/shared/units";
import {
  createTempDataFolder,
  manualClock,
  NO_MODEL_FILES,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

const ADDRESS = "https://reader.example/tea";
const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
const SCAN = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));

/** Words in the Documents that no Citation quotes, so none may be in the page. */
const UNCITED = [
  "Revenue for the half year rose to 812 million pounds.",
  "Scaffolding stays up until the spring.",
  "The appendix lists every store by region.",
  "Hiring stays frozen elsewhere.",
  "Tea became fashionable among the British upper classes",
  "Our next review is in January.",
  "The tide tables were last printed in 1998.",
];

const QUOTES = {
  pdf: "Net debt to EBITDA was 3.1 times at the end of the quarter",
  scan: "two cracks in the east wall",
  word: "Gross margin fell to 38.6% in the quarter",
  sheet: "1310",
  slide: "Leverage stays under 3.5 times",
  transcript: "The launch moves to March",
  web: "a ship of the Dutch East India Company brought the first green tea leaves to Amsterdam",
  markdown: "Stores in the north reopen in May",
  text: "Spring tides come twice a month",
} as const;

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

/** A Document's stored Units, as the check reads them. */
function unitsOf(dataDir: string, document: Document): UnitText[] {
  return queryDatabase<{
    page: number;
    text: string;
    kind: string;
    label: string | null;
    anchors: string | null;
  }>(
    dataDir,
    `SELECT page, text, kind, label, anchors FROM document_pages
     WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
    [document.id, document.contentHash],
  ).map((row) => ({
    page: row.page,
    text: row.text,
    kind: row.kind as UnitKind,
    label: row.label ? JSON.parse(row.label) : null,
    anchors: row.anchors ? JSON.parse(row.anchors) : null,
  }));
}

/**
 * A Citation of `quote` as an Answer makes it: of the Unit the quote is on (or `page`, for a
 * quote that isn't there), with the Location worked out from where it is.
 */
function cite(
  dataDir: string,
  document: Document,
  quote: string,
  {
    check = "found",
    page,
    verdict,
  }: { check?: CitationCheck; page?: number; verdict?: string } = {},
): JSONContent {
  const units = unitsOf(dataDir, document);
  const unit =
    units.find((each) => each.page === page) ??
    units.find((each) => quoteInUnits([each], quote) !== null);
  if (!unit) throw new Error(`“${quote}” isn't in ${document.name}.`);
  return {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: unit.page,
      pageTo: unit.page,
      location: locationOf([unit], quoteInUnits([unit], quote)),
      quote,
      check,
      checkReason: check === "found" ? null : "quote-not-on-pages",
      ...(verdict && { verdict }),
    },
  };
}

/** A Mind citing a PDF, a scan, a Word file, a sheet, a deck, a Transcript, a web page, Markdown and text. */
async function setUp() {
  const sources = await createTempDataFolder();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    now: manualClock("2026-10-13T12:00:00.000Z").now,
    textRecognizer: createFakeTextRecognizer({
      script: {
        pages: {
          1: {
            lines: [
              "The survey found two cracks in the east wall above the door.",
              "Scaffolding stays up until the spring.",
            ],
          },
        },
      },
    }),
    textRecognitionModelSource: NO_MODEL_FILES,
    webPages: {
      fetch: async () =>
        new Response(ARTICLE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    },
  });
  const files = await Promise.all([
    writeSourceFile(
      sources,
      "Northwind results.pdf",
      buildPdf([
        { lines: ["Revenue for the half year rose to 812 million pounds."] },
        {
          lines: [
            "Capital expenditure was 61 million pounds.",
            "Net debt to EBITDA was 3.1 times at the end of the quarter.",
          ],
        },
      ]),
    ),
    writeSourceFile(sources, "Site survey.pdf", buildPdf([{ scan: SCAN }])),
    writeSourceFile(
      sources,
      "Credit memo.docx",
      docxOf([
        { text: "Results", heading: 1 },
        {
          text: "Online sales slowed. Gross margin fell to 38.6% in the quarter, mostly in online.",
        },
        { text: "The appendix lists every store by region." },
      ]),
    ),
    writeSourceFile(
      sources,
      "Revenue.xlsx",
      xlsxOf([
        {
          name: "Q3",
          rows: [
            ["Segment", "Q3 2025", "Q3 2026"],
            ["Online", 1204, 1310],
            ["Stores", 2210, 2105],
          ],
        },
      ]),
    ),
    writeSourceFile(
      sources,
      "Board deck.pptx",
      pptxOf({
        slides: [{ shapes: sp({ body: txBody(para("Leverage stays under 3.5 times")) }) }],
      }),
    ),
    writeSourceFile(
      sources,
      "Standup.vtt",
      "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Priya>We hired two engineers.\n\n" +
        "00:01:05.000 --> 00:01:09.000\n<v Sam>The launch moves to March.\n\n" +
        "00:01:10.000 --> 00:01:12.000\n<v Priya>Hiring stays frozen elsewhere.\n",
    ),
    writeSourceFile(
      sources,
      "Plan.md",
      "# Plan\n\nOur next review is in January.\n\n## Stores\n\nStores in the north reopen in May, a month late.\n",
    ),
    writeSourceFile(
      sources,
      "Tides.txt",
      "Spring tides come twice a month, at new and full moon.\n\nThe tide tables were last printed in 1998.\n",
    ),
  ]);
  const documents = await addAndProcess(core, files);
  const named = (name: string) => {
    const found = documents.find((each) => each.name === name);
    if (!found) throw new Error(`No ${name}.`);
    return found;
  };
  const saved = await core.saveWebPage({ address: ADDRESS });
  if (saved.outcome !== "saved") throw new Error("Not saved.");
  const [tea] = (await waitForProcessing(core, [saved.document.id])) as [Document];
  const pdf = named("Northwind results");
  const word = named("Credit memo");
  const tides = named("Tides");
  const mind = await core.createMind({ title: "Credit memo: Northwind <Retail>" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    paragraph(text("Leverage was 3.1×"), cite(dataDir, pdf, QUOTES.pdf), text(".")),
    paragraph(text("The east wall cracked"), cite(dataDir, named("Site survey"), QUOTES.scan)),
    paragraph(text("Margins fell"), cite(dataDir, word, QUOTES.word)),
    paragraph(text("Online grew"), cite(dataDir, named("Revenue"), QUOTES.sheet)),
    paragraph(text("The board was told"), cite(dataDir, named("Board deck"), QUOTES.slide)),
    paragraph(text("The launch slips"), cite(dataDir, named("Standup"), QUOTES.transcript)),
    paragraph(text("Tea reached Europe by sea"), cite(dataDir, tea, QUOTES.web)),
    paragraph(text("The north reopens late"), cite(dataDir, named("Plan"), QUOTES.markdown)),
    paragraph(text("Tides follow the moon"), cite(dataDir, tides, QUOTES.text)),
    paragraph(
      text("Margins rose"),
      cite(dataDir, word, "Gross margin rose to 44%", { check: "not-found", page: 1 }),
    ),
    paragraph(
      text("Leverage was 2.1×"),
      cite(dataDir, pdf, QUOTES.pdf, {
        check: "contradicted",
        verdict: "The results say 3.1 times, p. 2",
      }),
    ),
  ]);
  await client.settled();
  return { core, mind, dataDir, sources, tides };
}

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

async function sharedPage(
  core: Awaited<ReturnType<typeof setUp>>["core"],
  mindId: string,
  options: Partial<ExportMindOptions> = {},
) {
  const exported = await core.exportMind(mindId, { format: "share-page", ...options });
  const html = decode(exported.data);
  return { exported, html, document: parseHTML(html).document };
}

const cardText = (card: Element | null, selector: string) =>
  card?.querySelector(selector)?.textContent?.trim() ?? null;

describe("a web page to share (#72)", { timeout: 60_000 }, () => {
  test("each Citation's card shows its kind's content: the quote, its paragraph, cells or lines", async () => {
    const { core, mind } = await setUp();

    const { exported, document } = await sharedPage(core, mind.id);

    expect(exported.fileName).toBe("Credit memo Northwind Retail.html");
    const card = (number: number) => document.getElementById(`card-${number}`);
    expect(document.querySelectorAll("section.card")).toHaveLength(11);

    // A PDF's page and a slide: the quote as text, until their pictures come.
    expect(cardText(card(1), ".card-heading")).toBe("Quote found on p. 2");
    expect(cardText(card(1), ".card-source")).toBe("Northwind results · as of 13 Oct 2026");
    expect(cardText(card(1), ".card-passage")).toBe(`“${QUOTES.pdf}”`);
    expect(cardText(card(5), ".card-passage")).toBe(`“${QUOTES.slide}”`);
    expect(cardText(card(5), ".card-heading")).toBe("Quote found on slide 1");

    // A scan says its text was read from the picture.
    expect(cardText(card(2), ".card-passage")).toBe(`“${QUOTES.scan}”`);
    expect(card(2)?.textContent).toContain("Text read from a scan");

    // Word, a web page, Markdown and text: the paragraph, its quote washed.
    expect(cardText(card(3), ".card-passage")).toBe(
      "Online sales slowed. Gross margin fell to 38.6% in the quarter, mostly in online.",
    );
    expect(cardText(card(3), "mark.quote")).toBe(QUOTES.word);
    expect(cardText(card(7), ".card-passage")).toMatch(
      /^Tea was first introduced to Portuguese priests.*Amsterdam from China\.$/,
    );
    expect(cardText(card(7), "mark.quote")).toBe(QUOTES.web);
    expect(card(7)?.querySelector(".card-address a")?.getAttribute("href")).toBe(ADDRESS);
    expect(cardText(card(8), ".card-passage")).toBe(
      "Stores in the north reopen in May, a month late.",
    );
    expect(cardText(card(8), "mark.quote")).toBe(QUOTES.markdown);
    expect(cardText(card(9), ".card-passage")).toBe(
      "Spring tides come twice a month, at new and full moon.",
    );

    // A sheet: the cited cell under its column's heading, beside its row's label.
    const table = card(4)?.querySelector("table.card-cells");
    expect([...(table?.querySelectorAll("thead th") ?? [])].map((th) => th.textContent)).toEqual([
      "Q3 2026",
    ]);
    expect(table?.querySelector("tbody th")?.textContent).toBe("Online");
    expect(table?.querySelector("td.quote")?.textContent).toBe("1310");

    // A Transcript: the line, when it was said and who said it; never audio.
    const line = card(6)?.querySelector(".card-lines li");
    expect(cardText(line ?? null, ".card-time")).toBe("1:05");
    expect(cardText(line ?? null, ".card-speaker")).toBe("Sam");
    expect(cardText(line ?? null, "mark.quote")).toBe(QUOTES.transcript);
    expect(document.querySelectorAll("audio, video, source")).toHaveLength(0);
  });

  test("only what is cited goes in the file, never the rest of a Document", async () => {
    const { core, mind } = await setUp();

    const { html } = await sharedPage(core, mind.id);

    for (const words of UNCITED) expect(html).not.toContain(words);
  });

  test("markers open their cards, with names a screen reader says; the notes repeat each Citation", async () => {
    const { core, mind } = await setUp();

    const { document } = await sharedPage(core, mind.id);

    const markers = [...document.querySelectorAll("main a.cite")];
    expect(markers).toHaveLength(11);
    expect(markers[0]?.getAttribute("aria-label")).toBe("Citation 1: Northwind results, page 2");
    markers.forEach((marker, index) => {
      const number = index + 1;
      expect(marker.textContent).toBe(String(number));
      expect(marker.getAttribute("href")).toBe(`#note-${number}`);
      expect(marker.getAttribute("data-card")).toBe(String(number));
      expect(document.getElementById(`card-${number}`)?.getAttribute("aria-label")).toBe(
        marker.getAttribute("aria-label"),
      );
      expect(document.getElementById(`card-${number}`)?.getAttribute("role")).toBe("dialog");
    });
    expect(document.querySelector("main")?.textContent).toContain("Leverage was 3.1×1.");

    const note = document.getElementById("note-1")?.textContent?.replace(/↩︎/, "");
    expect(note).toBe(`1 · Northwind results, p. 2 · “${QUOTES.pdf}”`);
    expect(document.getElementById("note-10")?.textContent).toContain(
      "“Gross margin rose to 44%” · Quote not found in § Results",
    );
    expect(document.querySelector(".notes")?.textContent).not.toContain("[unverified]");

    expect(document.querySelector(".shared-from")?.textContent).toBe(
      "Shared from IncarnaMind · 13 Oct 2026",
    );
    // The page has no title line (#908): the name names the file and the browser's tab.
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector("title")?.textContent).toBe("Credit memo Northwind Retail");
    expect(document.querySelector(".shared-about")?.textContent).toBe(
      "Each Citation’s card shows its quote, where it is, and what the check found.",
    );
    expect(document.querySelector(".shared-foot")?.textContent).toBe(
      "Made with IncarnaMind · Checked on 13 Oct 2026: 9 of 11 quotes found on their pages. Each other Citation’s card says why.",
    );
  });

  test("the notes list is compact: each line numbered, in the page's small sans, and linked back to its Citation", () => {
    const en = pageOf([card("found"), card("found")]);
    const styles = en.document.querySelector("style")?.textContent ?? "";
    const ruleOf = (selector: string) =>
      [...styles.matchAll(new RegExp(`${selector}\\{([^}]*)\\}`, "g"))]
        .map((match) => match[1] ?? "")
        .find((rule) => rule.includes("font-size:12px")) ?? "";
    const rule = ruleOf("\\.notes");
    expect(rule).toContain("font-family:var(--sans)");
    expect(rule).toContain("font-size:12px");
    expect(rule).toContain("color:var(--ink-meta)");
    const heading = ruleOf("\\.notes h2");
    expect(heading).toContain("font-size:12px");
    expect(heading).toContain("color:var(--ink-meta)");
    expect(en.document.querySelector(".notes")?.getAttribute("class")).toBe("notes notes-compact");
    expect(en.document.querySelector(".notes h2")?.textContent).toBe("Notes");
    const lines = [...en.document.querySelectorAll(".notes li")];
    expect(lines.map((line) => line.textContent?.replace(/↩︎/, ""))).toEqual([
      "1 · Tides · “Spring tides come twice a month”",
      "2 · Tides · “Spring tides come twice a month”",
    ]);
    lines.forEach((line, index) => {
      const number = index + 1;
      expect(line.getAttribute("id")).toBe(`note-${number}`);
      expect(line.querySelector("a.backref")?.getAttribute("href")).toBe(`#ref-${number}`);
      const marker = en.document.querySelector(`main a.cite[href="#note-${number}"]`);
      expect(marker?.getAttribute("href")).toBe(`#note-${number}`);
      expect(marker?.getAttribute("data-card")).toBe(String(number));
    });

    const zh = pageOf([card("found")], { language: "zh-CN" });
    expect(zh.document.querySelector(".notes h2")?.textContent).toBe("注释");
    expect(zh.document.querySelector(".notes li")?.textContent).toContain("1 · Tides · “");
  });

  test("a quote not found, a contradicted claim and a deleted Document each say so", async () => {
    const { core, mind, tides } = await setUp();
    await core.deleteDocument(tides.id);

    const { document } = await sharedPage(core, mind.id);

    const notFound = document.getElementById("card-10");
    expect(notFound?.classList.contains("check-not-found")).toBe(true);
    expect(cardText(notFound, ".card-heading")).toBe("Quote not found in § Results");
    expect(cardText(notFound, ".card-passage")).toBe("“Gross margin rose to 44%”");
    expect(notFound?.querySelector("mark.quote")).toBeNull();
    expect(document.querySelector('a.cite[data-card="10"]')?.getAttribute("data-check")).toBe(
      "not-found",
    );

    const contradicted = document.getElementById("card-11");
    expect(cardText(contradicted, ".card-heading")).toBe("Contradicted");
    expect(cardText(contradicted, ".card-source")).toBe(
      "Northwind results, p. 2 · as of 13 Oct 2026",
    );
    expect(cardText(contradicted, ".card-verdict")).toBe("The results say 3.1 times, p. 2");

    const missing = document.getElementById("card-9");
    expect(cardText(missing, ".card-heading")).toBe("Can’t check");
    expect(cardText(missing, ".card-source")).toBe("Tides, line 1");
    expect(missing?.textContent).toContain("The source wasn’t available when this was shared");
    expect(missing?.querySelector("mark.quote, img")).toBeNull();
  });

  test("one file that loads nothing: its policy refuses every request and allows only its own script", async () => {
    const { core, mind } = await setUp();

    const { html, document } = await sharedPage(core, mind.id);

    const policy =
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "";
    expect(policy).toContain("default-src 'none'");
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("src")).toBeNull();
    const hash = createHash("sha256")
      .update(scripts[0]?.textContent ?? "")
      .digest("base64");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(document.querySelectorAll("link, iframe, object, embed, audio, video")).toHaveLength(0);
    expect(html).not.toMatch(/url\(|@import|\son[a-z]+="/);
    // Only the web page's own address, which a reader clicks to leave the page.
    const addresses = (html.match(/https?:\/\/[^\s"'<)]+/g) ?? []).filter(
      (address) => !address.startsWith("http://www.w3.org/"),
    );
    expect(new Set(addresses)).toEqual(new Set([ADDRESS]));
  });

  test("it passes an HTML validator", async () => {
    const { core, mind } = await setUp();

    const { html } = await sharedPage(core, mind.id, { checkedLine: true });

    const report = await new HtmlValidate({
      extends: ["html-validate:recommended"],
    }).validateString(html);
    expect(
      report.results.flatMap((result) =>
        result.messages.map((message) => `${message.ruleId}: ${message.message}`),
      ),
    ).toEqual([]);
  });

  test("in Chinese, the page's own words are Chinese", async () => {
    const { core, mind } = await setUp();
    await core.updateSettings({ user: { language: "zh-CN" } });

    const { document } = await sharedPage(core, mind.id, { checkedLine: true });

    expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");
    expect(document.querySelector(".shared-from")?.textContent).toBe(
      "分享自 IncarnaMind · 2026年10月13日",
    );
    expect(document.querySelector(".shared-about")?.textContent).toBe(
      "每处引用的卡片都会显示引文、所在位置和核对结果。",
    );
    expect(document.querySelector(".shared-foot p")?.textContent).toBe(
      "由 IncarnaMind 制作 · 2026年10月13日对照原页面核对：11 处引文中找到 9 处，其余引用的卡片里写明了原因。",
    );
    expect(document.querySelector(".shared-foot a")?.textContent).toBe("引用已由 IncarnaMind 核对");
    expect(document.querySelector("a.cite")?.getAttribute("aria-label")).toBe(
      "引用 1：Northwind results，第 2 页",
    );
    expect(cardText(document.getElementById("card-1"), ".card-heading")).toBe(
      "已在第 2 页找到引文",
    );
    expect(cardText(document.getElementById("card-1"), ".card-source")).toBe(
      "Northwind results · 截至 2026年10月13日",
    );
    expect(cardText(document.getElementById("card-1"), ".card-source .date")).toBe(
      "2026年10月13日",
    );
    expect(document.querySelector(".shared-from .date")?.textContent).toBe("2026年10月13日");
    expect(document.querySelector(".shared-foot .date")?.textContent).toBe("2026年10月13日");
    expect(document.querySelector(".card-close")?.getAttribute("aria-label")).toBe("关闭");
    expect(document.getElementById("card-4")?.textContent).toContain(
      "文件中只包含文档的这一部分。",
    );
  });

  test("the quiet line at the foot is off until asked for; with cards off, the file is the HTML export", async () => {
    const { core, mind } = await setUp();

    const plain = await sharedPage(core, mind.id);
    const credited = await sharedPage(core, mind.id, { checkedLine: true });
    const withoutCards = await sharedPage(core, mind.id, { citationCards: false });
    const html = decode((await core.exportMind(mind.id, { format: "html" })).data);

    expect(plain.html).not.toContain("Citations checked with IncarnaMind");
    const line = credited.document.querySelector(".shared-foot a");
    expect(line?.textContent).toBe("Citations checked with IncarnaMind");
    expect(line?.getAttribute("href")).toMatch(/^https:\/\/github\.com\/IncarnaMind\/IncarnaMind/);
    expect(credited.document.querySelectorAll(".shared-foot img, .shared-foot svg")).toHaveLength(
      0,
    );
    expect(withoutCards.html).toBe(html);
  });

  test("with cards off, a Mind in an author-date style keeps the space before each Citation", async () => {
    const { core, dataDir, tides } = await setUp();
    const moon = await core.createMind({ title: "Moon" });
    const client = await connectToMind(core, moon.id);
    writeMind(client, [
      paragraph(text("Tides follow the new moon "), cite(dataDir, tides, QUOTES.text), text(".")),
    ]);
    await client.settled();
    await core.setMindCitationStyle(moon.id, "apa");

    const styled = await sharedPage(core, moon.id, { citationCards: false });

    expect(styled.html).toBe(decode((await core.exportMind(moon.id, { format: "html" })).data));
    expect(styled.document.querySelector("main p")?.textContent).toMatch(/new moon \(/);
  });

  test("a Mind in a citation style is still numbered, one marker for each Citation", async () => {
    const { core, mind } = await setUp();
    await core.setMindCitationStyle(mind.id, "apa");

    const { document } = await sharedPage(core, mind.id);

    expect(document.querySelectorAll("main a.cite")).toHaveLength(11);
    expect(document.querySelectorAll(".notes li")).toHaveLength(11);
  });

  test("it is saved under a free name and fingerprinted like the other exports (#80)", async () => {
    const { core, mind, sources, dataDir } = await setUp();
    await core.setOutputLocation(sources);

    const saved: SavedMindExport = await core.saveMindExport(mind.id, { format: "share-page" });

    if (saved.status !== "saved") throw new Error("Not saved.");
    expect(saved.file.name).toMatch(/\.html$/);
    expect(queryDatabase(dataDir, "SELECT content_hash, kind FROM own_files")).toContainEqual({
      content_hash: createHash("sha256").update(readFileSync(saved.file.path)).digest("hex"),
      kind: "export",
    });
  });
});

const card = (check: CitationCheck, more: Partial<CitationCard> = {}): CitationCard => ({
  check,
  heading: "Quote found on p. 2",
  source: "Tides",
  dated: true,
  verdict: null,
  spoken: "Tides, page 2",
  quote: "Spring tides come twice a month",
  changedAfterCited: false,
  content: { kind: "quote", text: "Spring tides come twice a month", from: null },
  ...more,
});

/** The page for these cards, each behind a marker of its own. */
function pageOf(
  cards: readonly CitationCard[],
  {
    language = "en",
    footnote,
    font = null,
  }: { language?: Language; footnote?: Partial<Footnote>; font?: string | null } = {},
) {
  const footnotes: Footnote[] = cards.map((each) => ({
    source: each.source,
    unverified: each.check !== "found",
    ...footnote,
  }));
  const html = renderSharePage({
    blocks: [
      {
        kind: "paragraph",
        content: footnotes.map((each) => ({
          kind: "citation" as const,
          footnote: each,
          work: { documentId: null, documentName: null, location: null },
        })),
      },
    ],
    labels: exportLabels(language),
    language,
    name: "Tides",
    at: "2026-10-13T12:00:00.000Z",
    cards: new Map(footnotes.map((each, index) => [each, cards[index] ?? card("found")])),
    pictures: [],
    checkedLine: false,
    font,
    lineSpacing: null,
  });
  return { html, document: parseHTML(html).document };
}

describe("a web page to share in the Mind's font", () => {
  test("its policy allows the stylesheet it writes, the font's rule included", () => {
    const { html, document } = pageOf([card("found")], { font: "JetBrains Mono" });
    const styles = document.querySelector("style")?.textContent ?? "";
    expect(styles).toContain('font-family:"JetBrains Mono"');
    const hash = createHash("sha256").update(styles).digest("base64");
    expect(html).toContain(`style-src 'sha256-${hash}'`);
  });
});

const foot = (cards: readonly CitationCard[], language: Language = "en") =>
  pageOf(cards, { language }).document.querySelector(".shared-foot p")?.textContent;

describe("what a web page to share says of its checks", () => {
  test("it says every quote was found only when every card says so; otherwise it counts them", () => {
    expect(foot([card("found"), card("found")])).toBe(
      "Made with IncarnaMind · Every quote was found on its page, checked on 13 Oct 2026.",
    );
    expect(foot([card("found"), card("cant-check"), card("checking")])).toBe(
      "Made with IncarnaMind · Checked on 13 Oct 2026: 1 of 3 quotes found on their pages. Each other Citation’s card says why.",
    );
    expect(foot([card("not-found")])).toBe(
      "Made with IncarnaMind · Checked on 13 Oct 2026: the quote wasn’t found on its page. Its card says why.",
    );
    expect(foot([card("cant-check"), card("contradicted")])).toBe(
      "Made with IncarnaMind · Checked on 13 Oct 2026: none of the 2 quotes was found on its page. Each Citation’s card says why.",
    );
  });

  test("in Chinese too", () => {
    expect(foot([card("found")], "zh-CN")).toBe(
      "由 IncarnaMind 制作 · 2026年10月13日对照原页面核对，所有引文都已找到。",
    );
    expect(foot([card("found"), card("unsupported")], "zh-CN")).toBe(
      "由 IncarnaMind 制作 · 2026年10月13日对照原页面核对：2 处引文中找到 1 处，其余引用的卡片里写明了原因。",
    );
    expect(foot([card("not-found")], "zh-CN")).toBe(
      "由 IncarnaMind 制作 · 2026年10月13日对照原页面核对：未找到这处引文，原因见它的卡片。",
    );
    expect(foot([card("checking"), card("not-found")], "zh-CN")).toBe(
      "由 IncarnaMind 制作 · 2026年10月13日对照原页面核对：2 处引文都未找到，原因见各处引用的卡片。",
    );
  });

  test("a Document's name, a quote, an address and a check written to break the page stay words", () => {
    const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)> "q" 'a'`;
    // As untrusted as a Mind synced from elsewhere: a check this version doesn't know.
    const unknownCheck: CitationCheck = JSON.parse('"verified-v2\\" onclick=\\"alert(1)"');
    const shown = citationCard(
      {
        documentId: "page",
        documentName: hostile,
        contentHash: "first",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "section", heading: hostile },
        quote: hostile,
        check: unknownCheck,
        verdict: hostile,
      },
      {
        documents: [
          {
            id: "page",
            contentHash: "first",
            name: hostile,
            web: {
              address: "javascript:alert(1)",
              origin: "search",
              siteName: hostile,
              author: null,
              published: null,
              fetchedAt: "2026-10-13T12:00:00.000Z",
              versions: [],
              picturesLeftOut: 0,
              look: null,
            },
          },
        ],
        kept: [],
        units: () => [
          { page: 1, kind: "section", text: `Before it. ${hostile} After it.`, label: null },
        ],
        t: (key, params) => translate("en", key, params),
      },
    );
    for (const address of ["javascript:alert(2)", "mailto:someone@example.com"]) {
      const { html, document } = pageOf([shown], {
        footnote: { source: `${hostile} ${address}`, link: address },
      });

      expect(document.querySelectorAll("script")).toHaveLength(1);
      expect(document.querySelectorAll("img")).toHaveLength(0);
      const handlers = [...document.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes].filter((attribute) => attribute.name.startsWith("on")),
      );
      expect(handlers).toEqual([]);
      expect(html).not.toMatch(/href="(javascript|mailto):/i);
      const card = document.getElementById("card-1");
      expect(card?.querySelector(".card-heading")?.textContent).toBe("Can’t check");
      expect(card?.querySelector(".card-source")?.textContent).toBe(`${hostile}, § ${hostile}`);
      expect(card?.querySelector("mark.quote")?.textContent).toBe(hostile);
      expect(card?.querySelector(".card-address")?.textContent).toBe("javascript:alert(1)");
      expect(card?.querySelector(".card-address a")).toBeNull();
      expect(card?.classList.contains("check-cant-check")).toBe(true);
      expect(document.querySelector("a.cite")?.getAttribute("data-check")).toBe("cant-check");
      expect(document.getElementById("note-1")?.textContent).toContain(" · Can’t check");
    }
  });

  test("a Document unlinked with its folder shows the quote its kept text has; one changed since says so", () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    const attributes: Partial<CitationAttributes> = {
      documentId: "tides",
      documentName: "Tides",
      contentHash: "first",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "lines", from: 1, to: 1 },
      quote: "Spring tides come twice a month",
      check: "found",
    };

    const kept = citationCard(attributes, {
      documents: [],
      kept: [{ documentId: "tides", contentHash: "first", units: [1] }],
      units: () => [],
      t,
    });
    const changed = citationCard(attributes, {
      documents: [{ id: "tides", contentHash: "second", name: "Tides" }],
      kept: [],
      units: () => [],
      t,
    });

    expect(kept.check).toBe("found");
    expect(kept.content).toEqual({
      kind: "quote",
      text: "Spring tides come twice a month",
      from: null,
    });
    expect(changed.changedAfterCited).toBe(true);
    expect(pageOf([changed]).document.querySelector(".card-verdict")?.textContent).toBe(
      "The Document changed after this was cited.",
    );
  });
});
