import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CitationLocation } from "../src/core/api";
import { part, unzip } from "../tests/helpers/docx";
import { docxOf, xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import { para, pptxOf, sp, xfrm } from "../tests/helpers/pptx";
import { buildZip } from "../tests/helpers/zip";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  openDocumentAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const SECTION = {
  location: { kind: "section", heading: "Elsewhere" } as CitationLocation,
  words: { en: "§ Elsewhere", "zh-CN": "§ Elsewhere" },
};

/**
 * Where a Citation points in each format once the Document no longer has that Unit (a Unit
 * numbered 9999), and how its chip words it in each language.
 */
const GONE_PLACE: Record<
  string,
  { location: CitationLocation; words: Record<"en" | "zh-CN", string> }
> = {
  pdf: {
    location: { kind: "page", from: 9999, to: 9999 },
    words: { en: "p. 9999", "zh-CN": "第 9999 页" },
  },
  md: SECTION,
  docx: SECTION,
  "docx-notes": SECTION,
  pptx: {
    location: { kind: "slide", from: 9999, to: 9999 },
    words: { en: "slide 9999", "zh-CN": "第 9999 张幻灯片" },
  },
  xlsx: {
    location: { kind: "rows", sheet: "Elsewhere", from: 1, to: 1 },
    words: { en: "Elsewhere, row 1", "zh-CN": "Elsewhere，第 1 行" },
  },
  web: SECTION,
  vtt: {
    location: { kind: "time", from: 20_000, to: 30_000 },
    words: { en: "0:20", "zh-CN": "0:20" },
  },
};
const GONE_LINE = {
  en: (place: string) => `The cited place (${place}) is no longer in this Document.`,
  "zh-CN": (place: string) => `引用的位置（${place}）已不在此文档中。`,
};

for (const language of ["en", "zh-CN"] as const) {
  for (const format of ["pdf", "md", "docx", "docx-notes", "pptx", "xlsx", "web", "vtt"] as const) {
    test(`${format}, ${language}: a placed quote stays in its Unit; an unplaced quote searches the file; a gone place is said`, async () => {
      const data = await createDataFolder();
      const sources = await createDataFolder();
      // A PDF's text is drawn in Helvetica, which has no Chinese: its words are English in both.
      const words = language === "en" || format === "pdf" ? "en" : "zh-CN";
      const inside =
        words === "en" ? "The stored place has no quoted decision." : "指定位置没有这条决定。";
      const quote =
        words === "en" ? "The final decision is to retain the harbour." : "最终决定是保留港口。";
      const endnote =
        language === "en" ? "The endnote records the revised budget." : "尾注记录了修订后的预算。";
      const { app, window } = await launchApp(data);
      try {
        await setWindowSize(app, window, 1200, 850);
        await dismissChatSetup(window);
        await setLanguage(window, language);
        const core = await coreOf(window);
        if (format === "web") {
          await core.evaluate(
            (bridge, { inside, quote }) =>
              bridge.saveWebPage({
                address: "https://scope.example/decision",
                html: `<html><head><title>Scope</title></head><body><article><h1>Stored</h1><p>${inside.repeat(60)}</p><h2>Elsewhere</h2><p>${quote}</p></article></body></html>`,
              }),
            { inside, quote },
          );
          await expectReadyDocuments(window, 1);
        } else {
          const path = join(sources, `Scope.${format === "docx-notes" ? "docx" : format}`);
          let content =
            format === "md"
              ? `# Stored\n\n${inside}\n\n# Elsewhere\n\n${quote}\n`
              : format === "docx" || format === "docx-notes"
                ? docxOf([
                    { text: "Stored", heading: 1 },
                    { text: inside },
                    ...(format === "docx"
                      ? [{ text: "Elsewhere", heading: 1 }, { text: quote }]
                      : []),
                  ])
                : format === "pptx"
                  ? pptxOf({
                      slides: [inside, quote].map((text) => ({
                        shapes: sp({
                          spPr: xfrm(914400, 914400, 7315200, 1828800),
                          body: `<a:bodyPr/><a:lstStyle/>${para(text)}`,
                        }),
                      })),
                    })
                  : format === "xlsx"
                    ? xlsxOf([
                        { name: "Stored", rows: [[inside]] },
                        { name: "Elsewhere", rows: [[quote]] },
                      ])
                    : format === "vtt"
                      ? `WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${inside.repeat(180)}\n\n00:00:20.000 --> 00:00:30.000\n${quote}\n`
                      : buildPdf([{ lines: [inside] }, { lines: [quote] }]);
          if ((format === "docx" || format === "docx-notes") && typeof content !== "string") {
            const template = unzip(
              await readFile(
                join(__dirname, "../tests/fixtures/formats/Coastal Flood Risk Review.docx"),
              ),
            );
            template.set(
              "word/document.xml",
              Buffer.from(part(unzip(content), "word/document.xml")),
            );
            if (format === "docx-notes") {
              template.set(
                "word/document.xml",
                Buffer.from(
                  part(template, "word/document.xml").replace(
                    "</w:p>",
                    '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>',
                  ),
                ),
              );
              for (const [kind, text] of [
                ["footnote", quote],
                ["endnote", endnote],
              ] as const) {
                template.set(
                  `word/${kind}s.xml`,
                  Buffer.from(
                    `<w:${kind}s xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:${kind} w:id="1"><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p></w:${kind}></w:${kind}s>`,
                  ),
                );
                template.set(
                  "word/_rels/document.xml.rels",
                  Buffer.from(
                    part(template, "word/_rels/document.xml.rels").replace(
                      "</Relationships>",
                      `<Relationship Id="scope-${kind}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}s" Target="${kind}s.xml"/></Relationships>`,
                    ),
                  ),
                );
                template.set(
                  "[Content_Types].xml",
                  Buffer.from(
                    part(template, "[Content_Types].xml").replace(
                      "</Types>",
                      `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/></Types>`,
                    ),
                  ),
                );
              }
            }
            content = buildZip([...template].map(([name, data]) => ({ name, data })));
          }
          await writeFile(path, content);
          await addDocuments(window, [path]);
        }
        const [document] = await core.evaluate((bridge) => bridge.listDocuments());
        if (!document) throw new Error("The source Document is missing.");
        const text = await core.evaluate((bridge, id) => bridge.readDocumentText(id), document.id);
        const first = text.pages.find((unit) => unit.text.includes(inside));
        const last = text.pages.find((unit) => unit.text.includes(quote));
        if (!first || !last) throw new Error("The two source Units are missing.");
        expect(first.page).not.toBe(last.page);
        const viewer = window.getByTestId("viewer");
        const highlights = viewer.locator("[data-quote-highlight]");
        const openAt = (page?: number) =>
          openDocumentAt(window, {
            documentId: document.id,
            quote,
            ...(page === undefined ? {} : { pageFrom: page, pageTo: page }),
          });
        await openAt(last.page);
        await expect(highlights.first()).toBeVisible();
        await openAt(first.page);
        await expect(viewer.getByText(inside, { exact: false }).first()).toBeInViewport();
        await expect(highlights).toHaveCount(0);
        if (format === "xlsx") {
          await expect(viewer.getByRole("tab", { name: "Stored", exact: true })).toHaveAttribute(
            "aria-selected",
            "true",
          );
        }
        // A PDF opened at a quote with no place looks on its first page only.
        if (format !== "pdf") {
          await openAt();
          await expect(highlights.first()).toBeVisible();
        }
        await openAt(9999);
        await expect(highlights).toHaveCount(0);

        // Opened by a Citation, the place that is gone is said at the top, in the chip's words;
        // a place the Document has is washed or not by its quote, and says nothing.
        const place = GONE_PLACE[format];
        if (!place) throw new Error(`No gone place is set for ${format}.`);
        const said = viewer.getByTestId("viewer-citation-changed");
        const openCitedAt = (page: number) =>
          openDocumentAt(window, {
            documentId: document.id,
            quote,
            pageFrom: page,
            pageTo: page,
            citation: {
              check: "found",
              number: 1,
              pageFrom: page,
              pageTo: page,
              location: place.location,
            },
          });
        await openCitedAt(9999);
        await expect(highlights).toHaveCount(0);
        await expect(said).toHaveText(GONE_LINE[language](place.words[language]));
        await openCitedAt(last.page);
        await expect(highlights.first()).toBeVisible();
        await expect(said).toHaveCount(0);
        await openCitedAt(first.page);
        await expect(highlights).toHaveCount(0);
        await expect(said).toHaveCount(0);
        if (format === "docx-notes") {
          await openDocumentAt(window, {
            documentId: document.id,
            quote: inside,
            pageFrom: last.page,
            pageTo: last.page,
          });
          await expect(viewer.getByText(quote, { exact: false }).first()).toBeInViewport();
          await expect(highlights).toHaveCount(0);
          await openDocumentAt(window, {
            documentId: document.id,
            quote: endnote,
            pageFrom: last.page,
            pageTo: last.page,
          });
          await expect(highlights.first()).toBeVisible();
          await openDocumentAt(window, {
            documentId: document.id,
            quote: `${inside}\n${quote}`,
            pageFrom: first.page,
            pageTo: last.page,
          });
          await expect(highlights.first()).toBeVisible();
        }
      } finally {
        await app.close();
        await removeDataFolder(data);
        await removeDataFolder(sources);
      }
    });
  }
}
