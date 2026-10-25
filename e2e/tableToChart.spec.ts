import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
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

// Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const WORDS = {
  en: {
    years: {
      head: ["Metric", "2023", "2024", "2025"],
      rows: [
        ["Revenue", "289.4", "301.2", "330.6"],
        ["Net income", "41.2", "45.0", "52.3"],
      ],
    },
    working: {
      head: ["Step", "Formula", "Result"],
      rows: [
        ["Revenue growth", "(377.9 − 330.6) ÷ 330.6", "14.3%"],
        ["Net margin", "41.2 ÷ 377.9", "10.9%"],
      ],
    },
    quantities: {
      head: ["Product", "Units sold"],
      rows: [
        ["A", "1899"],
        ["B", "2000"],
        ["C", "2100"],
      ],
    },
    mixed: {
      head: ["Quarter", "Gross margin", "Net debt / EBITDA"],
      rows: [
        ["Q1", "41.2%", "2.8 times"],
        ["Q2", "43.5%", "2.5 times"],
        ["Q3", "40.8%", "3.1 times"],
        ["Q4", "44.1%", "2.9 times"],
      ],
    },
    firstMetric: "Revenue",
    metrics: ["Revenue", "Net income"],
    years2: ["2023", "2024", "2025"],
    quarters: ["Q1", "Q2", "Q3", "Q4"],
    chartFromTable: "Chart from table",
    switch: "Switch rows and columns",
    rows: "Rows",
    lead: "Revenue by year",
    mixedLead: "Margin and leverage by quarter",
    unitPercent: "%",
    unitTimes: "times",
  },
  "zh-CN": {
    years: {
      head: ["指标", "2023年", "2024年", "2025年"],
      rows: [
        ["营业收入", "289.4", "301.2", "330.6"],
        ["净利润", "41.2", "45.0", "52.3"],
      ],
    },
    working: {
      head: ["步骤", "公式", "结果"],
      rows: [
        ["营业收入同比", "(377.9 − 330.6) ÷ 330.6", "14.3%"],
        ["净利率", "41.2 ÷ 377.9", "10.9%"],
      ],
    },
    quantities: {
      head: ["产品", "销量"],
      rows: [
        ["甲", "1899"],
        ["乙", "2000"],
        ["丙", "2100"],
      ],
    },
    mixed: {
      head: ["季度", "毛利率", "净负债 / EBITDA"],
      rows: [
        ["一季度", "41.2%", "2.8倍"],
        ["二季度", "43.5%", "2.5倍"],
        ["三季度", "40.8%", "3.1倍"],
        ["四季度", "44.1%", "2.9倍"],
      ],
    },
    firstMetric: "营业收入",
    metrics: ["营业收入", "净利润"],
    years2: ["2023年", "2024年", "2025年"],
    quarters: ["一季度", "二季度", "三季度", "四季度"],
    chartFromTable: "用表格生成图表",
    switch: "行列互换",
    rows: "数据行",
    lead: "按年度列出的营业收入",
    mixedLead: "各季度毛利率与杠杆",
    unitPercent: "%",
    unitTimes: "倍",
  },
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const tableHtml = (table: { head: readonly string[]; rows: readonly (readonly string[])[] }) =>
  `<table><tr>${table.head.map((each) => `<th>${each}</th>`).join("")}</tr>${table.rows
    .map((row) => `<tr>${row.map((each) => `<td>${each}</td>`).join("")}</tr>`)
    .join("")}</table>`;

async function mindWithTable(
  window: Page,
  lead: string,
  table: { head: readonly string[]; rows: readonly (readonly string[])[] },
) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type(lead);
  await window.keyboard.press("Enter");
  await window.evaluate((html) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "table");
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  }, tableHtml(table));
  const grid = editor.locator("table");
  await expect(grid.locator("tr")).toHaveCount(table.rows.length + 1);
  return { editor, grid };
}

const axisLabels = (chart: Locator) => chart.locator(".chart-axis").allTextContents();

const point = (chart: Locator, row: number, series: number) =>
  chart.locator(`[data-testid="chart-point"][data-point="${row}:${series}"]`);

const copyPayload = (editor: Locator) =>
  editor.evaluate((dom) => {
    const data = new DataTransfer();
    dom.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return { html: data.getData("text/html"), text: data.getData("text/plain") };
  });

for (const [language, width] of [
  ["en", 1600],
  ["zh-CN", 1100],
] as const) {
  test(`a table of years by metrics charts with the years on the x axis; Switch rows and columns swaps them and ⌘Z puts them back; copied as text it has the table once (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 660);
    const { editor, grid } = await mindWithTable(window, words.lead, words.years);

    await pointAndClick(window, grid.locator("td").filter({ hasText: words.firstMetric }));
    await pointAndClick(window, window.getByTestId("table-menu"));
    const chartItem = window.getByTestId("table-chart");
    await expect(chartItem).toHaveText(words.chartFromTable);
    await pointAndClick(window, chartItem);
    await expect(window.getByTestId("table-actions")).toBeHidden();
    const chart = editor.getByTestId("chart");
    await expect(chart).toHaveCount(1);
    await expect(chart.getByTestId("chart-point")).toHaveCount(6);
    // Columns of one unit share one chart.
    await expect(chart.getByTestId("chart-panel")).toHaveCount(1);

    expect(await axisLabels(chart)).toEqual(expect.arrayContaining([...words.years2]));
    await expect(chart.getByTestId("chart-legend")).toContainText(words.metrics[0]);
    await expect(chart.getByTestId("chart-legend")).toContainText(words.metrics[1]);
    await expect(point(chart, 0, 0)).toHaveAttribute(
      "aria-label",
      new RegExp(`^${words.years2[0]} · ${words.metrics[0]}`),
    );
    await screenshot(window, `table-chart-years-${language}-${width}`);

    await pointAndClick(window, chart.getByTestId("chart-kind"));
    const menu = window.getByTestId("chart-kind-menu");
    await expect(menu).toContainText(words.rows);
    const switchItem = menu.getByTestId("chart-switch");
    await expect(switchItem).toHaveText(words.switch);
    await pointAndClick(window, switchItem);
    await expect(menu).toBeHidden();
    await expect(chart.getByTestId("chart-point")).toHaveCount(6);
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.metrics]));
    expect(await axisLabels(chart)).not.toContain(words.years2[0]);
    await expect(chart.getByTestId("chart-legend")).toContainText(words.years2[0]);
    await expect(point(chart, 0, 0)).toHaveAttribute(
      "aria-label",
      new RegExp(`^${words.metrics[0]} · ${words.years2[0]}`),
    );
    await expect(chart.getByTestId("chart-changed")).toHaveCount(0);
    await screenshot(window, `table-chart-switched-${language}-${width}`);

    await expect(chart.getByTestId("chart-kind")).toBeFocused();
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.years2]));
    await expect(point(chart, 0, 0)).toHaveAttribute(
      "aria-label",
      new RegExp(`^${words.years2[0]} · ${words.metrics[0]}`),
    );

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette")).toBeVisible();
    await window.keyboard.type(words.switch);
    const command = window.locator('[data-testid="palette-item"][data-kind="command"]').first();
    await expect(command).toContainText(words.switch);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("palette")).toBeHidden();
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.metrics]));
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.years2]));

    const switchFromMenu = async () => {
      await chart.locator(".chart-head").click({ button: "right", position: { x: 4, y: 4 } });
      const actions = window.getByTestId("chart-actions");
      await expect(actions).toBeVisible();
      await pointAndClick(
        window,
        actions.getByRole("menuitem", { name: new RegExp(`^${words.switch}`) }),
      );
      await expect(actions).toBeHidden();
    };
    await switchFromMenu();
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.metrics]));
    await switchFromMenu();
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.years2]));
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.metrics]));
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => axisLabels(chart)).toEqual(expect.arrayContaining([...words.years2]));
    await expect(chart.getByTestId("chart-changed")).toHaveCount(0);

    await pointAndClick(window, grid.locator("td").filter({ hasText: words.firstMetric }));
    await window.keyboard.press("ControlOrMeta+a");
    const copied = await copyPayload(editor);
    const lines = copied.text.split("\n");
    expect(lines).toContain(words.years.head.join("\t"));
    expect(lines).toContain(words.years.rows[0]?.join("\t"));
    expect(lines).toContain(words.years.rows[1]?.join("\t"));
    expect(lines.filter((line) => line.includes(words.years.rows[0]?.[1] ?? ""))).toHaveLength(1);
    expect(copied.text).toContain(words.lead);
    expect(copied.html).toContain("<table");
    expect(copied.html).toContain('data-type="chart"');
    await app.close();
  });

  test(`a table of percents beside times charts as two stacked charts on one x axis, each labelled with its unit (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    const { editor, grid } = await mindWithTable(window, words.mixedLead, words.mixed);

    await pointAndClick(window, grid.locator("td").first());
    await pointAndClick(window, window.getByTestId("table-menu"));
    await pointAndClick(window, window.getByTestId("table-chart"));
    await expect(window.getByTestId("table-actions")).toBeHidden();
    const chart = editor.getByTestId("chart");
    await expect(chart).toHaveCount(1);
    await expect(chart.getByTestId("chart-point")).toHaveCount(8);
    await chart.scrollIntoViewIfNeeded();
    // Its copy shrinks away first, or the picture keeps it over the chart.
    await motionSettled(window);
    await screenshot(window, `table-chart-units-${language}-${width}`);

    const panels = chart.getByTestId("chart-panel");
    await expect(panels).toHaveCount(2);
    await expect(chart.getByTestId("chart-unit")).toHaveText([words.unitPercent, words.unitTimes]);
    await expect(panels.nth(0).getByTestId("chart-point")).toHaveCount(4);
    await expect(panels.nth(1).getByTestId("chart-point")).toHaveCount(4);

    for (const panel of [panels.nth(0), panels.nth(1)]) {
      expect(await axisLabels(panel)).toEqual(expect.arrayContaining([...words.quarters]));
    }

    // The quarters sit at the same x in both charts: they share one x axis.
    const quarterX = async (panel: Locator, label: string) => {
      const text = panel.locator(".chart-axis").filter({ hasText: label }).first();
      return (await text.boundingBox())?.x ?? null;
    };
    const [across, up] = await Promise.all([
      quarterX(panels.nth(0), words.quarters[0] ?? ""),
      quarterX(panels.nth(1), words.quarters[0] ?? ""),
    ]);
    expect(across).not.toBeNull();
    expect(across !== null && up !== null && Math.abs(across - up) <= 1).toBe(true);

    // Each chart has its own scale: percents above, times below.
    expect((await axisLabels(panels.nth(0))).some((text) => text.endsWith("%"))).toBe(true);
    expect((await axisLabels(panels.nth(1))).some((text) => text.endsWith("%"))).toBe(false);

    const [first, second] = await Promise.all([
      panels.nth(0).boundingBox(),
      panels.nth(1).boundingBox(),
    ]);
    expect(first && second && first.y + first.height <= second.y).toBe(true);
    await app.close();
  });

  test(`a column of quantities draws every value, 2000 among them, and says no cell is left out (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 660);
    const { editor, grid } = await mindWithTable(window, words.lead, words.quantities);

    await pointAndClick(window, grid.locator("td").first());
    await pointAndClick(window, window.getByTestId("table-menu"));
    await pointAndClick(window, window.getByTestId("table-chart"));
    const chart = editor.getByTestId("chart");
    await expect(chart.getByTestId("chart-point")).toHaveCount(3);
    await expect(point(chart, 1, 0)).toHaveAttribute("aria-label", /2,?000/);
    await expect(chart.getByTestId("chart-source")).not.toContainText(/isn’t drawn|未绘制/);
    await screenshot(window, `table-chart-quantities-${language}-${width}`);
    await app.close();
  });

  test(`a calculation's working table is offered no chart (${language}, ${width}px)`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 660);
    const { grid } = await mindWithTable(window, words.lead, words.working);

    await pointAndClick(window, grid.locator("td").first());
    await pointAndClick(window, window.getByTestId("table-menu"));
    await expect(window.getByTestId("table-actions")).toBeVisible();
    await expect(window.getByTestId("table-rowBelow")).toBeVisible();
    await expect(window.getByTestId("table-chart")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("table-actions")).toBeHidden();
    await app.close();
  });
}
