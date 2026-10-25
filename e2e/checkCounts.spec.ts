import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The one count of sentences to check (#1909): the corner badge, its card,
 * the check prompt and the line under the Answer that says "Checked 12 of 22
 * sentences · Check the rest" count every claim a check reads, a table's
 * cells among them; Check the rest closes the count to 0, and the card says
 * "Everything checked". The scripted model writes a table of the Document's
 * 22 revenue lines, every cell a claim, and checks each sentence against its
 * line. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

/** Twenty-two quarterly revenue lines, each a claim a table cell repeats. */
const REPORT = [
  "# Annual report",
  "",
  ...Array.from(
    { length: 22 },
    (_, index) => `Revenue in Q${index + 1} was €${index + 1} million.`,
  ),
].join("\n\n");

const WORDS = {
  en: {
    request: "Add a revenue table for checking",
    line: "Checked 12 of 22 sentences",
    rest: "Check the rest",
    badgeWords: "to check",
    toCheck: "10 claims not checked yet",
    tableCells: "10 table cells",
    found: "22 Citations found",
    ask: "Check this Mind’s 10 claims against your Documents?",
    notNow: "Not now",
    allChecked: "Everything checked",
  },
  "zh-CN": {
    request: "添加核对用的收入表格",
    line: "已核对 22 句中的 12 句",
    rest: "核对其余",
    badgeWords: "条待核对",
    toCheck: "10 条说法待核对",
    tableCells: "10 个表格单元格",
    found: "22 处引用已找到",
    ask: "要对照你的文档，核对这个 Mind 中的 10 条说法吗？",
    notNow: "暂不",
    allChecked: "已全部核对",
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

/** A model billed per token, whose requests the cost meter counts, with the checks allowed to use it. */
async function useCloudChatModel(window: Page) {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) {
      for (const flow of ["chat", "tagging", "checks"] as const) {
        await core.allowDataFlow(flow, provider.service.id);
      }
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the badge, its card, the check prompt and the Answer's line count the same 22 sentences, and Check the rest closes them (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Annual report.md"), REPORT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await useCloudChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);

    const answer = await askInAssistant(window, words.request);
    // Its check ran before the reply: 12 of the 22 claims it wrote were checked, 10 are left.
    const line = answer.getByTestId("self-check-capped");
    await expect(line).toContainText(words.line, { timeout: 120_000 });
    const badge = window.getByTestId("check-badge");
    await expect(badge).toContainText("10");
    await expect(badge.locator(".check-badge-words")).toHaveText(words.badgeWords);
    await screenshot(window, `check-counts-line-${language}`);

    // Its card counts the same 10, and says they are table cells.
    const card = await checkCard(window);
    await expect(card.getByTestId("health-toCheck")).toContainText(words.toCheck);
    await expect(card.getByTestId("health-table-cells")).toContainText(words.tableCells);
    await expect(card.getByTestId("health-found")).toContainText(words.found);
    await expect(card.getByTestId("health-all-checked")).toHaveCount(0);
    await screenshot(window, `check-counts-card-${language}`);
    // The card holds at a narrow window too.
    await setWindowSize(app, window, 900, 720);
    await expect(card.getByTestId("health-toCheck")).toContainText(words.toCheck);
    await screenshot(window, `check-counts-card-${language}-narrow`);
    await setWindowSize(app, window, 1440, 900);
    await expect(card).toBeVisible();

    // The check prompt asks with the same 10; Not now leaves the work to the Answer's line.
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    const ask = card.getByTestId("mind-check-ask");
    await expect(ask).toContainText(words.ask);
    await screenshot(window, `check-counts-ask-${language}`);
    await pointAndClick(window, ask.getByTestId("mind-check-cancel"));
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // Check the rest checks every sentence left: the count closes, and the card says so plainly.
    await expect(answer.getByTestId("self-check-capped-action")).toHaveText(words.rest);
    await pointAndClick(window, answer.getByTestId("self-check-capped-action"));
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 120_000 });
    await expect(window.getByTestId("self-check-capped")).toHaveCount(0);
    await expect(badge.locator(".check-badge-words")).toHaveCount(0);
    const done = await checkCard(window);
    await expect(done.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(done.getByTestId("health-all-checked")).toContainText(words.allChecked);
    await screenshot(window, `check-counts-done-${language}`);
    await app.close();
  });
}
