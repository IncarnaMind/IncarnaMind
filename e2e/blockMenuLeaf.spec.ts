import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  menuCommands,
  pointAndClick,
  removeDataFolder,
  slideToHandle,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

function element(name: string, attributes: Record<string, unknown> = {}, text?: string) {
  const node = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value as never);
  if (text !== undefined) node.insert(0, [new Y.XmlText(text)]);
  return node;
}

/** A paragraph, a bar chart and, right after the chart, a table: the chart is a leaf Block. */
async function mindWithChartThenTable(window: Page): Promise<void> {
  const doc = new Y.Doc();
  const paragraph = element("paragraph", { id: crypto.randomUUID() }, "Revenue by quarter.");
  const chart = element("chart");
  const figure = (shown: string, line: number) => ({
    shown,
    value: Number(shown),
    unit: null,
    citation: null,
    from: { kind: "text", line },
  });
  const attributes = {
    id: crypto.randomUUID(),
    kind: "bar",
    title: "Revenue",
    data: {
      labelHeading: "Quarter",
      series: ["2025"],
      rows: ["341.5", "362.0", "377.9"].map((shown, line) => ({
        label: `Q${line + 1}`,
        values: [figure(shown, line)],
      })),
      cutFrom: null,
    },
    source: { kind: "figures" },
  };
  for (const [name, value] of Object.entries(attributes)) chart.setAttribute(name, value as never);
  const table = element("table", { id: crypto.randomUUID() });
  [
    ["Quarter", "Revenue"],
    ["Q1", "341.5"],
    ["Q2", "362.0"],
  ].forEach((cells, rowIndex) => {
    const row = element("tableRow");
    cells.forEach((text, at) => {
      const cell = element(rowIndex === 0 ? "tableHeader" : "tableCell", {
        colspan: 1,
        rowspan: 1,
      });
      cell.insert(0, [element("paragraph", { id: crypto.randomUUID() }, text)]);
      row.insert(at, [cell]);
    });
    table.insert(rowIndex, [row]);
  });
  doc.getXmlFragment("blocks").push([paragraph, chart, table]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  await window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Leaf and table" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
  }, update);
}

test("a chart's menu, opened without a pointer, is the chart's: its cursor is on the chart, not in the table after it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await mindWithChartThenTable(window);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Leaf and table" }),
  );
  const editor = window.getByTestId("mind-editor");
  const chart = editor.getByTestId("chart");
  const table = editor.locator("table");
  await expect(chart).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);
  const menu = window.getByTestId("block-actions");
  const selected = () =>
    editor.evaluate((dom) => {
      const { selection } = (dom as unknown as { editor: Editor }).editor.state;
      return "node" in selection
        ? `node:${(selection as unknown as { node: { type: { name: string } } }).node.type.name}`
        : `text:${selection.$from.node(1).type.name}`;
    });

  // The handle: click it beside the chart.
  await (await slideToHandle(window, chart)).click();
  const byHandle = await menuCommands(menu);
  expect(byHandle).toContain("chart.table");
  expect(byHandle.filter((id) => id.startsWith("table."))).toEqual([]);
  expect(await selected()).toBe("node:chart");
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The context-menu key with the chart selected, as arrow keys leave it.
  await editor.evaluate((dom) => {
    const note = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    note.state.doc.forEach((node, pos) => {
      if (node.type.name === "chart") at = pos;
    });
    note.commands.focus();
    note.commands.setNodeSelection(at);
  });
  await window.keyboard.press("Shift+F10");
  const byKey = await menuCommands(menu);
  expect(byKey).toContain("chart.table");
  expect(byKey.filter((id) => id.startsWith("table."))).toEqual([]);
  expect(await selected()).toBe("node:chart");
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(table.locator("tr")).toHaveCount(3);
  await app.close();
});
