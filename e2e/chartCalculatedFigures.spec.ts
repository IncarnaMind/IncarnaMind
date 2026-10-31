import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { xlsxOf } from "../tests/helpers/office";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A chart of calculated figures (#2307): asked for each region's total revenue and growth from a
 * workbook, with a chart, the scripted model calculates each total and growth from cells it cites
 * and adds them as a table and its chart, the totals' cells citing their rows beside the figure.
 * Each bar shows its figure's formula and every Input with its own Citation, never one cell with
 * a check; the foot counts the values as calculated from the cells, not as quoted; and the
 * Answer in the assistant shows the same figures with their working. English and Chinese.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const shot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const quarter = (rows: [string, number, number][]) => [
  ["Region", "Units sold", "Revenue (USD)"],
  ...rows,
];

const SALES = xlsxOf([
  {
    name: "Q1 2026",
    rows: quarter([
      ["North", 1240, 22940],
      ["South", 980, 18130],
      ["East", 1415, 25330],
      ["West", 760, 14590],
    ]),
  },
  {
    name: "Q2 2026",
    rows: quarter([
      ["North", 1270, 23510],
      ["South", 1065, 19720],
      ["East", 1390, 25010],
      ["West", 905, 17330],
    ]),
  },
  {
    name: "Q3 2026",
    rows: quarter([
      ["North", 1250, 24010],
      ["South", 1090, 21000],
      ["East", 1420, 26200],
      ["West", 1030, 20610],
    ]),
  },
]);

const REGIONS = ["North", "South", "East", "West"];

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

const point = (chart: Locator, row: number, series: number) =>
  chart.locator(`[data-testid="chart-point"][data-point="${row}:${series}"]`);

for (const [language, question] of [
  ["en", "What is each region's total revenue and growth from Q1 to Q3? Draw a bar chart."],
  ["zh-CN", "各地区的总收入和增长是多少？画一个柱状图。"],
] as const) {
  test(`each bar of a chart of calculated figures shows its formula and every cited Input (${language})`, async () => {
    test.setTimeout(240_000);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    await writeFile(join(sources, "Regional sales 2026.xlsx"), SALES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
      });
      await addDocuments(window, [join(sources, "Regional sales 2026.xlsx")]);
      await setLanguage(window, language);
      await newMind(window);

      const answer = await askInAssistant(window, question, { timeout: 90_000 });

      const editor = window.getByTestId("mind-editor");
      await expect(editor.locator("table")).toHaveCount(1);
      await expect(editor.getByTestId("calculated-figure")).toHaveCount(8);
      const chart = editor.getByTestId("chart");
      await expect(chart).toHaveCount(1);
      await expect(chart.getByTestId("chart-point")).toHaveCount(8);

      // The foot counts them as calculated from the cells they read, not as each quoted.
      const cells = t("chart.inputs.cells.other", { count: 12 });
      await expect(chart.getByTestId("chart-source")).toHaveText(
        t("chart.source.calculated.other", {
          count: 8,
          inputs: cells,
          document: "Regional sales 2026",
        }),
      );

      // Each bar's card is its figure's: the formula and every Input with its own Citation.
      const card = window.getByTestId("chart-card");
      for (const [series, inputs] of [
        [0, 3],
        [1, 2],
      ] as const) {
        for (const [row, region] of REGIONS.entries()) {
          const bar = point(chart, row, series);
          await expect(bar).toHaveAttribute(
            "aria-label",
            new RegExp(
              t("chart.point.calculated", {
                inputs: t("chart.inputs.cells.other", { count: inputs }),
                document: "Regional sales 2026",
              }),
            ),
          );
          await pointAndClick(window, bar);
          await expect(card).toBeVisible();
          await expect(card.getByTestId("chart-card-body")).toContainText(region);
          const figure = card.getByTestId("chart-card-figure");
          await expect(figure).toContainText(t("figures.calculated"));
          await expect(figure.locator(".calculated-figure-formula")).toBeVisible();
          await expect(figure.locator(".calculated-figure-input")).toHaveCount(inputs);
          // Never one cell's Citation with a check, as if it held the figure.
          await expect(card.getByTestId("chart-card-source")).toHaveCount(0);
          await expect(card.getByTestId("chart-card-open")).toHaveCount(0);
          if (row === 3) await shot(window, `chart-calculated-${series}-${language}`);
          await window.keyboard.press("Escape");
          await expect(card).toHaveCount(0);
        }
      }

      // The Answer in the assistant shows the same figures, each with its working.
      const figures = answer.getByTestId("calculated-figure");
      await expect(figures).toHaveCount(5);
      await pointAt(window, answer.getByTestId("calculated-figure-marker").nth(3));
      const working = window.locator(".calculated-figure-card");
      await expect(working).toBeVisible();
      await expect(working.locator(".calculated-figure-formula")).toBeVisible();
      await expect(working.locator(".calculated-figure-input")).toHaveCount(3);
      await shot(window, `answer-calculated-${language}`);
    } finally {
      await app.close();
    }
  });
}
