import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ConversationAnswer } from "../src/core/api";
import { translate } from "../src/shared/i18n";
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
  pointAt,
  removeDataFolder,
  setWindowSize,
} from "./app";

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

/**
 * A test workbook of monthly ad spend and revenue: revenue grows with spend and with time, and
 * row 7's revenue isn't a number.
 */
const MARKETING = xlsxOf([
  {
    name: "Marketing",
    rows: [
      ["Month", "Region", "AdSpend", "Revenue"],
      ...Array.from({ length: 24 }, (_, at) => {
        const spend = 10 + (at % 7) * 2.5;
        const revenue =
          Math.round((50 + 3.2 * spend + 4 * Math.sin(at / 2) + at * 0.8) * 100) / 100;
        return [
          `${2024 + Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`,
          ["North", "South", "East"][at % 3] ?? "",
          spend,
          at === 5 ? "n/a" : revenue,
        ];
      }),
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

async function launchWithSheets(language: "en" | "zh-CN" = "en", width = 1600, sandboxed = true) {
  const launched = await launchApp(dataDir, {
    fakeChat: true,
    sandboxed,
    sandboxNotice: sandboxed ? undefined : "switch",
  });
  const { app, window } = launched;
  await setWindowSize(app, window, width, 660);
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
  await writeFile(join(sources, "Marketing 2026.xlsx"), MARKETING);
  await addDocuments(window, [
    join(sources, "Sales 2026.xlsx"),
    join(sources, "Regions.xlsx"),
    join(sources, "Marketing 2026.xlsx"),
  ]);
  for (const name of ["Sales 2026", "Regions", "Marketing 2026"]) {
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

test("an Answer does not offer Analysis when the app's sandbox is off", async () => {
  const { app, window } = await launchWithSheets("en", 1600, false);
  try {
    await askInAssistant(window, "What was revenue by region?");
    const answer = await storedAnswer(window);
    expect(answer.analyses).toEqual([]);
    expect(answer.toolCalls.some((call) => call.tool === "run_analysis")).toBe(false);
  } finally {
    await app.close();
  }
});

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
          await setWindowSize(reopened.app, reopened.window, width, 660);
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

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: a regression's plot is a picture in its Answer, and each figure's card names the rows it came from, beside its code`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    const { app, window } = await launchWithSheets(language, 1200);
    const evidence = process.env.INCARNAMIND_ANALYSIS_EVIDENCE_DIR;
    try {
      const answer = await askInAssistant(
        window,
        language === "en"
          ? "How does Revenue grow with ad spend (AdSpend)?"
          : "Revenue 随广告投入（AdSpend）如何变化？",
        { timeout: 120_000 },
      );
      const text = answer.getByTestId("assistant-answer-text");
      const picture = text.getByRole("img", { name: "Revenue against ad spend" });
      await expect(picture).toBeVisible();
      await expect(picture).toHaveAttribute("src", /^data:image\/png;base64,iVBORw0KGgo/);
      const drawn = await picture.evaluate((image: HTMLImageElement) => ({
        loaded: image.complete && image.naturalWidth > 0,
        sharp: image.naturalWidth >= image.getBoundingClientRect().width * 1.5,
        fits:
          image.getBoundingClientRect().right <=
          (image.closest("[data-testid=assistant-answer]")?.getBoundingClientRect().right ?? 0) + 1,
      }));
      expect(drawn).toEqual({ loaded: true, sharp: true, fits: true });
      await expect(text).not.toContainText("[=");
      if (evidence) {
        await picture.scrollIntoViewIfNeeded();
        await window.screenshot({ path: join(evidence, `${language}-picture-wide.png`) });
        await setWindowSize(app, window, 900, 660);
        await picture.scrollIntoViewIfNeeded();
        await window.screenshot({ path: join(evidence, `${language}-picture-narrow.png`) });
        await setWindowSize(app, window, 1200, 660);
      }

      const markers = text.getByTestId("calculated-figure-marker");
      await expect(markers).toHaveCount(2);
      const card = window.locator(".calculated-figure-card");
      await pointAt(window, markers.nth(1));
      await expect(card.getByTestId("calculated-figure-rows")).toContainText(
        language === "en"
          ? "Sum of Revenue in 23 rows of marketing: rows 2–6, 8–25"
          : "“marketing”第 2–6、8–25 行中 Revenue 的合计（共 23 行）",
      );
      await expect(card).toContainText(t("figures.analysisRows.recalculated"));
      await expect(card.locator(".calculated-figure-state")).toContainText(
        t("figures.inline.retained"),
      );
      // The core worked this figure out again from its cells: its check is shown, not left grey.
      await expect(card.locator(".calculated-figure-state")).toContainText(
        t("claim.state.supported"),
      );
      await expect(card.locator(".calculated-figure-state")).toHaveAttribute(
        "data-state",
        "supported",
      );
      // The inline figure says what its card says: the state is worked out once (#2378).
      await expect(markers.nth(1).locator("xpath=..")).toHaveAttribute("data-state", "supported");
      if (evidence) {
        await expect(card).toHaveCSS("opacity", "1");
        await window.screenshot({ path: join(evidence, `${language}-total-card.png`) });
      }
      await window.mouse.move(0, 0);
      await expect(card).toBeHidden();

      await markers.nth(0).focus();
      await window.keyboard.press("Enter");
      await expect(card.getByTestId("calculated-figure-rows")).toContainText(
        language === "en"
          ? "Worked out from 23 rows of marketing: rows 2–6, 8–25, using AdSpend, Revenue"
          : "根据“marketing”第 2–6、8–25 行（共 23 行）计算，用到 AdSpend、Revenue",
      );
      await expect(card).not.toContainText(t("figures.analysisRows.recalculated"));
      // A figure the app didn't work out again is never shown as checked.
      await expect(card.locator(".calculated-figure-state")).toContainText(
        t("claim.state.not-checked"),
      );
      await expect(card.locator(".calculated-figure-state")).not.toContainText(
        t("claim.state.supported"),
      );
      await expect(markers.nth(0).locator("xpath=..")).toHaveAttribute("data-state", "not-checked");
      await expect(card.locator(".calculated-figure-input")).toHaveCount(2);
      await pointAndClick(window, card.locator(".calculated-figure-code summary"));
      await expect(card.locator(".calculated-figure-code pre")).toContainText("smf.ols");
      if (evidence) {
        await expect(card).toHaveCSS("opacity", "1");
        await window.screenshot({ path: join(evidence, `${language}-slope-card.png`) });
      }
      await window.keyboard.press("Escape");
      await expect(card).toBeHidden();

      const [analysis] = (await storedAnswer(window)).analyses;
      expect(analysis?.versions?.packages).toMatchObject({
        statsmodels: "0.14.6",
        matplotlib: "3.10.8",
      });
      expect(analysis?.recalculations).toEqual([
        { result: "total", check: { kind: "same", value: expect.any(Number) } },
      ]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: [=table 1] writes the Analysis's own table into a Note, its figures cited to the rows it read`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchWithSheets(language, 1200);
    try {
      await askInAssistant(
        window,
        language === "en"
          ? "What was revenue by region? Put the table in the note."
          : "按地区汇总 Revenue，把表格写进笔记。",
        { timeout: 120_000 },
      );
      const editor = window.getByTestId("mind-editor");
      const table = editor.locator("table");
      await expect(table).toHaveCount(1);
      await expect(table).toContainText("North");
      await expect(table).toContainText("270.5");
      await expect(table).toContainText("South");
      await expect(editor).not.toContainText("[=table");
      // The table's figures cite the rows the Analysis read, not text typed again.
      const citation = table.locator("tr").first().locator("th").nth(1).getByTestId("citation");
      await expect(citation).toHaveCount(1);
      await expect(citation).toHaveAttribute("data-check", "found");
      // A heading cell names its column; it is no claim, so the Note has nothing needing a look.
      const badge = window.getByTestId("check-badge");
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).not.toHaveAttribute("data-state", "needs-look");
      await expect(badge.locator(".check-badge-words")).not.toContainText(
        language === "en" ? "needs a look" : "需要留意",
      );
      const evidence = process.env.INCARNAMIND_ANALYSIS_EVIDENCE_DIR;
      if (evidence) await window.screenshot({ path: join(evidence, `${language}-note-table.png`) });
    } finally {
      await app.close();
    }
  });
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

for (const entry of ["palette", "slash"] as const) {
  test(`${entry}: an open Research plan keeps its draft and does not offer Analysis until closed`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchWithSheets();
    try {
      await window.keyboard.press("ControlOrMeta+k");
      await window.getByTestId("palette-search").fill(">Analyse data");
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("composer-analyse")).toBeVisible();
      await expect(window.getByTestId("composer-input")).toBeFocused();
      if (entry === "palette") {
        await window.keyboard.press("ControlOrMeta+k");
        await window.getByTestId("palette-search").fill(">Research");
        await window.keyboard.press("Enter");
      } else {
        await window.keyboard.type("/res");
        await expect(window.getByTestId("slash-item-research")).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await window.keyboard.press("Enter");
      }
      await expect(window.getByTestId("composer-research")).toBeVisible();
      await window.getByTestId("composer-input").fill("Revenue by region");
      await window.keyboard.press("Enter");
      const plan = window.getByTestId("research-plan");
      await expect(plan).toBeVisible();
      await expect(window.getByTestId("composer-analyse")).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+k");
      await window.getByTestId("palette-search").fill(">Analyse data");
      await expect(window.getByTestId("palette-empty")).toBeVisible();
      await expect(window.locator('[data-key="command:analysis.start"]')).toHaveCount(0);
      await window.keyboard.press("Escape");
      await expect(plan).toBeVisible();
      await window.getByTestId("research-plan-cancel").click();
      await expect(plan).toHaveCount(0);
      await expect(window.getByTestId("composer-input")).toHaveValue("Revenue by region");
      await window.keyboard.press("ControlOrMeta+k");
      await window.getByTestId("palette-search").fill(">Analyse data");
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("composer-analyse")).toBeVisible();
      await expect(window.getByTestId("composer-research")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("a palette Question leaves the composer's Analysis choice for its own next Question", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchWithSheets();
  try {
    await window.keyboard.press("ControlOrMeta+k");
    await window.getByTestId("palette-search").fill(">Analyse data");
    await window.keyboard.press("Enter");
    const chip = window.getByTestId("composer-analyse");
    await expect(chip).toBeVisible();
    await window.getByTestId("composer-input").fill("Keep this draft");
    const question = "What was revenue by region?";
    await window.keyboard.press("ControlOrMeta+k");
    await window.getByTestId("palette-search").fill(question);
    await expect(window.getByTestId("palette-searching")).toHaveCount(0);
    const rows = window.getByTestId("palette").getByTestId("palette-item");
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ArrowUp");
    await expect(window.locator('[data-testid="palette-item"][data-key="ask"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await window.keyboard.press("Enter");
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
      timeout: 60_000,
    });
    const asked = await (await coreOf(window)).evaluate(async (bridge) => {
      const [latest] = await bridge.listConversations();
      const { messages } = await bridge.getConversation(latest?.id ?? "");
      return messages.find((message) => message.kind === "question");
    });
    expect(asked).toMatchObject({ kind: "question", text: question, analyse: false });
    await expect(chip).toBeVisible();
    await expect(window.getByTestId("composer-input")).toHaveValue("Keep this draft");
  } finally {
    await app.close();
  }
});
