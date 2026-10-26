import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf, pdfAppearance } from "../tests/helpers/pdf";
import { inspectionPage, inspectionPdf } from "../tests/helpers/pdfForms";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  interceptOpenPath,
  launchApp,
  newMind,
  pathsOpened,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

for (const language of ["en", "zh-CN"] as const) {
  test(`a filled form is readable, and its field Citation opens at the value, in ${language}`, async () => {
    const dataDir = await createDataFolder();
    const sources = await createDataFolder();
    const path = join(sources, "Inspection.pdf");
    await writeFile(path, inspectionPdf(language === "zh-CN"));
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1600, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await window.getByTestId("add-documents-input").setInputFiles(path);
      const item = window.getByTestId("document-list-item");
      await expect(item).toHaveAttribute("data-status", "ready");
      const bridge = await coreOf(window);
      const [document] = await bridge.evaluate((core) => core.listDocuments());
      if (!document) throw new Error("The PDF was not added.");
      const quote = language === "zh-CN" ? "单件质量（g）: 125.50" : "Unit mass (g): 125.50";
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await editor.evaluate(
        (dom, attrs) => {
          (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, {
            type: "paragraph",
            content: [
              { type: "text", text: attrs.quote },
              { type: "citation", attrs },
            ],
          });
        },
        {
          passageId: "inspection-page-1",
          documentId: document.id,
          documentName: document.name,
          contentHash: document.contentHash,
          pageFrom: 1,
          pageTo: 1,
          location: null,
          quote,
          check: "found",
          checkReason: null,
        },
      );
      await pointAt(window, editor.getByTestId("citation-chip"));
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await pointAndClick(window, card.getByTestId("citation-open"));
      const page = window.getByTestId("viewer").locator('[data-page-number="1"]');
      await expect(page).toHaveAttribute("data-drawn", "true");
      await expect(page.locator(".textLayer")).toContainText("BIRCH-42");
      await expect(page.locator("[data-quote-highlight]")).toContainText(quote);
      await expect(page.locator("[data-quote-highlight]")).toBeInViewport();
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 900);
        await pointAndClick(window, window.locator('[role="tab"][data-kind="document"]'));
        await expect(page.locator("[data-quote-highlight]")).toBeVisible();
        await expect(page.locator(".pdf-page-text")).not.toHaveAttribute("style", /transform:/);
        if (process.env.INCARNAMIND_SCREENSHOTS)
          await window.screenshot({
            path: join(process.env.INCARNAMIND_SCREENSHOTS, `pdf-forms-${language}-${width}.png`),
          });
      }
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
      await removeDataFolder(sources);
    }
  });

  test(`an unsupported form shows an actionable partial-reading problem in ${language}`, async () => {
    const dataDir = await createDataFolder();
    const sources = await createDataFolder();
    const form = inspectionPage(language === "zh-CN");
    const path = join(sources, "Inspection.pdf");
    await writeFile(
      path,
      buildPdf([
        {
          ...form,
          fields: [
            ...(form.fields ?? []),
            {
              dictionary:
                "/FT /Sig /T (signature) /TU (Approval signature) /Rect [210 80 570 104] /F 4",
              appearance: pdfAppearance("Signed by inspector"),
            },
          ],
        },
      ]),
    );
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await window.getByTestId("add-documents-input").setInputFiles(path);
      const item = window.getByTestId("document-list-item");
      await expect(item).toHaveAttribute("data-status", "failed");
      await pointAndClick(window, window.getByTestId("open-library"));
      await expect(window.getByTestId("library-fix-reason")).toContainText(
        language === "zh-CN" ? "有些表单字段未能读取" : "Some form fields couldn’t be read",
      );
      await expect(window.getByTestId("library-fix-reason")).toContainText(
        language === "zh-CN" ? "再添加该副本" : "then add that copy",
      );
      await expect(window.getByTestId("library-fix-open")).toBeVisible();
      await expect(window.getByTestId("library-fix-retry")).toBeVisible();
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          path: join(process.env.INCARNAMIND_SCREENSHOTS, `pdf-forms-partial-${language}.png`),
        });
      await pointAndClick(window, item.getByTestId("open-document"));
      const warning = window.getByTestId("viewer").getByTestId("forms-unread");
      await expect(warning).toContainText(language === "zh-CN" ? "打印为 PDF" : "Print to PDF");
      const print = warning.getByTestId("forms-print");
      await expect(print).toHaveText(language === "zh-CN" ? "打印为 PDF…" : "Print to PDF…");
      await interceptOpenPath(app);
      await pointAndClick(window, print);
      expect(await pathsOpened(app)).toEqual([await realpath(path)]);
      if (process.env.INCARNAMIND_SCREENSHOTS)
        await window.screenshot({
          path: join(
            process.env.INCARNAMIND_SCREENSHOTS,
            `pdf-forms-partial-viewer-${language}.png`,
          ),
        });
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
      await removeDataFolder(sources);
    }
  });
}
