/**
 * Lane #2084's acceptance run, not part of CI: the ready Question about a file added on a first
 * run, answered by claude-sonnet-5-5, with the example Mind read by nothing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  interceptOpenDialog,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

const SHOTS = resolve(__dirname, "../.claude/lane-2084-ready-question/shots");
const KEY = process.env.LANE_ANTHROPIC_KEY ?? "";
const MODEL = "claude-sonnet-5-5";

const RUNS = [
  {
    language: "en",
    name: "Harbour brief.md",
    text: "# Harbour brief\n\nThe harbour master publishes the tide tables every spring, after the winter dredging.\n",
    asks: "Ask: “What does ‘Harbour brief’ say?”",
    leaks: /Northwind|facilities agreement|leverage|EBITDA|贷款协议|杠杆|息税折旧/i,
  },
  {
    language: "zh-CN",
    name: "港口简报.md",
    text: "# 港口简报\n\n港口每月发布一次潮汐表，冬季疏浚之后更新。\n",
    asks: "提问：“‘港口简报’讲了什么？”",
    leaks: /Northwind|facilities agreement|leverage|EBITDA|贷款协议|杠杆|息税折旧/i,
  },
] as const;

for (const run of RUNS) {
  test(`Sonnet 5.5: the ready Question asks about the file just added, and reads no Mind (${run.language}, #2084)`, async () => {
    test.setTimeout(600_000);
    await mkdir(SHOTS, { recursive: true });
    const dataDir = await createDataFolder();
    const sources = await createDataFolder();
    const file = join(sources, run.name);
    await writeFile(file, run.text);
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, run.language);
      await window.evaluate(
        async ({ key, model }) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await bridge.saveChatProvider({ kind: "anthropic", apiKey: key, modelId: model });
        },
        { key: KEY, model: MODEL },
      );
      const files = step(window, "files");
      await expect(files).toHaveAttribute("data-state", "open");
      await interceptOpenDialog(app, file);
      await files.getByTestId("first-open-add-files").click();
      const ready = step(window, "question").getByTestId("first-open-ready");
      await expect(ready).toHaveText(run.asks, { timeout: 60_000 });
      await ready.click();
      const consent = window.getByTestId("consent-dialog");
      if (await consent.isVisible().catch(() => false)) {
        await consent.getByTestId("consent-allow").click();
      }
      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 300_000 });
      const text = await answer.getByTestId("assistant-answer-text").innerText();
      console.log(`[${run.language}] answer:\n${text}`);
      // No Mind was read: the Answer has no Mind line, and nothing of the example's comes through.
      await expect(answer.getByTestId("answer-steps-mind")).toHaveCount(0);
      expect(text).not.toMatch(run.leaks);
      expect(await answer.innerText()).not.toMatch(run.leaks);
      const chip = answer.getByTestId("citation-chip").first();
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await expect(chip).toHaveAttribute("data-check", "found");
      await chip.click();
      const card = window.getByTestId("citation-card");
      await expect(card.getByText(run.name.replace(/\.md$/, ""), { exact: true })).toBeVisible();
      console.log(`[${run.language}] citation: ${await card.innerText()}`);
      await window.screenshot({ path: join(SHOTS, `sonnet-answer-${run.language}-1440.png`) });
      await window.keyboard.press("Escape");
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 900);
        await window.screenshot({ path: join(SHOTS, `sonnet-answer-${run.language}-${width}.png`) });
      }
    } finally {
      await app.close();
      await removeDataFolder(dataDir);
      await removeDataFolder(sources);
    }
  });
}
