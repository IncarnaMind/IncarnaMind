import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * "Make a bar chart of revenue by quarter" (#1091), in English and Chinese: the
 * Mind gets the cited table and a chart drawn from it, right after it, the
 * facts line says both, and one ⌘Z takes both back. A table with a percent
 * column beside a column of times is two charts, one per unit, bar or line as
 * asked (#1392). The model is the smoke tests' fake.
 */

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

const REPORT = [
  "# Annual report",
  "",
  "Revenue in Q1 was €120 million.",
  "",
  "Revenue in Q2 was €135 million.",
  "",
  "Revenue in Q3 was €150 million.",
  "",
  "Revenue in Q4 was €160 million.",
].join("\n");

for (const [language, request, kind, title, fact] of [
  [
    "en",
    "Make a bar chart of revenue by quarter",
    "bar",
    "Revenue by quarter",
    "Added a table and a chart",
  ],
  ["zh-CN", "画一个各季度收入的折线图", "line", "各季度收入", "添加了 1 个表格和 1 个图表"],
] as const) {
  test(`“${request}” adds the cited table and its ${kind} chart, and one Undo takes both back (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await writeFile(join(sources, "Annual report.md"), REPORT);
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);
    await nameMind(window, "Year notes");
    await window.keyboard.type("Notes on the year.");

    await askInAssistant(window, request);

    const editor = window.getByTestId("mind-editor");
    const table = editor.locator("table");
    const chart = editor.getByTestId("chart");
    await expect(table).toHaveCount(1);
    await expect(chart).toHaveCount(1);
    const tableBox = await table.boundingBox();
    const chartBox = await chart.boundingBox();
    expect(tableBox && chartBox && tableBox.y + tableBox.height <= chartBox.y).toBe(true);
    await expect(chart.getByTestId("chart-title")).toContainText(title);
    await expect(chart.getByTestId("chart-plot")).toHaveAttribute("data-kind", kind);
    await expect(chart.getByTestId("chart-point")).toHaveCount(4);
    await expect(chart.getByTestId("chart-source")).toContainText("Annual report");
    await expect(chart.getByTestId("chart-changed")).toHaveCount(0);
    await expect(editor.getByTestId("applied-line").getByTestId("applied-count")).toHaveText(fact);

    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(chart).toHaveCount(0);
    await expect(editor.locator("table")).toHaveCount(0);
    await expect(editor).toContainText("Notes on the year.");
  });
}

const MIXED_REPORT = [
  "# Annual report",
  "",
  "Gross margin in Q1 was 41.2%.",
  "Net debt to EBITDA in Q1 was 2.8 times.",
  "",
  "Gross margin in Q2 was 43.5%.",
  "Net debt to EBITDA in Q2 was 2.5 times.",
  "",
  "Gross margin in Q3 was 40.8%.",
  "Net debt to EBITDA in Q3 was 3.1 times.",
  "",
  "Gross margin in Q4 was 44.1%.",
  "Net debt to EBITDA in Q4 was 2.9 times.",
].join("\n");

for (const [language, request, kind, times] of [
  ["en", "Make a bar chart of margin and leverage by quarter", "bar", "times"],
  ["zh-CN", "画一个各季度毛利率和净负债的柱状图", "bar", "倍"],
  ["en", "Make a line chart of margin and leverage by quarter", "line", "times"],
  ["zh-CN", "画一个各季度毛利率和净负债的折线图", "line", "倍"],
] as const) {
  test(`“${request}” draws a percent column beside a column of times as two ${kind} charts, each labelled with its unit (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await writeFile(join(sources, "Mixed report.md"), MIXED_REPORT);
    await addDocuments(window, [join(sources, "Mixed report.md")]);
    await newMind(window);
    await nameMind(window, "Year notes");
    await window.keyboard.type("Notes on the year.");

    await askInAssistant(window, request);

    const editor = window.getByTestId("mind-editor");
    await expect(editor.locator("table")).toHaveCount(1);
    const chart = editor.getByTestId("chart");
    await expect(chart).toHaveCount(1);
    await expect(chart).toHaveAttribute("data-kind", kind);
    await expect(chart.getByTestId("chart-panel")).toHaveCount(2);
    await expect(chart.getByTestId("chart-unit")).toHaveText(["%", times]);
    await expect(chart.getByTestId("chart-panel").nth(0).getByTestId("chart-point")).toHaveCount(4);
    await expect(chart.getByTestId("chart-panel").nth(1).getByTestId("chart-point")).toHaveCount(4);
    await expect(chart.getByTestId("chart-source")).toContainText("Mixed report");
    await app.close();
  });
}

// protects=a chart the assistant draws is a write the User asked for, however they worded it; fails_when=it waits as changes to accept, with "N changes waiting" on the page and "none waiting" in the card; no_claim=none beyond protects.
test("a chart asked for as a question is drawn at once too, and the card and the page count the same", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeFile(join(sources, "Annual report.md"), REPORT);
  await addDocuments(window, [join(sources, "Annual report.md")]);
  await newMind(window);
  await nameMind(window, "Year notes");
  await window.keyboard.type("Notes on the year.");

  const answer = await askInAssistant(window, "Could you make a bar chart of revenue by quarter?");

  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("table")).toHaveCount(1);
  await expect(editor.getByTestId("chart")).toHaveCount(1);
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await expect(editor.getByTestId("applied-line").getByTestId("applied-count")).toHaveText(
    "Added a table and a chart",
  );
  await expect(answer.getByTestId("mind-changes-left")).toHaveCount(0);

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor.getByTestId("chart")).toHaveCount(0);
  await expect(editor.locator("table")).toHaveCount(0);
});
