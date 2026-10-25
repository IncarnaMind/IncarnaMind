import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CitationAttributes, CitationPlace, CoreBridge, Document } from "../src/core/api";
import { footnotesOf, paragraphsOf, part, unzip } from "../tests/helpers/docx";
import {
  addDocuments,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  mindNode,
  motionSettled,
  nameMind,
  newMind,
  openOptions,
  pointAndClick,
  removeDataFolder,
  savedLine,
  setLanguage,
  setWindowSize,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";
import { pdfText } from "./pdfText";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const WORDS = {
  en: {
    question: "Where should Citations go?",
    footnotes: "Footnotes",
    list: "List at the end",
    count: "19 Citations from 1 Document",
    unasked: "Not chosen yet, so the first export with Citations asks.",
    byStyle: "Set by the citation style",
    options: "Export options",
    heading: "Bibliography",
    markQuestion: "Mark the text IncarnaMind wrote?",
  },
  "zh-CN": {
    question: "引用放在哪里？",
    footnotes: "脚注",
    list: "列在文末",
    count: "19 个引用，来自 1 个文档",
    unasked: "尚未选择，首次导出带引用的内容时会询问。",
    byStyle: "由引用格式决定",
    options: "导出选项",
    heading: "参考文献",
    markQuestion: "标出 IncarnaMind 写的内容？",
  },
} as const;

let dataDir: string;
let out: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  out = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(out);
  await removeDataFolder(sources);
});

const bridge = (window: Page) => ({
  documents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    ),
  write: (mindId: string, update: Uint8Array) =>
    window.evaluate(
      ([id, bytes]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
          id,
          new Uint8Array(bytes),
        ),
      [mindId, Array.from(update)] as const,
    ),
  place: (answer: CitationPlace | undefined) =>
    window.evaluate(async (chosen) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { exportOptions } = (await core.getSettings()).user;
      const { citationPlace: _, ...rest } = exportOptions;
      await core.updateSettings({
        user: { exportOptions: chosen ? { ...rest, citationPlace: chosen } : rest },
      });
    }, answer),
  style: (mindId: string, style: string) =>
    window.evaluate(
      ([id, chosen]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setMindCitationStyle(
          id as string,
          chosen as string,
        ),
      [mindId, style] as const,
    ),
});

function citationAttributes(document: Document, page: number): CitationAttributes {
  return {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: page,
    pageTo: page,
    location: null,
    quote: "Spring tides happen at new moon.",
    check: "found",
    checkReason: null,
  };
}

async function mindCiting(window: Page, { none = false }: { none?: boolean } = {}) {
  await newMind(window);
  await nameMind(window, "Tides");
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  await writeFile(join(sources, "Tides.txt"), "Spring tides happen at new moon.");
  await addDocuments(window, [join(sources, "Tides.txt")]);
  await expect.poll(async () => (await bridge(window).documents())[0]?.status).toBe("ready");
  const [tides] = await bridge(window).documents();
  if (!tides) throw new Error("No Document.");
  await bridge(window).write(
    mindId,
    blocksUpdate(
      none
        ? [mindNode("paragraph", { id: randomUUID() }, ["Nothing is cited here."])]
        : Array.from({ length: 19 }, (_, index) =>
            mindNode("paragraph", { id: randomUUID() }, [
              `Spring tides come at new moon ${index + 1} `,
              mindNode("citation", { ...citationAttributes(tides, 1 + (index % 3)) }),
              ".",
            ]),
          ),
    ),
  );
  return mindId;
}

const exported = async (name: string) => unzip(await readFile(join(out, name)));
const documentOf = async (name: string) => part(await exported(name), "word/document.xml");

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`the first Word export of a Mind with Citations asks where they go, once, and each answer gives the file it says (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, askCitationPlace: true });
    await dismissChatSetup(window);
    await mindCiting(window);
    await useOutputLocation(window, out);
    await setLanguage(window, language);
    const result = window.getByTestId("export-result");
    const footnotes = result.getByTestId("export-place-ask-footnotes");
    const list = result.getByTestId("export-place-ask-list");
    const done = result.getByTestId("export-done");
    await exportFromMenu(window, "docx");
    await expect(result).toHaveAttribute("data-state", "ask");
    await expect(result.getByTestId("export-place-question")).toContainText(words.question);
    await expect(result.getByTestId("export-place-count")).toHaveText(words.count);
    await expect(footnotes).toHaveText(words.footnotes);
    await expect(list).toHaveText(words.list);
    await expect(footnotes).toBeFocused();
    await expect(result.getByTestId("export-mark-question")).toHaveCount(0);
    await screenshot(window, `place-ask-${language}-wide`);
    expect(await readdir(out)).toEqual([]);
    await window.keyboard.press("Escape");
    await expect(result).toHaveCount(0);
    await setWindowSize(app, window, 900, WINDOW_SIZE.height);
    await exportFromMenu(window, "docx");
    await expect(result).toHaveAttribute("data-state", "ask");
    const [pane, shown] = await Promise.all([
      window.getByTestId("mind-pane").boundingBox(),
      result.boundingBox(),
    ]);
    expect(shown && pane && shown.x >= pane.x && shown.x + shown.width <= pane.x + pane.width).toBe(
      true,
    );
    await screenshot(window, `place-ask-${language}-narrow`);
    await pointAndClick(window, list);
    await expect(done).toHaveText(savedLine("Tides.docx", out, language));
    const docx = await exported("Tides.docx");
    const text = part(docx, "word/document.xml");
    expect(text).not.toContain("w:footnoteReference");
    expect(footnotesOf(part(docx, "word/footnotes.xml"))).toEqual({});
    const paragraphs = paragraphsOf(text).map((each) => each.text);
    expect(paragraphs.find((each) => each.includes("new moon 1"))).toMatch(/new moon 1 \[1\]\./);
    expect(paragraphs.slice(-2)).toEqual([
      words.heading,
      language === "en"
        ? "[1]\tTides. Cited: p. 1; p. 2; p. 3"
        : "[1]\tTides。引用位置：第 1 页；第 2 页；第 3 页",
    ]);
    await window.getByText("Spring tides come at new moon 1 ").first().click();
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(done).toHaveText(savedLine("Tides 2.docx", out, language));
    await exportFromMenu(window, "pdf");
    await expect(done).toHaveText(savedLine("Tides.pdf", out, language));
    expect((await pdfText(await readFile(join(out, "Tides.pdf")))).join("\n")).toContain(
      words.heading,
    );
    await expect(result.getByTestId("export-place-question")).toHaveCount(0);
    await app.close();
  });

  test(`Export options shows the answer and changes it, and a style other than Numbered decides for itself (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, askCitationPlace: true });
    await dismissChatSetup(window);
    const mindId = await mindCiting(window);
    await setWindowSize(app, window, 900, WINDOW_SIZE.height);
    await useOutputLocation(window, out);
    await setLanguage(window, language);
    const result = window.getByTestId("export-result");
    const done = result.getByTestId("export-done");
    const sheet = window.getByTestId("export-dialog");
    const choice = sheet.getByTestId("export-citation-place");
    const choose = async (answer: CitationPlace) => {
      await pointAndClick(window, choice.getByText(words[answer]));
      await expect(choice).toHaveAttribute("data-answer", answer);
    };
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "none");
    await expect(choice).toHaveAccessibleName(words.question);
    await expect(sheet).toContainText(words.unasked);
    await screenshot(window, `place-options-${language}-unasked`);
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await openOptions(window, words.options);
    await choose("list");
    await screenshot(window, `place-options-${language}-answered`);
    await sheet.getByTestId("export-save").click();
    await expect(sheet).toBeHidden();
    await exportFromMenu(window, "docx");
    await expect(done).toHaveText(savedLine("Tides.docx", out, language));
    expect(await documentOf("Tides.docx")).not.toContain("w:footnoteReference");
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "list");
    await choose("footnotes");
    await sheet.getByTestId("export-save").click();
    await expect(sheet).toBeHidden();
    await exportFromMenu(window, "docx");
    await expect(done).toHaveText(savedLine("Tides 2.docx", out, language));
    expect(await documentOf("Tides 2.docx")).toContain("w:footnoteReference");
    await openOptions(window, words.options);
    await choose("list");
    await window.keyboard.press("Escape");
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "footnotes");
    await window.keyboard.press("Escape");
    await bridge(window).style(mindId, "apa");
    await openOptions(window, words.options);
    await expect(sheet.getByTestId("export-citation-place-style")).toHaveText(words.byStyle);
    await expect(choice).toHaveCount(0);
    await screenshot(window, `place-options-${language}-style`);
    await window.keyboard.press("Escape");
    await bridge(window).place(undefined);
    await exportFromMenu(window, "docx");
    await expect(done).toHaveText(savedLine("Tides 3.docx", out, language));
    await expect(result.getByTestId("export-place-question")).toHaveCount(0);
    expect(await documentOf("Tides 3.docx")).not.toContain("w:footnoteReference");
    await app.close();
  });
}

test("a Mind with no Citations is never asked, and nothing is stored", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, askCitationPlace: true });
  await dismissChatSetup(window);
  await mindCiting(window, { none: true });
  await useOutputLocation(window, out);
  const result = window.getByTestId("export-result");

  await exportFromMenu(window, "docx");
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Tides.docx", out));
  await expect(result.getByTestId("export-place-question")).toHaveCount(0);
  const citationPlace = await window.evaluate(
    async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings()).user
        .exportOptions.citationPlace,
  );
  expect(citationPlace).toBeUndefined();
  await app.close();
});

test("both questions at once: answered one after the other, the export waits for the second, and the keys reach each", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    askToMarkAiText: true,
    askCitationPlace: true,
  });
  await dismissChatSetup(window);
  await mindCiting(window);
  await useOutputLocation(window, out);
  const result = window.getByTestId("export-result");

  await exportFromMenu(window, "docx");
  await expect(result).toHaveAttribute("data-state", "ask");
  await expect(result.getByTestId("export-mark-question")).toHaveText(WORDS.en.markQuestion);
  await expect(result.getByTestId("export-place-question")).toContainText(WORDS.en.question);
  await expect(result.getByTestId("export-mark-ask-mark")).toBeFocused();
  await screenshot(window, "place-ask-both");
  await window.keyboard.press("Enter");
  await expect(result.getByTestId("export-mark-question")).toHaveCount(0);
  await expect(result.getByTestId("export-place-ask-footnotes")).toBeFocused();
  expect(await readdir(out)).toEqual([]);
  await window.keyboard.press("Tab");
  await expect(result.getByTestId("export-place-ask-list")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Tides.docx", out));
  expect(await documentOf("Tides.docx")).not.toContain("w:footnoteReference");
  await exportFromMenu(window, "pdf");
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Tides.pdf", out));
  await app.close();
});
