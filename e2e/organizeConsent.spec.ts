/**
 * Dropped Documents wait for the User's Allow before a cloud service reads them (#2308): the
 * sidebar's footer says how many and names the service, its popover says what goes, the press
 * organizes them into Suggestions, where they wait for the User's Confirm with nothing filed
 * (#1569), and once the User turns the switch off no row asks again (#3353).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

const CASES = {
  en: {
    row: "4 to organize",
    allow: "Allow Anthropic",
    sends:
      "4 Documents wait to be organized: Anthropic isn’t allowed to read them. Allowing it sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, any matching Tags’ names and descriptions and your interface language, to Anthropic, for these and for Documents you add later.",
    text: (index: number) => `Harbour survey ${index}: the berth depth at the north quay.`,
  },
  "zh-CN": {
    row: "4 个待整理",
    allow: "允许 Anthropic",
    sends:
      "4 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把每个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述、相符标签的名称和描述以及你的界面语言，发送给 Anthropic，包括这些文档和以后添加的文档。",
    text: (index: number) => `Harbour 测量第 ${index} 份：北码头泊位的水深。`,
  },
} as const;

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

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: the footer asks, the press turns organizing on and proposes them for the User to confirm, off asks no more`, async () => {
    test.setTimeout(120_000);
    const words = CASES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      // A runner with no keyring keeps the test key as plain text, as the User would accept it.
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, 1280, 860);
      await window.evaluate(
        async ({ chosen }) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.updateSettings({ user: { language: chosen } });
          const provider = await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-ant-test",
            modelId: "claude-haiku-5-5",
          });
          await core.createLibraryGroup({ name: "Harbour", description: "Port work." });
          await core.saveLibrarySettings({
            ...(await core.getLibrary()).settings,
            classifier: {
              kind: "chat",
              choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
            },
          });
        },
        { chosen: language },
      );
      const paths: string[] = [];
      for (let index = 1; index <= 4; index++) {
        const path = join(sources, `Survey ${index}.md`);
        await writeFile(path, `# Survey ${index}\n\n${words.text(index)}\n`);
        paths.push(path);
      }
      await addDocuments(window, paths);

      const row = window.getByTestId("sort-consent");
      const allow = row.getByTestId("sort-consent-allow");
      await expect(row.getByTestId("status-label")).toHaveText(words.row, { timeout: 60_000 });
      await expect(allow).toHaveText(words.allow);
      // Beside another status, its "+1", the row reads in full: it wraps at a word, never cut (#3466).
      const odd = join(sources, "Survey.xyz");
      await writeFile(odd, "Not a Document.");
      await window.getByTestId("add-documents-input").setInputFiles([odd]);
      await expect(row.getByTestId("status-more")).toBeVisible();
      expect(
        await row
          .getByTestId("status-label")
          .evaluate((label) => label.scrollWidth <= label.clientWidth),
      ).toBe(true);
      await expect(allow).toBeInViewport();
      const filed = () =>
        window.evaluate(
          async () =>
            (
              await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary()
            ).assignments.filter((each) => each.groupId !== null).length,
        );
      const waiting = () =>
        window.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.getOrganizeReview()
            ).count,
        );
      expect(await filed()).toBe(0);

      // What goes, readable before the press: on a click, and on the keyboard's focus.
      await pointAndClick(window, row.getByTestId("status-label"));
      await expect(window.getByTestId("status-sends")).toHaveText(words.sends);
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("status-sends")).toHaveCount(0);
      await row.getByTestId("status-label").blur();
      await row.getByTestId("status-label").focus();
      await expect(window.getByTestId("status-sends")).toHaveText(words.sends);

      // Tab reaches Allow, and Enter is the press.
      await window.keyboard.press("Tab");
      await expect(allow).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(row).toHaveCount(0);
      // Organize proposes Harbour for the four, and they wait for the User: none is filed.
      await expect.poll(waiting, { timeout: 60_000 }).toBe(4);
      expect(await filed()).toBe(0);

      // The press turned organizing on there: a Document dropped now is proposed by itself.
      const add = (index: number) =>
        window.evaluate(
          async (path) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            await core.addDocuments([path]);
          },
          join(sources, `Survey ${index}.md`),
        );
      await writeFile(join(sources, "Survey 5.md"), `# Survey 5\n\n${words.text(5)}\n`);
      await add(5);
      await expect.poll(waiting, { timeout: 60_000 }).toBe(5);
      expect(await filed()).toBe(0);
      await expect(row).toHaveCount(0);
      // The Library's top says how many wait, where Review opens them.
      await pointAndClick(window, window.getByTestId("open-library"));
      await expect(window.getByTestId("organize-waiting")).toContainText(
        translate(language, "organizeReview.waiting", { count: "5" }),
      );

      // Turned off, the switch is the User's no: a Document dropped now waits, and nothing asks.
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveLibrarySettings({
          ...(await core.getLibrary()).settings,
          automatic: false,
          turnOn: false,
        });
      });
      await writeFile(join(sources, "Survey 6.md"), `# Survey 6\n\n${words.text(6)}\n`);
      await add(6);
      await expect
        .poll(
          () =>
            window.evaluate(
              async () =>
                (
                  await (
                    globalThis as unknown as { incarnamind: CoreBridge }
                  ).incarnamind.listDocuments()
                ).find((each) => each.name === "Survey 6")?.tagging,
            ),
          { timeout: 30_000 },
        )
        .toBe("off");
      await expect(row).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
