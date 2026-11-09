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

    // Opened, a damaged file says the same plain words, with the same two ways on; the reader's
    // own message is only on hover (#763).
    const broken = rows.filter({ hasText: "Broken" });
    await pointAndClick(window, broken.getByTestId("library-document-name"));
    const viewer = window.getByTestId("viewer");
    await expect(viewer).toBeVisible();
    // Kept open, so it stays through the widths below.
    await pointAndClick(window, viewer.getByTestId("viewer-keep"));
    const problem = viewer.getByTestId("viewer-problem");
    await expect(problem).toContainText(WORDS[language].fixes[0][1]);
    await expect(viewer.getByTestId("viewer-fix-open")).toHaveText(WORDS[language].fixes[0][2][0]);
    await expect(viewer.getByTestId("viewer-retry")).toHaveText(WORDS[language].fixes[0][2][1]);
    await expect(problem).not.toContainText("Invalid PDF structure");
    await expect(problem.locator("[title]")).toHaveAttribute("title", /Invalid PDF structure/);
    // At both widths the line and its buttons hold, in this language.
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 900);
      await expect(viewer.getByTestId("viewer-fix-open")).toBeVisible();
      expect(
        await problem.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    }
    await setWindowSize(app, window, 1440, 900);
    // The Library is back in view for the rest.
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(window.getByTestId("library")).toBeVisible();

    // Read again: the scan is read once more, and says the same until text is found in it.
    const scan = rows.filter({ hasText: "Scan" });
    await pointAndClick(window, scan.getByTestId("library-fix-retry"));
    await expect(scan.getByTestId("library-fix-reason")).toHaveText(WORDS[language].fixes[2][1]);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Organize says what it does, with no model what it needs, and on a model on this computer runs without asking (${language})`, async () => {
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
        ? "It sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, any matching Tags’ names and descriptions and your interface language, to the model you set up, once you allow it."
        : "经你允许后，它会把文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述、相符标签的名称和描述以及你的界面语言，发送给你设置的模型。",
    );
    await pointAndClick(window, needs.getByTestId("library-organize-dismiss"));
    await expect(needs).toHaveCount(0);

    // A model on this computer sends nothing, so Organize runs on it without asking, keeps it as
    // the choice for Organize and Tags, and what it proposes waits in the Review until Confirm.
    await connectLocalChatModel(window);
    await pointAndClick(window, lib.getByTestId("library-organize"));
    await expect(lib.getByTestId("library-organize-consent")).toHaveCount(0);
    await expect(needs).toHaveCount(0);
    const organizeModel = () =>
      bridge(window, async (core) => {
        const chosen = (await core.getLibrary()).settings.classifier;
        return chosen?.kind === "chat" ? chosen.choice.modelId : null;
      });
    await expect.poll(organizeModel).toBe("fake-model");
    const review = window.getByTestId("organize-review");
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId("organize-review-name")).toHaveText(["Harbour"]);
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(review).toHaveCount(0);
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
    // It fits no Folder and gets no Tag: nothing is proposed, so no Review opens (#2339).
    await expect(window.getByTestId("copied-line")).toHaveText(
      language === "en"
        ? "Organize found no Folder to suggest for these Documents"
        : "未能为这些文档推荐文件夹",
      { timeout: 30_000 },
    );
    await expect(review).toHaveCount(0);
    await expect(needs).toHaveCount(0);
    await app.close();
  });
}
