import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { encryptedOfficeFile } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * Files that need attention carry their fix (#763 item 21): each says why in
 * plain words, with its next step as buttons. Organize says what it does
 * before it runs, and what it needs when it has no model (item 20). English
 * and Chinese.
 */
let dataDir: string;
let library: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  library = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(library);
});

const FILES: Record<string, string | Uint8Array> = {
  "Tides.txt": "Spring tides happen at new moon and at full moon.\n",
  "Locked.docx": encryptedOfficeFile(),
  "Scan.pdf": buildPdf([{ image: true }]),
  "Broken.pdf": "%PDF-1.4 this is not a PDF",
  "Empty.txt": "",
};

const bridge = <T>(window: Page, run: (core: CoreBridge) => Promise<T>) =>
  window.evaluate(
    (source) =>
      new Function("core", `return (${source})(core)`)(
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind,
      ) as Promise<T>,
    run.toString(),
  );

async function start(language: "en" | "zh-CN") {
  for (const [name, contents] of Object.entries(FILES)) {
    await mkdir(library, { recursive: true });
    await writeFile(join(library, name), contents);
  }
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: library });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await window.evaluate(async (path) => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(path);
  }, library);
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const all = await (
          globalThis as unknown as { incarnamind: CoreBridge }
        ).incarnamind.listDocuments();
        return (
          all.length === 5 &&
          all.every((each) => each.status !== "queued" && each.status !== "extracting")
        );
      }),
    )
    .toBe(true);
  await window.getByTestId("open-library").click();
  return { app, window };
}

const WORDS = {
  en: {
    fixes: [
      [
        "Broken",
        "Damaged file: save a copy from your PDF app, then add it",
        ["Open in default app", "Retry"],
      ],
      [
        "Locked",
        "Password-protected: remove it in its app, then add the copy",
        ["Open in default app", "Retry"],
      ],
      ["Scan", "A scan with no text yet", ["Open in default app", "Read it again"]],
      ["Empty", "This file is empty", ["Retry"]],
    ],
  },
  "zh-CN": {
    fixes: [
      ["Broken", "文件已损坏：用 PDF 应用另存一份，再添加副本", ["用默认应用打开", "重试"]],
      ["Locked", "文件设有密码：在它的应用中去掉密码，再添加副本", ["用默认应用打开", "重试"]],
      ["Scan", "这是扫描件，暂时没有文字", ["用默认应用打开", "重新读取"]],
      ["Empty", "这个文件是空的", ["重试"]],
    ],
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`each file that needs attention says why in plain words and offers its next step (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language);
    const rows = window.getByTestId("library").getByTestId("library-document");
    await expect(rows).toHaveCount(5);
    for (const [name, reason, buttons] of WORDS[language].fixes) {
      const row = rows.filter({ hasText: name });
      const fix = row.getByTestId("library-fix");
      await expect(fix.getByTestId("library-fix-reason")).toHaveText(reason);
      await expect(fix.getByRole("button")).toHaveText([...buttons]);
    }
    // A file that read has none.
    await expect(rows.filter({ hasText: "Tides" }).getByTestId("library-fix")).toHaveCount(0);

    // Read again: the scan is read once more, and says the same until text is found in it.
    const scan = rows.filter({ hasText: "Scan" });
    await pointAndClick(window, scan.getByTestId("library-fix-retry"));
    await expect(scan.getByTestId("library-fix-reason")).toHaveText(WORDS[language].fixes[2][1]);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Organize says what it does, and with no model what it needs and the way on (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: library });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await writeFile(join(library, "Harbour.txt"), "Notes on the harbour.\n");
    await window.evaluate(
      async (path) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.addDocuments([path]);
        await core.createLibraryGroup({ name: "Harbour", description: "" });
      },
      join(library, "Harbour.txt"),
    );
    await window.getByTestId("open-library").click();
    const lib = window.getByTestId("library");
    // The line that said what Organize does is its button's tooltip.
    await expect(lib.getByTestId("library-organize-explain")).toHaveCount(0);
    await expect(lib.getByTestId("library-organize")).toHaveAttribute(
      "title",
      language === "en"
        ? "Suggests a Folder and Tags for each Document. You decide."
        : "为每个文档建议文件夹和标签，由你决定。",
    );
    await pointAndClick(window, lib.getByTestId("library-organize"));
    const needs = lib.getByTestId("library-organize-needs-model");
    await expect(needs).toContainText(
      language === "en" ? "Organize needs an AI model" : "整理需要一个 AI 模型",
    );
    // No AI model is connected yet: first run's key field, in place, and no step through Settings.
    await expect(needs.getByTestId("library-organize-use")).toHaveCount(0);
    await expect(needs.getByTestId("library-organize-set-up")).toHaveCount(0);
    await expect(needs.getByTestId("library-organize-key")).toBeVisible();
    await expect(needs).toContainText(
      language === "en"
        ? "It sends Documents’ names and excerpts, and Folder and Tag names and descriptions, to the model you set up."
        : "它会把文档名称和摘录，以及文件夹和标签的名称与描述，发送给你设置的模型。",
    );

    // With an AI model connected, Organize can use its company.
    await connectLocalChatModel(window);
    await bridge(window, async (core) => {
      await core.getLibrary();
    });
    await pointAndClick(window, lib.getByTestId("library-organize"));
    await expect(needs.getByTestId("library-organize-use")).toHaveText(
      language === "en" ? "Use Ollama" : "使用 Ollama",
    );
    // A local model sends nothing, so says nothing about sending.
    await expect(needs.getByTestId("library-organize-sends")).toHaveCount(0);

    // A model on another service: the line says what would be sent there.
    await bridge(window, async (core) => {
      await core.saveChatProvider({
        kind: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        modelId: "example-model",
      });
    });
    await expect(needs.getByTestId("library-organize-use")).toHaveText(
      language === "en" ? "Use llm.example.com" : "使用 llm.example.com",
    );
    const sends = needs.getByTestId("library-organize-sends");
    await expect(sends).toHaveText(
      language === "en"
        ? "Sends document names and excerpts to llm.example.com. · Details"
        : "会把文档名称和摘录发送给 llm.example.com。 · 详情",
    );
    const details = sends.getByTestId("library-organize-sends-details");
    await details.focus();
    await window.keyboard.press("Enter");
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(sends.getByTestId("library-organize-sends-list")).toHaveText(
      language === "en"
        ? "Each Document’s name and the start of its text (for a scan, images of its first pages), and your Folders’ and Tags’ names and descriptions, go to llm.example.com."
        : "每个文档的名称和开头的文字（扫描件则是前几页的图片），以及文件夹和标签的名称与描述，会发送给 llm.example.com。",
    );

    await window.keyboard.press("Space");
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(sends.getByTestId("library-organize-sends-list")).toHaveCount(0);

    // The answer is kept: Organize runs with that model, and asks no more.
    await pointAndClick(window, needs.getByTestId("library-organize-use"));
    await expect(needs).toHaveCount(0);
    const organized = () =>
      bridge(window, async (core) => {
        const { assignments } = await core.getLibrary();
        return assignments.map((each) => `${each.status} ${each.model?.id ?? ""}`);
      });
    await expect.poll(organized).toEqual(["classified example-model"]);
    await writeFile(join(library, "Tides.txt"), "Notes on the tides.\n");
    await bridge(window, async (core) => {
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
    });
    await window.evaluate(
      (path) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([path]),
      join(library, "Tides.txt"),
    );
    await pointAndClick(window, lib.getByTestId("library-organize"));
    await expect.poll(organized).toEqual(["classified example-model", "classified example-model"]);
    await expect(needs).toHaveCount(0);
    await app.close();
  });
}
