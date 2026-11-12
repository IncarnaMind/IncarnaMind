import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Check that asks on the Note (#2252): the assistant's card line follows the User's answer, and
 * only an answer changes it. An outside click closes the card but keeps the question, which the
 * badge reopens; Esc, the badge's × and the Note closing settle it as closed; Not now declines it.
 */

const WAITING_EN = "The check starts when you confirm it on the note.";
const DECLINED_EN = "The check didn’t run: you chose Not now on the note.";
const CLOSED_EN = "The check didn’t run: the question on the note was closed.";
const WAITING_ZH = "在笔记里确认后，核对才会开始。";
const DECLINED_ZH = "核对未开始：你在笔记里选择了“暂不”。";

test("a Check's question changes the assistant card line, EN and ZH", async () => {
  test.setTimeout(180_000);
  const dataDir = await createDataFolder();
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1440, 900);
    const file = join(sources, "Tides.md");
    await writeFile(file, "# Tides\n\nSpring tides follow new and full moons.\n");
    await addDocuments(window, [file]);
    await newMind(window);
    await nameMind(window, "Deal notes");
    await window.keyboard.type("Spring tides follow new moons.");
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
      await core.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
    });

    const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
    const first = await askInAssistant(window, "Check this Note");
    await expect(ask).toBeVisible();
    await expect(first).toContainText(WAITING_EN);

    // A click into the page closes the card and keeps the question. The badge reopens it, the same
    // question with its price.
    await pointAndClick(window, window.getByTestId("mind-editor"));
    await expect(ask).toHaveCount(0);
    await expect(first).toContainText(WAITING_EN);
    await pointAndClick(window, window.getByTestId("check-badge-open"));
    await expect(ask).toContainText("Check 1 sentence in this note against your Documents?");
    await expect(ask).toContainText("Under $0.01");
    await expect(ask.getByTestId("estimate-price")).toHaveAccessibleDescription(
      /^Estimate from Anthropic’s price, checked \d{1,2}\s\w+\s\d{4}$/,
    );
    await expect(ask.getByTestId("estimate-price")).not.toHaveAttribute("title", /.+/);
    await expect(ask.getByTestId("estimate-pricing")).toHaveText("Pricing ↗");

    // Esc closes the question.
    await window.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(first).toContainText(CLOSED_EN);

    // Not now declines it.
    const declined = await askInAssistant(window, "Check this Note");
    await expect(ask).toBeVisible();
    await pointAndClick(window, ask.getByTestId("mind-check-cancel"));
    await expect(declined).toContainText(DECLINED_EN);

    // The badge's × closes the question too.
    const toggled = await askInAssistant(window, "Check this Note");
    await expect(ask).toBeVisible();
    await pointAndClick(window, window.getByTestId("check-badge-open"));
    await expect(ask).toHaveCount(0);
    await expect(toggled).toContainText(CLOSED_EN);

    // The same, in Chinese.
    await setLanguage(window, "zh-CN");
    const zh = await askInAssistant(window, "Check this Note");
    await expect(ask).toBeVisible();
    await expect(zh).toContainText(WAITING_ZH);
    await pointAndClick(window, ask.getByTestId("mind-check-cancel"));
    await expect(zh).toContainText(DECLINED_ZH);
  } finally {
    await app.close();
    await removeDataFolder(dataDir);
    await removeDataFolder(sources);
  }
});
