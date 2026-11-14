import { expect, type Locator, type Page, test } from "@playwright/test";
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
  setWindowSize,
  splitFromTabMenu,
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

/** A paragraph and a table of a heading row and two rows, two columns wide. */
async function mindWithTable(window: Page): Promise<void> {
  const doc = new Y.Doc();
  const paragraph = element("paragraph", { id: crypto.randomUUID() }, "Intro");
  const table = element("table", { id: crypto.randomUUID() });
  [
    ["H1", "H2"],
    ["a1", "b1"],
    ["a2", "b2"],
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
  doc.getXmlFragment("blocks").push([paragraph, table]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  await window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Pane table" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
  }, update);
}

/** The Note open in two panes, as the specs of the Delete key do. */
async function twoPanes(window: Page, app: Parameters<typeof setWindowSize>[0]) {
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await mindWithTable(window);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Pane table" }),
  );
  await expect(window.getByTestId("mind-editor").locator("table tr")).toHaveCount(3);
  await splitFromTabMenu(window);
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(2);
  const pane = (at: number) => {
    const editor = groups.nth(at).getByTestId("mind-editor");
    return {
      editor,
      group: groups.nth(at),
      paragraph: editor.locator("p").first(),
      cell: (words: string): Locator => editor.locator("td, th").filter({ hasText: words }).first(),
      rows: () => editor.locator("tr").evaluateAll((trs) => trs.map((tr) => tr.textContent ?? "")),
      cursor: () =>
        editor.evaluate((dom) => {
          const { editor: note } = dom as unknown as { editor: Editor };
          return note.state.selection.$from.parent.textContent;
        }),
    };
  };
  const [left, right] = [pane(0), pane(1)];
  await expect(left.editor.locator("tr")).toHaveCount(3);
  await expect(right.editor.locator("tr")).toHaveCount(3);
  return { left, right };
}

const menuIn = (pane: { group: Locator }) => pane.group.getByTestId("block-actions");

test("a table's Block menu opened in the right pane acts in the right pane, with the left pane's cursor outside the table", async () => {
  const { app, window } = await launchApp(dataDir);
  const { left, right } = await twoPanes(window, app);
  await pointAndClick(window, left.paragraph);
  await expect.poll(left.cursor).toBe("Intro");
  await pointAndClick(window, right.cell("a2"), { button: "right" });
  await expect.poll(right.cursor).toBe("a2");
  const items = await menuCommands(menuIn(right));
  expect(items).toContain("table.rowBelow");
  expect(items).toContain("table.delete");
  await app.close();
});

test("Insert row below from the right pane's menu goes under the right pane's cell, with the left pane's cursor in another cell", async () => {
  const { app, window } = await launchApp(dataDir);
  const { left, right } = await twoPanes(window, app);
  await pointAndClick(window, left.cell("a1"));
  await expect.poll(left.cursor).toBe("a1");
  await pointAndClick(window, right.cell("b2"), { button: "right" });
  await expect.poll(right.cursor).toBe("b2");
  await pointAndClick(window, menuIn(right).getByTestId("table.rowBelow"));
  await expect.poll(right.rows).toEqual(["H1H2", "a1b1", "a2b2", ""]);
  await expect.poll(left.rows).toEqual(["H1H2", "a1b1", "a2b2", ""]);
  await app.close();
});

test("Insert row below from the left pane's menu goes under the left pane's cell, with the right pane's cursor in another cell", async () => {
  const { app, window } = await launchApp(dataDir);
  const { left, right } = await twoPanes(window, app);
  await pointAndClick(window, right.cell("b2"));
  await expect.poll(right.cursor).toBe("b2");
  await pointAndClick(window, left.cell("a1"), { button: "right" });
  await expect.poll(left.cursor).toBe("a1");
  await pointAndClick(window, menuIn(left).getByTestId("table.rowBelow"));
  await expect.poll(left.rows).toEqual(["H1H2", "a1b1", "", "a2b2"]);
  await expect.poll(right.rows).toEqual(["H1H2", "a1b1", "", "a2b2"]);
  await app.close();
});

test("the table's ⋯ in the right pane adds the row under the right pane's cell, with the left pane's cursor in another cell", async () => {
  const { app, window } = await launchApp(dataDir);
  const { left, right } = await twoPanes(window, app);
  await pointAndClick(window, left.cell("a1"));
  await expect.poll(left.cursor).toBe("a1");
  await pointAndClick(window, right.cell("b2"));
  await expect.poll(right.cursor).toBe("b2");
  await pointAndClick(window, right.group.getByTestId("table-menu"));
  await pointAndClick(
    window,
    right.group.getByTestId("table-actions").getByTestId("table.rowBelow"),
  );
  await expect.poll(right.rows).toEqual(["H1H2", "a1b1", "a2b2", ""]);
  await app.close();
});

test("⌘/ in the right pane opens the right pane's table menu, with the left pane's cursor outside the table", async () => {
  const { app, window } = await launchApp(dataDir);
  const { left, right } = await twoPanes(window, app);
  await pointAndClick(window, left.paragraph);
  await expect.poll(left.cursor).toBe("Intro");
  await pointAndClick(window, right.cell("a2"));
  await expect.poll(right.cursor).toBe("a2");
  await window.keyboard.press("ControlOrMeta+/");
  await expect(right.group.getByTestId("table-actions")).toBeVisible();
  await app.close();
});
