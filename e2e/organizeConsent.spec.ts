/**
 * Dropped Documents wait for the User's Allow before a cloud service reads them (#2308): the
 * sidebar's footer says how many and names the service, its popover says what goes, the press
 * organizes them with one Undo, and turning the switch off brings the row back.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
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
    one: "1 to organize",
    allow: "Allow Anthropic",
    sends:
      "4 Documents wait to be organized: Anthropic isn’t allowed to read them. Allowing it sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions and any matching Tags’, to Anthropic, for these and for Documents you add later.",
    text: (index: number) => `Harbour survey ${index}: the berth depth at the north quay.`,
  },
  "zh-CN": {
    row: "4 个待整理",
    one: "1 个待整理",
    allow: "允许 Anthropic",
    sends:
      "4 个文档等待整理：尚未允许 Anthropic 读取。允许后，会把每个文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述以及相符标签的名称和描述，发送给 Anthropic，包括这些文档和以后添加的文档。",
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
  test(`${language}: the footer asks, the press turns organizing on and organizes with one Undo, off asks again`, async () => {
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
      const filed = () =>
        window.evaluate(
          async () =>
            (
              await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary()
            ).assignments.filter((each) => each.groupId !== null).length,
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
      await expect.poll(filed, { timeout: 60_000 }).toBe(4);

      // The press turned organizing on for that service: a Document dropped now goes by itself.
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
      await expect.poll(filed, { timeout: 60_000 }).toBe(5);

      // One Undo takes the press's run back; the switch stays on, so no row asks.
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(filed, { timeout: 30_000 }).toBe(1);
      await expect(row).toHaveCount(0);

      // Off again: a Document dropped now waits, and the row asks once more.
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
      });
      await writeFile(join(sources, "Survey 6.md"), `# Survey 6\n\n${words.text(6)}\n`);
      await add(6);
      await expect(row.getByTestId("status-label")).toHaveText(words.one, { timeout: 30_000 });
      await expect(allow).toHaveText(words.allow);

      // Local mode sends nothing to a cloud service, so nothing asks.
      await window.evaluate(async () => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(true);
      });
      await expect(row).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
