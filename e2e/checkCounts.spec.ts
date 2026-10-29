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
 * sentences · Check" count every claim a check reads, a table's cells among
 * them; the one Check (#1941) closes the count to 0 for the whole Note. The scripted model writes a table of the Document's
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
    line: "Checked 12 sentences · 10 claims not checked yet",
    lineAfter: "· 0 claims not checked yet",
    rest: "Check",
    badgeWords: "Not checked",
    badgeName: "Not checked",
    afterBadgeWords: "1 needs a look",
    afterBadgeName: "1 needs a look",
    toCheck: "11 claims not checked yet",
    tableCells: "10 table cells",
    found: "22 Citations found",
    unsupported: "1 claim needs a look",
    ask: "Check this note’s 11 claims against your Documents?",
    notNow: "Not now",
    uncited: "1 claim supported · 1 claim with no Citation",
  },
  "zh-CN": {
    request: "添加核对用的收入表格",
    line: "已核对 12 句 · 10 条说法待核对",
    lineAfter: "· 0 条说法待核对",
    rest: "核对",
    badgeWords: "未核对",
    badgeName: "未核对",
    afterBadgeWords: "需要留意 1 处",
    afterBadgeName: "需要留意 1 处",
    toCheck: "11 条说法待核对",
    tableCells: "10 个表格单元格",
    found: "22 处引用已找到",
    unsupported: "1 条说法需要留意",
    ask: "要对照你的文档，核对这篇笔记中的 11 条说法吗？",
    notNow: "暂不",
    uncited: "1 条说法有依据 · 1 条说法没有引用",
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
  test(`the badge, its card, the check prompt and the Answer's line count the same 22 sentences, and Check closes them (${language})`, async () => {
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
    // The Mind's own old text, with no Citation: this write's line must not check it.
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("The harbour is quiet in winter.");
    await expect(editor).toContainText("The harbour is quiet in winter.");

    const answer = await askInAssistant(window, words.request);
    // Its check ran before the reply: the 12 cited claims it checked are covered, 10 are left.
    const line = answer.getByTestId("self-check-left");
    await expect(line).toContainText(words.line, { timeout: 120_000 });
    const badge = window.getByTestId("check-badge");
    await expect(window.getByTestId("check-badge-open")).toHaveAccessibleName(
      new RegExp(words.badgeName),
    );
    await expect(badge.locator(".check-badge-words")).toHaveText(words.badgeWords);
    await screenshot(window, `check-counts-line-${language}`);

    // Its card counts the same 11 (the old text too), and says the write's 10 are table cells.
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

    // The check prompt asks with the same 11; Not now leaves the work to the Answer's line.
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    const ask = card.getByTestId("mind-check-ask");
    await expect(ask).toContainText(words.ask);
    await screenshot(window, `check-counts-ask-${language}`);
    await pointAndClick(window, ask.getByTestId("mind-check-cancel"));
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // The one Check checks every sentence left, the uncited claims and the Note's own old text
    // included: it asks first, as it does from the badge, and the count closes.
    await expect(answer.getByTestId("self-check-left-action")).toHaveText(words.rest);
    await pointAndClick(window, answer.getByTestId("self-check-left-action"));
    const restAsk = (await checkCard(window)).getByTestId("mind-check-ask");
    await expect(restAsk).toBeVisible();
    await pointAndClick(window, restAsk.getByTestId("mind-check-check"));
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 120_000 });
    // This write's line closes at 0, and the Note's old text was checked with it (#1909, #1941).
    await expect(answer.getByTestId("self-check-left")).toContainText(words.lineAfter);
    await expect(answer.getByTestId("self-check-left-action")).toHaveCount(0);
    const done = await checkCard(window);
    await expect(done.getByTestId("health-toCheck")).toHaveCount(0);
    // What needs a look still shows, so the card never says everything is checked (#1909): every
    // cell is Supported, each figure bound to the row its label names, after the write as after
    // the Check (#1459), and the Note's old sentence with no Citation needs a look.
    await expect(done.getByTestId("health-unsupported")).toContainText(words.unsupported);
    await expect(done.getByTestId("health-all-checked")).toHaveCount(0);
    await expect(window.getByTestId("check-badge-open")).toHaveAccessibleName(
      new RegExp(words.afterBadgeName),
    );
    await expect(badge.locator(".check-badge-words")).toHaveText(words.afterBadgeWords);
    await screenshot(window, `check-counts-done-${language}`);
    await window.keyboard.press("Escape");
    await expect(done).toHaveCount(0);

    // A clean check: one sentence the Documents support, still to cite, so the card names that (#1941).
    await newMind(window);
    const clean = window.getByTestId("mind-editor");
    await clean.click();
    await window.keyboard.type("Revenue in Q1 was €1 million.");
    await expect(clean).toContainText("Revenue in Q1");
    const cleanCard = await checkCard(window);
    await pointAndClick(window, cleanCard.getByTestId("badge-check-mind"));
    await pointAndClick(
      window,
      cleanCard.getByTestId("mind-check-ask").getByTestId("mind-check-check"),
    );
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 120_000 });
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported");
    const allDone = await checkCard(window);
    await expect(allDone.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(allDone.getByTestId("health-unsupported")).toHaveCount(0);
    await expect(allDone.getByTestId("health-all-checked")).toHaveCount(0);
    await expect(allDone.getByTestId("health-summary")).toContainText(words.uncited);
    await screenshot(window, `check-counts-all-${language}`);
    await app.close();
  });
}
