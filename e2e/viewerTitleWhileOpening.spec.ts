import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import { PNG } from "../tests/helpers/word";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  removeDataFolder,
  setLanguage,
} from "./app";

const fixtures = join(__dirname, "../tests/fixtures");
const views = [
  { kind: "text", module: "TextView", content: "viewer-text", file: "Tides.txt" },
  { kind: "PDF", module: "PdfView", content: "pdf-page-number", file: "Tides.pdf" },
  { kind: "Word", module: "DocxView", content: "viewer-docx", file: "Field Report.docx" },
  {
    kind: "slides",
    module: "SlidesView",
    content: "viewer-slides",
    file: "Quarterly Research Update.pptx",
  },
  { kind: "sheet", module: "SheetView", content: "viewer-grid", file: "Regional Revenue.xlsx" },
  { kind: "image", module: "ImageView", content: "image-picture", file: "Tides.png" },
  { kind: "transcript", module: "TranscriptView", content: "transcript-lines", file: "Tides.vtt" },
  { kind: "web", module: "WebView", content: "viewer-web-article", file: "" },
] as const;

async function addFile(window: Page, folder: string, file: string) {
  if (!file) {
    const html = await readFile(join(fixtures, "web/article.html"), "utf8");
    await (await coreOf(window)).evaluate(
      (core, html) => core.saveWebPage({ address: "https://example.org/tea", html }),
      html,
    );
    await expectReadyDocuments(window, 1);
    return;
  }
  const path = join(folder, file);
  switch (file) {
    case "Tides.txt":
      await writeFile(path, "Tide notes.");
      break;
    case "Tides.pdf":
      await writeFile(path, buildPdf([{ lines: ["Tide notes."] }]));
      break;
    case "Tides.png":
      await writeFile(path, PNG);
      await window.getByTestId("add-documents-input").setInputFiles(path);
      await expect(window.getByTestId("document-list-item")).toHaveAttribute(
        "data-status",
        "no-text",
      );
      return;
    case "Tides.vtt":
      await writeFile(path, "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nTide notes.\n");
      break;
    default:
      await addDocuments(window, [join(fixtures, "formats", file)]);
      return;
  }
  await addDocuments(window, [path]);
}

/** Hold the viewer's module, or its file if the module was already loaded. */
async function holdViewer(app: ElectronApplication, module: string) {
  return app.evaluateHandle(({ session }, name) => {
    const requests = session.defaultSession.webRequest;
    const pending: (() => void)[] = [];
    requests.onBeforeRequest((details, respond) => {
      const url = new URL(details.url);
      const viewerModule = url.protocol === "file:" && url.pathname.includes(`/${name}-`);
      if (viewerModule || url.protocol === "incarnamind-document:") {
        pending.push(() => respond({}));
      } else {
        respond({});
      }
    });
    return {
      held: () => pending.length,
      release: () => {
        requests.onBeforeRequest(null);
        for (const resume of pending) resume();
      },
    };
  }, module);
}

async function whileOpening(
  view: (typeof views)[number],
  language: "en" | "zh-CN",
  act: (window: Page, viewer: Locator, finishLoading: () => Promise<void>) => Promise<void>,
) {
  const data = await createDataFolder();
  const files = await createDataFolder();
  const { app, window } = await launchApp(data);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await addFile(window, files, view.file);
    const load = await holdViewer(app, view.module);
    await window.getByTestId("document-list-item").getByTestId("open-document").click();
    await expect.poll(() => load.evaluate((gate) => gate.held())).toBeGreaterThan(0);
    const viewer = window.getByTestId("viewer");
    const content = viewer.getByTestId(view.content);
    await expect(content).toHaveCount(0);
    await act(window, viewer, async () => {
      await load.evaluate((gate) => gate.release());
      await expect(content).toBeVisible();
    });
  } finally {
    await app.close();
    await removeDataFolder(data);
    await removeDataFolder(files);
  }
}

for (const view of views) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`${view.kind}, ${language}: a name typed while the Document opens keeps its focus and saves on Enter`, async () => {
      await whileOpening(view, language, async (window, viewer, finishLoading) => {
        const title = viewer.getByTestId("viewer-title");
        await title.dblclick();
        const input = viewer.getByTestId("viewer-title-rename");
        const draft = language === "en" ? "Harbour notes" : "港口笔记";
        await expect(input).toBeFocused();
        await window.keyboard.insertText(draft);
        await window.keyboard.press("Shift+ArrowLeft");
        await finishLoading();
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(draft);
        expect(
          await input.evaluate((field: HTMLInputElement) => [
            field.selectionStart,
            field.selectionEnd,
          ]),
        ).toEqual([draft.length - 1, draft.length]);
        await window.keyboard.press("Enter");
        await expect(title).toHaveText(draft);
        const core = await coreOf(window);
        await expect
          .poll(() =>
            core.evaluate(async (bridge) => (await bridge.listDocuments()).map(({ name }) => name)),
          )
          .toEqual([draft]);
      });
    });
  }
}

test("the open Document menu keeps the keyboard focus as the text arrives", async () => {
  await whileOpening(views[0], "en", async (window, viewer, finishLoading) => {
    const menu = viewer.getByTestId("document-file-menu");
    await menu.focus();
    await window.keyboard.press("Enter");
    const rename = viewer.getByTestId("document.rename");
    await expect(rename).toBeVisible();
    await rename.focus();
    await finishLoading();
    await expect(rename).toBeVisible();
    await expect(rename).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(viewer.getByTestId("viewer-title-rename")).toBeFocused();
  });
});
