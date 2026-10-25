import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ConversationAnswer } from "../src/core/api";
import { xlsxOf } from "../tests/helpers/office";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  assistantAnswers,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * Answers that run an Analysis (#447): asked for revenue by region over a workbook, the scripted
 * model runs Python over the whole sheet in the real sandbox (ADR-0023), and the Answer shows the
 * table and total it gave, with a step that says so. The conversation keeps the Analysis.
 */

const SALES = xlsxOf([
  {
    name: "Sales",
    rows: [
      ["Region", "Quarter", "Revenue"],
      ["North", "2026Q1", 120],
      ["North", "2026Q2", 150.5],
      ["South", "2026Q1", 80],
      ["East", "2026Q1", 60],
      ["West", "2026Q1", 40],
    ],
  },
]);

const REGIONS = xlsxOf([
  {
    name: "Regions",
    rows: [
      ["Region", "Manager"],
      ["North", "Ana"],
      ["South", "Bo"],
      ["Central", "Chen"],
    ],
  },
]);

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

async function launchWithSheets(language: "en" | "zh-CN" = "en", width = 1600) {
  const launched = await launchApp(dataDir, { fakeChat: true, sandboxed: true });
  const { app, window } = launched;
  await setWindowSize(app, window, width, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (
      globalThis as unknown as {
        incarnamind: { saveChatProvider(input: unknown): Promise<unknown> };
      }
    ).incarnamind;
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
  });
  await (await coreOf(window)).evaluate(
    (bridge, language) => bridge.updateSettings({ user: { language } }),
    language,
  );
  await writeFile(join(sources, "Sales 2026.xlsx"), SALES);
  await writeFile(join(sources, "Regions.xlsx"), REGIONS);
  await addDocuments(window, [join(sources, "Sales 2026.xlsx"), join(sources, "Regions.xlsx")]);
  for (const name of ["Sales 2026", "Regions"]) {
    await expect(
      window.getByTestId("document-list-item").filter({ hasText: name }).first(),
    ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  }
  await newMind(window);
  return launched;
}

async function storedAnswer(window: Page): Promise<ConversationAnswer> {
  const core = await coreOf(window);
  return core.evaluate(async (bridge) => {
    const [latest] = await bridge.listConversations();
    if (!latest) throw new Error("No conversation.");
    const { messages } = await bridge.getConversation(latest.id);
    const answer = messages.findLast((message) => message.kind === "answer");
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    return answer;
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600]) {
    test(`${language} ${width}: real Python gives the revenue table and total, with its step and retained conversation`, async () => {
      test.setTimeout(180_000);
      const { app, window } = await launchWithSheets(language, width);
      const evidence = process.env.INCARNAMIND_ANALYSIS_EVIDENCE_DIR;
      let closed = false;
      try {
        if (evidence)
          await window.screenshot({ path: join(evidence, `${language}-${width}-before.png`) });
        const answer = await askInAssistant(
          window,
          language === "en" ? "What was revenue by region?" : "按地区汇总 Revenue",
          { timeout: 60_000 },
        );

        const text = answer.getByTestId("assistant-answer-text");
        await expect(text.locator("table")).toHaveCount(1);
        await expect(text.locator("table tr")).toHaveCount(5);
        await expect(text.locator("table")).toContainText("North");
        await expect(text.locator("table")).toContainText("270.5");
        await expect(text).toContainText(language === "en" ? "In total, 450.5" : "合计 450.5");
        await expect(text).not.toContainText("[=");
        const timeline = await openSteps(window, answer);
        await expect(timeline.getByTestId("answer-analysis-call")).toHaveText(
          language === "en" ? "Ran an analysis on Sales 2026" : "对“Sales 2026”运行了数据分析",
        );
        expect(
          await answer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);

        const stored = await storedAnswer(window);
        expect(stored.analyses).toHaveLength(1);
        expect(stored.analyses[0]).toMatchObject({
          number: 1,
          end: { kind: "done" },
          inputs: [{ kind: "range", name: "sales", range: "A1:C6", rows: 5, columns: 3 }],
          versions: { language: "python", languageVersion: "3.14.2" },
        });
        expect(stored.figures).toEqual([
          expect.objectContaining({ value: 450.5, analysis: { analysis: 1, result: "total" } }),
        ]);
        if (evidence)
          await window.screenshot({ path: join(evidence, `${language}-${width}-after.png`) });
        await app.close();
        closed = true;
        const reopened = await launchApp(dataDir, { fakeChat: true, sandboxed: true });
        try {
          await setWindowSize(reopened.app, reopened.window, width, 900);
          expect((await storedAnswer(reopened.window)).analyses).toEqual(stored.analyses);
        } finally {
          await reopened.app.close();
        }
      } finally {
        if (!closed) await app.close();
      }
    });
  }
}

test("an Analysis that joins two sheets reports the rows that matched and those that didn't", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchWithSheets();

  await askInAssistant(window, "Revenue by region, with each region's manager", {
    timeout: 60_000,
  });

  const [analysis] = (await storedAnswer(window)).analyses;
  expect(analysis?.inputs.map((input) => input.name)).toEqual(["sales", "regions"]);
  expect(analysis?.output.merges).toEqual([
    expect.objectContaining({
      how: "left",
      leftRows: 5,
      rightRows: 3,
      matched: 3,
      leftOnly: 2,
      rightOnly: 1,
    }),
  ]);
  await app.close();
});

test("⌘K Analyse data… marks the next Question with a chip; the Question asked with it keeps it, and Esc takes a chip back", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchWithSheets();
  const chip = window.getByTestId("composer-analyse");
  const analyseData = async () => {
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("Analyse data");
    await window.keyboard.press("Enter");
    await expect(chip).toHaveText("Analyse data");
    await expect(window.getByTestId("composer-input")).toBeFocused();
  };

  await analyseData();
  await window.keyboard.type("What was revenue by region?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 60_000,
  });
  await expect(chip).toHaveCount(0);
  const asked = await (await coreOf(window)).evaluate(async (bridge) => {
    const [latest] = await bridge.listConversations();
    const { messages } = await bridge.getConversation(latest?.id ?? "");
    return messages.findLast((message) => message.kind === "question");
  });
  expect(asked).toMatchObject({ kind: "question", analyse: true });

  await pointAndClick(window, window.getByTestId("mind-editor"));
  await analyseData();
  await window.keyboard.press("Escape");
  await expect(chip).toHaveCount(0);
  await app.close();
});
