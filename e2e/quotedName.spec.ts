import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * A Citation whose Answer put its Document's name in quotation marks (#2504): its card says the
 * words are the Document's name, not a quote from its pages, and a Citation whose quoted words
 * did something else says nothing of a name.
 *
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const CASES = {
  en: {
    file: "Board meeting notes for March.pdf",
    contents: buildPdf([
      { lines: ["Minutes", "The board approved the harbour budget on 12 March."] },
    ]),
    sentence: "The minutes record “board meeting notes for March” as approved",
    quote: "The board approved the harbour budget",
    name: "board meeting notes for March",
    badge: "Quote found on p. 1",
    row: "This is the Document’s name, not a quote from its pages",
  },
  "zh-CN": {
    file: "三月董事会会议纪要.pdf",
    contents: buildPdf([{ chineseLines: ["会议纪要", "董事会于三月十二日批准了港口预算。"] }]),
    sentence: "纪要“三月董事会会议纪要”记录了这项批准",
    quote: "董事会于三月十二日批准了港口预算",
    name: "三月董事会会议纪要",
    badge: "已在第 1 页找到引文",
    row: "这是文档的名称，不是页面上的引文",
  },
} as const;

const pasteHtml = (editor: Locator, html: string) =>
  editor.evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/html", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, html);

for (const language of ["en", "zh-CN"] as const) {
  for (const held of ["name", "run-on"] as const) {
    test(`a Citation whose quoted words ${held === "name" ? "are its Document's name says so" : "ran on says nothing of a name"} (${language})`, async () => {
      const wanted = CASES[language];
      const dataDir = await createDataFolder();
      const sources = await createDataFolder();
      await writeFile(join(sources, wanted.file), wanted.contents);
      const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, wanted.file)]);
      const document = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const [first] = await bridge.listDocuments();
        return first ? { id: first.id, name: first.name, contentHash: first.contentHash } : null;
      });
      if (!document) throw new Error("No Document.");
      await newMind(window);
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const quotedWords =
        held === "name" ? { name: wanted.name } : { runsOnTo: { kind: "page", from: 2, to: 2 } };
      const span = [
        `data-type="citation"`,
        `data-document-id="${attribute(document.id)}"`,
        `data-document-name="${attribute(document.name)}"`,
        `data-content-hash="${attribute(document.contentHash ?? "")}"`,
        `data-page-from="1"`,
        `data-page-to="1"`,
        `data-location="${attribute(JSON.stringify({ kind: "page", from: 1, to: 1 }))}"`,
        `data-quote="${attribute(wanted.quote)}"`,
        `data-check="found"`,
        `data-quoted-words="${attribute(JSON.stringify(quotedWords))}"`,
      ].join(" ");
      await pasteHtml(
        editor,
        `<p>${wanted.sentence}<span ${span}></span>${language === "en" ? "." : "。"}</p>`,
      );
      const citation = editor.getByTestId("citation");
      await expect(citation).toHaveCount(1);
      await citation.getByTestId("citation-chip").click();
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("citation-badge")).toHaveText(wanted.badge);
      if (held === "name") {
        await expect(card.getByTestId("citation-quoted-name")).toHaveText(wanted.row);
      } else {
        await expect(card.getByTestId("citation-quoted-run-on")).toBeVisible();
        await expect(card.getByTestId("citation-quoted-name")).toHaveCount(0);
      }
      if (SCREENSHOTS) {
        await expect(card).toHaveCSS("opacity", "1");
        await window.screenshot({ path: join(SCREENSHOTS, `quoted-${held}-${language}.png`) });
      }
      await app.close();
      await removeDataFolder(dataDir);
      await removeDataFolder(sources);
    });
  }
}
