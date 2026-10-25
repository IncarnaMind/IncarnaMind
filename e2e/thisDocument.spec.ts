import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  frontMind,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  WINDOW_SIZE,
} from "./app";

/*
 * "This document" is the Document open beside the Mind (#1334): the composer sends the
 * Documents on screen with the Question, and the scripted model (src/main/fakeChat/minds.ts)
 * writes its summary "Written from" the first one the Question names as open, into the empty
 * Mind, with the line that says so. In English and in Chinese.
 */

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const FILES = [
  [
    "Employment contract",
    "# Employment contract\n\nEither party may end it with one month's notice.\n",
  ],
  ["Mutual NDA", "# Mutual NDA\n\nConfidentiality lasts five years after it ends.\n"],
] as const;

for (const [language, request, wrote] of [
  ["en", "Write a short summary of this document.", "Wrote 1 paragraph"],
  ["zh-CN", "为这份文件写一份简短摘要。", "写入了 1 个段落"],
] as const) {
  test(`a short summary of “this document” is written from the Document open beside the Mind (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, WINDOW_SIZE.width, 900);
    const paths = await Promise.all(
      FILES.map(async ([name, text]) => {
        const path = join(sources, `${name}.md`);
        await writeFile(path, text);
        return path;
      }),
    );
    await addDocuments(window, paths);
    await newMind(window);
    const nda = await documentIdOf(window, "Mutual NDA");
    await window.evaluate(async (documentId) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.changeLayout("main", {
        type: "open",
        item: { kind: "document", documentId },
        where: { in: "side" },
        focus: false,
      });
    }, nda);
    await expect(window.getByTestId("tab-group")).toHaveCount(2);

    await askInAssistant(window, request);

    const editor = frontMind(window).getByTestId("mind-editor");
    await expect(editor).toContainText("Written from Mutual NDA.");
    await expect(editor).not.toContainText("Employment contract");
    await expect(editor.getByTestId("applied-count")).toHaveText(wrote);
    await app.close();
  });
}
