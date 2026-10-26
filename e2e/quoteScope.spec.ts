import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { part, unzip } from "../tests/helpers/docx";
import { docxOf, xlsxOf } from "../tests/helpers/office";
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

for (const language of ["en", "zh-CN"] as const) {
  for (const format of ["md", "docx", "pptx", "xlsx", "web", "vtt"] as const) {
    test(`${format}, ${language}: a placed quote stays in its Unit; an unplaced quote searches the file`, async () => {
      const data = await createDataFolder();
      const sources = await createDataFolder();
      const inside =
        language === "en" ? "The stored place has no quoted decision." : "指定位置没有这条决定。";
      const quote =
        language === "en" ? "The final decision is to retain the harbour." : "最终决定是保留港口。";
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
          const path = join(sources, `Scope.${format}`);
          let content =
            format === "md"
              ? `# Stored\n\n${inside}\n\n# Elsewhere\n\n${quote}\n`
              : format === "docx"
                ? docxOf([
                    { text: "Stored", heading: 1 },
                    { text: inside },
                    { text: "Elsewhere", heading: 1 },
                    { text: quote },
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
                    : `WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${inside.repeat(180)}\n\n00:00:20.000 --> 00:00:30.000\n${quote}\n`;
          if (format === "docx" && typeof content !== "string") {
            const template = unzip(
              await readFile(
                join(__dirname, "../tests/fixtures/formats/Coastal Flood Risk Review.docx"),
              ),
            );
            template.set(
              "word/document.xml",
              Buffer.from(part(unzip(content), "word/document.xml")),
            );
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
        await openAt();
        await expect(highlights.first()).toBeVisible();
        await openAt(9999);
        await expect(highlights).toHaveCount(0);
      } finally {
        await app.close();
        await removeDataFolder(data);
        await removeDataFolder(sources);
      }
    });
  }
}
