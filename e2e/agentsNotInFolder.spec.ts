import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  interceptOpenDialog,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * Connecting an agent when the Library has no Folders, or no Documents (#507): the dialog offers
 * Not in a Folder, ticked when it is the only choice, or the Library's Add Documents…, and a
 * connected agent's Folders… lists Not in a Folder after the Folders. The home folder is a
 * temporary one, and what the page copies is caught, so no agent of the User's is touched.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(target: Page | Locator, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

type Language = "en" | "zh-CN";

const WORDS = {
  en: {
    settings: "Settings",
    emptyTitle: "Nothing to read yet",
    emptyBody: "Add Documents for Claude Code to read. They appear here.",
    add: "Add Documents…",
    notInFolder: "Not in a Folder",
    allUnfiled:
      "Your Documents aren’t in Folders yet, so these are all of them. To share some, put them in a Folder first.",
    count: (count: number | string) => `${count} Document${count === 1 ? "" : "s"}`,
    allow: "Allow and connect",
    reads: (names: string) => `Reads ${names}`,
  },
  "zh-CN": {
    settings: "设置",
    emptyTitle: "还没有可读取的内容",
    emptyBody: "添加要让 Claude Code 读取的文档，它们会显示在这里。",
    add: "添加文档…",
    notInFolder: "不在文件夹中",
    allUnfiled:
      "你的文档还没有放进文件夹，这里就是全部文档。想只分享一部分，先把它们放进一个文件夹。",
    count: (count: number | string) => `${count} 个文档`,
    allow: "允许并连接",
    reads: (names: string) => `可读取：${names}`,
  },
} as const;

const LANGUAGE_NAME = { en: "English", "zh-CN": "Chinese" } as const;

/** Longer than a row's name has room for, even in a wide window. */
const LONG_NAME =
  "Quarterly harbour dredging and sediment survey committee papers, final versions for the board";

/** Two Folders, "Coast" and one with a long name, and a Document, filed in Coast. */
async function addFolders(window: Page, path: string): Promise<void> {
  await window.evaluate(
    async ({ file, longName }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
      await core.createLibraryGroup({ name: longName, description: "" });
      const { documents } = await core.addDocuments([file]);
      const added = documents[0];
      if (added) await core.assignDocumentGroup(added.id, coast.id);
    },
    { file: path, longName: LONG_NAME },
  );
}

/** Writes a Document's file and returns its path. */
async function writeNote(name: string, sentence: string): Promise<string> {
  const path = join(sources, `${name}.md`);
  await writeFile(path, `# ${name}\n\n${sentence}\n`);
  return path;
}

/** Connecting agents on, then Settings → Agents, then Claude Code's Connect: the dialog it opens. */
async function openConnectDialog(window: Page, language: Language): Promise<Locator> {
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setAgentsEnabled(true);
  });
  await setLanguage(window, language);
  await window.getByRole("button", { name: WORDS[language].settings }).last().click();
  const page = await showSettingsPage(window, "agents");
  await page
    .getByTestId("agents-list")
    .locator('[data-client="claude-code"]')
    .getByTestId("agent-connect")
    .click();
  const dialog = window.getByTestId("connect-agent-dialog");
  await expect(dialog).toContainText("Claude Code");
  return dialog;
}

/** Whether `inner` lies inside `outer`, to a pixel. */
async function isInside(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
}

/** The dialog sits inside the window, and nothing in it spills out of it. */
async function expectFits(window: Page, dialog: Locator): Promise<void> {
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const box = await dialog.boundingBox();
  if (!box) throw new Error("The dialog isn't shown.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
}

for (const width of [900, 1600]) {
  for (const language of ["en", "zh-CN"] as const) {
    const words = WORDS[language];
    test(`no Documents offers Add Documents…, which adds them as Not in a Folder, ticked; with Folders it is listed after them, at ${width} px in ${LANGUAGE_NAME[language]}`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await dismissChatSetup(window);
        await setWindowSize(app, window, width, 720);
        await catchCopies(window);
        const dialog = await openConnectDialog(window, language);
        const allow = dialog.getByTestId("connect-agent-allow");
        await expect(allow).toHaveText(words.allow);

        // No Documents at all: nothing to tick, and one way forward, the Library's own.
        const empty = dialog.getByTestId("agent-folders-empty");
        await expect(empty).toContainText(words.emptyTitle);
        await expect(empty).toContainText(words.emptyBody);
        const addButton = empty.getByTestId("agent-add-documents");
        await expect(addButton).toHaveText(words.add);
        await expect(dialog.getByTestId("agent-folder")).toHaveCount(0);
        await expect(allow).toBeDisabled();
        expect(await isInside(addButton, empty)).toBe(true);
        await expectFits(window, dialog);
        await shot(window, `no-documents-${width}-${language}`);
        await shot(dialog, `no-documents-dialog-${width}-${language}`);

        // Added in place: they appear in the list as Not in a Folder, the only choice, ticked.
        await interceptOpenDialog(app, await writeNote("Tides", "Spring tides come at new moon."));
        await addButton.click();
        const rows = dialog.getByTestId("agent-folder-row");
        await expect(rows).toHaveCount(1);
        const only = rows.first();
        await expect(only).toContainText(words.notInFolder);
        await expect(only.getByTestId("agent-folder-count")).toHaveText(words.count(1));
        await expect(only.getByTestId("agent-folder")).toBeChecked();
        await expect(empty).toBeHidden();
        const line = dialog.getByTestId("agent-folders-all-unfiled");
        await expect(line).toHaveText(words.allUnfiled);
        const [list, note] = await Promise.all([
          dialog.getByTestId("agent-folder-list").boundingBox(),
          line.boundingBox(),
        ]);
        expect((note?.y ?? 0) >= (list?.y ?? 0) + (list?.height ?? 0)).toBe(true);
        await expect(allow).toBeEnabled();
        await expectFits(window, dialog);
        await shot(window, `no-folders-${width}-${language}`);
        await shot(dialog, `no-folders-dialog-${width}-${language}`);

        // Unticked, nothing is chosen: Allow waits.
        await only.getByTestId("agent-folder").uncheck();
        await expect(allow).toBeDisabled();
        await only.getByTestId("agent-folder").check();
        await expect(allow).toBeEnabled();
        await dialog.getByRole("button", { name: language === "en" ? "Cancel" : "取消" }).click();
        await expect(dialog).toBeHidden();

        // With Folders, Not in a Folder is listed after them, and nothing is ticked until the User picks.
        await addFolders(window, await writeNote("Reef", "The reef shelters young coral."));
        await expectReadyDocuments(window, 2);
        await window
          .getByTestId("agents-list")
          .locator('[data-client="claude-code"]')
          .getByTestId("agent-connect")
          .click();
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText("Coast");
        await expect(rows.nth(1)).toContainText(LONG_NAME);
        await expect(rows.nth(2)).toContainText(words.notInFolder);
        await expect(rows.nth(2).getByTestId("agent-folder-count")).toHaveText(words.count(1));
        await expect(dialog.getByTestId("agent-folders-all-unfiled")).toBeHidden();
        for (const index of [0, 1, 2])
          await expect(rows.nth(index).getByTestId("agent-folder")).not.toBeChecked();
        await expect(allow).toBeDisabled();
        const tops = await Promise.all(
          [0, 1, 2].map(async (index) => (await rows.nth(index).boundingBox())?.y ?? 0),
        );
        expect(tops[0]).toBeLessThan(tops[1] ?? 0);
        expect(tops[1]).toBeLessThan(tops[2] ?? 0);

        await shot(window, `folders-then-not-in-a-folder-${width}-${language}`);
        await shot(dialog, `folders-then-not-in-a-folder-dialog-${width}-${language}`);

        // A long name is cut, a long count keeps its words, and neither reaches the other.
        const longRow = rows.nth(1);
        const count = rows.nth(2).getByTestId("agent-folder-count");
        await count.evaluate(
          (element, text) => {
            element.textContent = text;
          },
          words.count((1_234_567).toLocaleString(language)),
        );
        for (const row of [longRow, rows.nth(2)]) {
          const [label, tally] = await Promise.all([
            row.locator("span").first().boundingBox(),
            row.getByTestId("agent-folder-count").boundingBox(),
          ]);
          expect((label?.x ?? 0) + (label?.width ?? 0)).toBeLessThanOrEqual((tally?.x ?? 0) + 1);
          expect(await isInside(row.getByTestId("agent-folder-count"), row)).toBe(true);
        }
        await expectFits(window, dialog);
        await shot(dialog, `huge-count-dialog-${width}-${language}`);
        await rows.nth(2).getByTestId("agent-folder").check();
        await expect(allow).toBeEnabled();
        await allow.click();
        await expect(dialog).toBeHidden();

        // Connected, the same list is in Folders…, Not in a Folder last, and changes in place.
        const row = window.getByTestId("agent-pairing");
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
          words.reads(words.notInFolder),
        );
        await row.getByTestId("agent-folders").click();
        const own = row.getByTestId("agent-pairing-folders").getByTestId("agent-folder-row");
        await expect(own).toHaveCount(3);
        await expect(own.nth(2)).toContainText(words.notInFolder);
        await expect(own.nth(2).getByTestId("agent-folder")).toBeChecked();
        await own.nth(0).getByTestId("agent-folder").check();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
          words.reads(`Coast, ${words.notInFolder}`),
        );
        await own.nth(2).getByTestId("agent-folder").uncheck();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(words.reads("Coast"));
        await shot(window, `folders-connected-${width}-${language}`);
      } finally {
        await app.close();
      }
    });
  }
}

test("a Library that is only a Linked folder's files lists them as Not in a Folder, and Allow connects with that scope", async () => {
  await writeNote("Tides", "Spring tides come at new moon.");
  await writeNote("Reef", "The reef shelters young coral.");
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 720);
    await catchCopies(window);
    await window.evaluate(async (path) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(
        path,
      );
    }, sources);
    await expectReadyDocuments(window, 2);
    const dialog = await openConnectDialog(window, "en");
    const rows = dialog.getByTestId("agent-folder-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Not in a Folder");
    await expect(rows.first().getByTestId("agent-folder-count")).toHaveText("2 Documents");
    await expect(rows.first().getByTestId("agent-folder")).toBeChecked();
    await expect(dialog.getByTestId("agent-folders-empty")).toBeHidden();
    await dialog.getByTestId("connect-agent-allow").click();
    await expect(dialog).toBeHidden();
    await expect(window.getByTestId("agent-pairing-reads")).toHaveText("Reads Not in a Folder");
    const pairings = await window.evaluate(async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents()
      ).pairings.map((each) => each.folderIds),
    );
    expect(pairings).toEqual([["not-in-a-folder"]]);
  } finally {
    await app.close();
  }
});
