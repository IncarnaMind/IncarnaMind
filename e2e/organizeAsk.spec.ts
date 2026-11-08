/**
 * The first time Organize would send Documents to a cloud service, the Library asks in its own
 * words (#1569, ADR-0022): the card names the service and what goes there, never "Organize needs
 * an AI model" while one is set up. Not now sends nothing and records nothing; Allow and organize
 * records the consent and runs at once, opening the Review; a second press asks nothing.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
  runCommand,
  setWindowSize,
} from "./app";

const CASES = {
  en: {
    title: "Allow Anthropic to read your Documents?",
    sends:
      "Allowing it sends each Document’s name, kind and page count, the start of its text and its slide titles or sheet names, with your Folders’ names and descriptions, any matching Tags’ names and descriptions and your interface language, to Anthropic, each time you organize.",
    allow: "Allow and organize",
    notNow: "Not now",
    needsModel: "Organize needs an AI model",
  },
  "zh-CN": {
    title: "允许 Anthropic 读取你的文档？",
    sends:
      "允许后，每次整理都会把文档的名称、类型和页数、开头部分的文字及幻灯片标题或工作表名称，连同你的文件夹名称和描述、相符标签的名称和描述以及你的界面语言，发送给 Anthropic。",
    allow: "允许并整理",
    notNow: "以后再说",
    needsModel: "“整理”需要 AI 模型",
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

const core = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/** The requests made to cloud models, as the cost meter counts them. */
const modelRequests = async (window: Page) =>
  (await core(window)).evaluate(async (bridge) =>
    (await bridge.getCostSummary()).providers.reduce((sum, each) => sum + each.requests, 0),
  );

/** The User's decision on Organize reading their Documents with Anthropic. */
const consent = async (window: Page) =>
  (await core(window)).evaluate(
    async (bridge) =>
      (await bridge.listDataFlows()).find(
        (each) =>
          each.flow.id === "classification" && each.flow.service.id === "https://api.anthropic.com",
      )?.consent ?? "not-asked",
  );

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: the card asks before Anthropic first reads the Documents, Not now sends nothing, Allow organizes, and it asks once`, async () => {
    test.setTimeout(120_000);
    const words = CASES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, 1440, 900);
      await (await core(window)).evaluate(async (bridge, chosen) => {
        await bridge.updateSettings({ user: { language: chosen } });
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
      }, language);
      const paths: string[] = [];
      for (let index = 1; index <= 3; index++) {
        const path = join(sources, `Harbour survey ${index}.md`);
        await writeFile(path, `# Harbour survey ${index}\n\nThe berth depth at the north quay.\n`);
        paths.push(path);
      }
      await addDocuments(window, paths);
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library");
      const organize = library.getByTestId("library-organize");
      const card = library.getByTestId("library-organize-consent");

      // A model is set up, so the press asks for Anthropic in the card's own words.
      await pointAndClick(window, organize);
      await expect(card).toBeVisible();
      await expect(card).toContainText(words.title);
      await expect(card.getByTestId("library-organize-sends")).toHaveText(words.sends);
      await expect(card.getByTestId("library-organize-allow")).toHaveText(words.allow);
      await expect(card.getByTestId("library-organize-dismiss")).toHaveText(words.notNow);
      await expect(card.getByTestId("library-organize-declined")).toHaveCount(0);
      await expect(library.getByTestId("library-organize-needs-model")).toHaveCount(0);
      await expect(library).not.toContainText(words.needsModel);
      expect(await modelRequests(window)).toBe(0);

      // Not now: nothing reached Anthropic, nothing was recorded, nothing waits to be confirmed.
      await pointAndClick(window, card.getByTestId("library-organize-dismiss"));
      await expect(card).toHaveCount(0);
      expect(await modelRequests(window)).toBe(0);
      expect(await consent(window)).toBe("not-asked");
      await expect(window.getByTestId("organize-waiting")).toHaveCount(0);

      // ⌘K's Organize reaches the same card, which takes the focus.
      await runCommand(window, "library.organize", translate(language, "library.organize"));
      await expect(card).toBeFocused();
      await expect(card.getByTestId("library-organize-sends")).toHaveText(words.sends);
      // Esc is Not now.
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      expect(await consent(window)).toBe("not-asked");
      expect(await modelRequests(window)).toBe(0);
      await pointAndClick(window, organize);
      await expect(card).toBeFocused();
      await window.keyboard.press("Tab");
      await expect(card.getByTestId("library-organize-dismiss")).toBeFocused();
      await window.keyboard.press("Tab");
      await expect(card.getByTestId("library-organize-allow")).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(card).toHaveCount(0);
      const review = window.getByTestId("organize-review");
      await expect(review).toBeVisible({ timeout: 60_000 });
      await expect(review.getByTestId("organize-review-card-name")).toHaveText(["Harbour"]);
      await expect(review.getByTestId("organize-review-row")).toHaveCount(3);
      expect(await consent(window)).toBe("accepted");
      const sent = await modelRequests(window);
      expect(sent).toBeGreaterThan(0);

      // Set aside, the Documents are in no Folder again: a second press runs at once.
      await pointAndClick(window, review.getByTestId("organize-review-menu"));
      await pointAndClick(window, window.getByTestId("organize-review-discard"));
      await expect(review).toHaveCount(0);
      await pointAndClick(window, organize);
      await expect(review).toBeVisible({ timeout: 60_000 });
      await expect(card).toHaveCount(0);
      expect(await modelRequests(window)).toBeGreaterThan(sent);
    } finally {
      await app.close();
    }
  });
}
