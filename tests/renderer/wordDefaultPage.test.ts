/**
 * The pages the viewer draws of a Word Document that leaves its page size or margins unset (#3522):
 * Word's default paper and margins (US Letter, one inch), and a page for each page the file breaks;
 * and a file that sets its own is drawn as docx-preview draws it. The pages are drawn by the
 * viewer's own `renderWord` into a small DOM that lays nothing out, so a page's size is what its
 * style says; how they look in the window is the smoke spec `e2e/officeFormats.spec.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAsync } from "docx-preview";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderWord } from "../../src/renderer/src/viewer/docxDraw";
import { paragraph, wordFile } from "../helpers/word";
import { mountWordDom } from "../helpers/wordDom";

const OPTIONS = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: false,
  renderHeaders: true,
  renderFooters: true,
};

const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
const LETTER = { width: "612.00pt", minHeight: "792.00pt" };
const INCH = "72.00pt";

let dom: ReturnType<typeof mountWordDom>;

beforeEach(() => {
  dom = mountWordDom();
});

afterEach(() => {
  dom.unmount();
});

const draw = async (bytes: Uint8Array) => {
  await renderWord(bytes, dom.body, dom.styles, OPTIONS);
  return [...dom.body.querySelectorAll<HTMLElement>("section.docx")];
};

/** A sheet's width, minimum height and padding (top, right, bottom, left), as drawn. */
const sheet = (page: HTMLElement) => ({
  width: page.style.width,
  minHeight: page.style.minHeight,
  padding: [
    page.style.paddingTop,
    page.style.paddingRight,
    page.style.paddingBottom,
    page.style.paddingLeft,
  ],
});

const DEFAULT = { ...LETTER, padding: [INCH, INCH, INCH, INCH] };

describe("a Word Document with no page setup", () => {
  test("is one sheet on Letter paper with one-inch margins, not as wide as the window", async () => {
    const pages = await draw(wordFile({ body: paragraph("A clause."), sectPr: null }));
    expect(pages.map(sheet)).toEqual([{ ...DEFAULT, width: LETTER.width }]);
    expect(pages[0]?.textContent).toBe("A clause.");
  });

  test("breaks into a sheet for each page the file breaks, each on the default paper", async () => {
    const pages = await draw(
      wordFile({
        body: [
          paragraph("One."),
          PAGE_BREAK,
          paragraph("Two."),
          PAGE_BREAK,
          paragraph("Three."),
        ].join(""),
        sectPr: null,
      }),
    );
    expect(pages.map((page) => page.textContent?.trim())).toEqual(["One.", "Two.", "Three."]);
    expect(pages.map(sheet)).toEqual([DEFAULT, DEFAULT, DEFAULT]);
  });

  test("is drawn so, too, when its section properties name neither paper nor margins", async () => {
    const pages = await draw(wordFile({ body: paragraph("A clause."), sectPr: "<w:titlePg/>" }));
    expect(pages.map(sheet)).toEqual([DEFAULT]);
  });

  test("keeps the paper it sets and takes the default margins", async () => {
    const pages = await draw(
      wordFile({
        body: paragraph("A clause."),
        sectPr: '<w:pgSz w:w="11906" w:h="16838"/>',
      }),
    );
    expect(pages.map(sheet)).toEqual([
      { width: "595.30pt", minHeight: "841.90pt", padding: [INCH, INCH, INCH, INCH] },
    ]);
  });

  test("keeps the margins it sets and takes the default paper", async () => {
    const pages = await draw(
      wordFile({
        body: paragraph("A clause."),
        sectPr: '<w:pgMar w:top="1134" w:right="1021" w:bottom="1247" w:left="1304"/>',
      }),
    );
    expect(pages.map(sheet)).toEqual([
      { ...LETTER, padding: ["56.70pt", "51.05pt", "62.35pt", "65.20pt"] },
    ]);
  });

  test("takes the default paper only for the sections that set none", async () => {
    const a4 = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
    const pages = await draw(
      wordFile({
        body: [paragraph("First.", { sectPr: a4 }), PAGE_BREAK, paragraph("Second.")].join(""),
        sectPr: null,
      }),
    );
    expect(pages.map((page) => [page.textContent?.trim(), sheet(page).width])).toEqual([
      ["First.", "595.30pt"],
      ["Second.", "612.00pt"],
    ]);
  });

  test("puts its header half an inch from the page's top, as Word does", async () => {
    const pages = await draw(
      wordFile({
        body: paragraph("A clause."),
        sectPr: '<w:headerReference w:type="default" r:id="rIdH1"/>',
        headers: { rIdH1: paragraph("Header text") },
      }),
    );
    expect(pages.map(sheet)).toEqual([DEFAULT]);
    expect(pages[0]?.querySelector("header")?.getAttribute("style")).toContain(
      "calc(36.00pt - 72.00pt)",
    );
  });
});

describe("the example Word files, which set no page", () => {
  const folder = fileURLToPath(new URL("../../resources/examples", import.meta.url));
  const files = readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".docx"),
  );

  test("there are five of them", () => {
    expect(files).toHaveLength(5);
  });

  test.each(files)("%s is drawn as a sheet on Letter paper with one-inch margins", async (name) => {
    const pages = await draw(readFileSync(join(folder, name)));
    expect(pages.map(sheet)).toEqual([DEFAULT]);
    expect(pages[0]?.textContent?.trim()).not.toBe("");
  });
});

describe("a Word Document with its own page setup", () => {
  const A4_LANDSCAPE = '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>';
  const MARGINS =
    '<w:pgMar w:top="1134" w:right="1021" w:bottom="1247" w:left="1304" w:header="567" w:footer="624" w:gutter="0"/>';
  const files = {
    "one section": wordFile({
      body: paragraph("A clause."),
      sectPr: `<w:pgSz w:w="11906" w:h="16838"/>${MARGINS}`,
    }),
    "sections of two sizes, with a header and footer": wordFile({
      body: [
        paragraph("First.", {
          sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/>${A4_LANDSCAPE}${MARGINS}</w:sectPr>`,
        }),
        PAGE_BREAK,
        paragraph("Second."),
      ].join(""),
      headers: { rIdH1: paragraph("Header text") },
      footers: { rIdF1: paragraph("Footer text") },
      sectPr: `<w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/>${MARGINS}`,
    }),
  };

  test.each(Object.entries(files))(
    "%s is drawn exactly as docx-preview draws it",
    async (_name, bytes) => {
      await renderAsync(bytes, dom.body, dom.styles, OPTIONS);
      const before = { body: dom.body.innerHTML, styles: dom.styles.innerHTML };
      expect(before.body).toContain("<section");
      await renderWord(bytes, dom.body, dom.styles, OPTIONS);
      expect({ body: dom.body.innerHTML, styles: dom.styles.innerHTML }).toEqual(before);
    },
  );

  test("keeps the paper and margins it sets", async () => {
    const pages = await draw(files["one section"]);
    expect(pages.map(sheet)).toEqual([
      {
        width: "595.30pt",
        minHeight: "841.90pt",
        padding: ["56.70pt", "51.05pt", "62.35pt", "65.20pt"],
      },
    ]);
  });
});

describe("sections that set the page beside sections that leave it unset", () => {
  const LETTER_PAGE = '<w:pgSz w:w="12240" w:h="15840"/>';
  const ONE_INCH =
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';
  const OWN_MARGINS =
    '<w:pgMar w:top="1134" w:right="1021" w:bottom="1247" w:left="1304" w:header="567" w:footer="624" w:gutter="0"/>';
  const UNSET = '<w:sectPr><w:cols w:space="720"/></w:sectPr>';

  /** A Letter section with a header, a section with no paper, and a Letter section with its own header and margins. */
  const threeSections = wordFile({
    body: [
      paragraph("One.", {
        sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/>${LETTER_PAGE}${ONE_INCH}</w:sectPr>`,
      }),
      paragraph("Two.", { sectPr: UNSET }),
      paragraph("Three."),
    ].join(""),
    headers: { rIdH1: paragraph("Header one"), rIdH2: paragraph("Header three") },
    sectPr: `<w:headerReference w:type="default" r:id="rIdH2"/>${LETTER_PAGE}${OWN_MARGINS}`,
  });

  test("a section that sets Letter still starts its own page after one that sets nothing, with its own header and margins", async () => {
    await renderAsync(threeSections, dom.body, dom.styles, OPTIONS);
    const before = { body: dom.body.innerHTML, styles: dom.styles.innerHTML };
    const pages = await draw(threeSections);
    expect(pages.map((page) => page.querySelector("header")?.textContent)).toEqual([
      "Header one",
      "Header three",
    ]);
    expect(pages.map((page) => sheet(page).padding)).toEqual([
      [INCH, INCH, INCH, INCH],
      ["56.70pt", "51.05pt", "62.35pt", "65.20pt"],
    ]);
    expect({ body: dom.body.innerHTML, styles: dom.styles.innerHTML }).toEqual(before);
  });

  test("two sections in a row that set nothing stay on one page, as before", async () => {
    const file = wordFile({
      body: [paragraph("One.", { sectPr: UNSET }), paragraph("Two.")].join(""),
      sectPr: null,
    });
    await renderAsync(file, dom.body, dom.styles, OPTIONS);
    const pagesBefore = dom.body.querySelectorAll("section.docx").length;
    const pages = await draw(file);
    expect(pagesBefore).toBe(1);
    expect(pages.map(sheet)).toEqual([DEFAULT]);
    expect(pages[0]?.textContent).toBe("One.Two.");
  });
});
