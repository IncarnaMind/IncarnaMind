import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ALL_SHARED_ID, type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  catchCopies,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
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
 * What a new agent reads (#507, #3364, #3487, #3544): all of the User's Documents and notes, those
 * added later too, said in words while there is no Folder to choose instead, and the choice already
 * made once there are Folders, with Choose Folders as the other, which lists Not in a Folder after
 * them; Allow and connect shows without scrolling. A connected agent's Folders… has the same two
 * choices, and narrows and widens back in place. The home folder is a temporary one, and what the
 * page copies is caught, so no agent of the User's is touched.
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
    noneYet: "No Documents yet: it reads those added outside a Folder.",
    notInFolder: "Not in a Folder",
    allUnfiled:
      "Your Documents aren’t in Folders yet, so these are all of them. To share some, put them in a Folder first.",
    count: (count: number | string) => `${count} Document${count === 1 ? "" : "s"}`,
    allow: "Allow and connect",
    reads: (names: string) => `Reads ${names}`,
    join: ", ",
    readsAll: translate("en", "agents.connect.reads.all", { agent: "Claude Code" }),
    readsFolders: translate("en", "agents.connect.reads", { agent: "Claude Code" }),
    readsProjects: translate("en", "agents.connect.reads.projects", { agent: "Claude Code" }),
    shareAll: "All my Documents and notes, and what I add later",
    pairingAll: "Reads all your Documents and notes, and what you add later",
  },
  "zh-CN": {
    settings: "设置",
    noneYet: "还没有文档：之后添加且不在文件夹中的文档，它都能读取。",
    notInFolder: "不在文件夹中",
    allUnfiled:
      "你的文档还没有放进文件夹，这里就是全部文档。想只分享一部分，先把它们放进一个文件夹。",
    count: (count: number | string) => `${count} 个文档`,
    allow: "允许并连接",
    reads: (names: string) => `可读取：${names}`,
    join: "、",
    readsAll: translate("zh-CN", "agents.connect.reads.all", { agent: "Claude Code" }),
    readsFolders: translate("zh-CN", "agents.connect.reads", { agent: "Claude Code" }),
    readsProjects: translate("zh-CN", "agents.connect.reads.projects", { agent: "Claude Code" }),
    shareAll: "我的全部文档和笔记，包括以后添加的",
    pairingAll: "可读取你的全部文档和笔记，包括以后添加的",
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

/** The whole of `target` is on screen, with nothing to scroll to reach it. */
async function expectInView(window: Page, target: Locator): Promise<void> {
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const box = await target.boundingBox();
  if (!box) throw new Error("It isn't shown.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
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

for (const width of [900, 1280]) {
  for (const language of ["en", "zh-CN"] as const) {
    const words = WORDS[language];
    test(`all of it is the choice made, in words with no Folder; Choose Folders lists Not in a Folder after them, and Folders… narrows and widens back, at ${width} px in ${LANGUAGE_NAME[language]}`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await dismissChatSetup(window);
        await setWindowSize(app, window, width, 720);
        await catchCopies(window);
        const dialog = await openConnectDialog(window, language);
        const allow = dialog.getByTestId("connect-agent-allow");
        await expect(allow).toHaveText(words.allow);

        // No Documents at all: nothing to choose, all of it in words, those added later too, and
        // the three lines, with Allow and connect in view and the rest under Details.
        const rows = dialog.getByTestId("agent-folder-row");
        await expect(rows).toHaveCount(0);
        await expect(dialog.getByTestId("agent-share-all")).toHaveCount(0);
        const reads = dialog.getByTestId("connect-agent-reads");
        await expect(reads).toHaveText(words.readsAll);
        await expect(dialog.getByTestId("agent-propose")).toBeChecked({ checked: false });
        await expect(dialog.getByTestId("connect-agent-disconnect")).toHaveText(
          translate(language, "agents.connect.disconnect"),
        );
        const details = dialog.getByTestId("connect-agent-details");
        await expect(details).not.toHaveAttribute("open", "");
        await expect(details).toContainText(
          translate(language, "agents.connect.body", { agent: "Claude Code" }),
        );
        await expect(details.getByTestId("connect-agent-skill")).toBeHidden();
        await expect(allow).toBeEnabled();
        await expectInView(window, allow);
        await expectFits(window, dialog);
        await shot(window, `no-documents-${width}-${language}`);
        await shot(dialog, `no-documents-dialog-${width}-${language}`);

        // Opened, the rest is there.
        await details.locator("summary").first().click();
        await expect(details.getByTestId("connect-agent-skill")).toBeVisible();
        await shot(dialog, `no-documents-details-dialog-${width}-${language}`);
        await details.locator("summary").first().click();

        // Added: still in words.
        const tides = await writeNote("Tides", "Spring tides come at new moon.");
        await window.evaluate(async (path) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([
            path,
          ]);
        }, tides);
        await expect(reads).toHaveText(words.readsAll);
        await expect(rows).toHaveCount(0);
        await expect(allow).toBeEnabled();
        await expectInView(window, allow);
        await expectFits(window, dialog);
        await shot(window, `no-folders-${width}-${language}`);
        await shot(dialog, `no-folders-dialog-${width}-${language}`);
        await dialog.getByRole("button", { name: language === "en" ? "Cancel" : "取消" }).click();
        await expect(dialog).toBeHidden();

        // With Folders, all of it is the choice already made, and Allow connects with it.
        await addFolders(window, await writeNote("Reef", "The reef shelters young coral."));
        await expectReadyDocuments(window, 2);
        await window
          .getByTestId("agents-list")
          .locator('[data-client="claude-code"]')
          .getByTestId("agent-connect")
          .click();
        await expect(reads).toHaveText(words.readsFolders);
        const shareAll = dialog.getByTestId("agent-share-all");
        await expect(shareAll).toBeChecked();
        await expect(dialog.locator("label", { has: shareAll })).toHaveText(words.shareAll);
        await expect(rows).toHaveCount(0);
        await expect(allow).toBeEnabled();
        await expectInView(window, allow);
        await expectFits(window, dialog);
        await shot(window, `folders-all-${width}-${language}`);
        await shot(dialog, `folders-all-dialog-${width}-${language}`);

        // Choose Folders lists Not in a Folder after them, and nothing is ticked until the User picks.
        await dialog.getByTestId("agent-share-folders").check();
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText("Coast");
        await expect(rows.nth(1)).toContainText(LONG_NAME);
        await expect(rows.nth(2)).toContainText(words.notInFolder);
        await expect(rows.nth(2).getByTestId("agent-folder-count")).toHaveText(words.count(1));
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

        // Connected, the same choices are in Folders…, Not in a Folder last, and change in place.
        const row = window.getByTestId("agent-pairing");
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
          words.reads(words.notInFolder),
        );
        await row.getByTestId("agent-folders").click();
        const panel = row.getByTestId("agent-pairing-folders");
        await expect(panel.getByTestId("agent-share-folders")).toBeChecked();
        const own = panel.getByTestId("agent-folder-row");
        await expect(own).toHaveCount(3);
        await expect(own.nth(2)).toContainText(words.notInFolder);
        await expect(own.nth(2).getByTestId("agent-folder")).toBeChecked();
        await own.nth(0).getByTestId("agent-folder").check();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
          words.reads(["Coast", words.notInFolder].join(words.join)),
        );
        await own.nth(2).getByTestId("agent-folder").uncheck();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(words.reads("Coast"));
        await shot(window, `folders-connected-${width}-${language}`);

        // Widened to all, in the consent's words; narrowed again, it starts from what all reaches.
        const pairingFolders = () =>
          window.evaluate(async () =>
            (
              await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents()
            ).pairings.map((each) => each.folderIds),
          );
        await panel.getByTestId("agent-share-all").check();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(words.pairingAll);
        await expect(own).toHaveCount(0);
        await expect(
          panel.locator("label", { has: panel.getByTestId("agent-share-all") }),
        ).toHaveText(words.shareAll);
        await expect.poll(pairingFolders).toEqual([[ALL_SHARED_ID]]);
        await shot(window, `all-connected-${width}-${language}`);
        await panel.getByTestId("agent-share-folders").check();
        await expect(own).toHaveCount(3);
        for (const index of [0, 1, 2])
          await expect(own.nth(index).getByTestId("agent-folder")).toBeChecked();
        await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
          words.reads(["Coast", LONG_NAME, words.notInFolder].join(words.join)),
        );
        const narrowed = await pairingFolders();
        expect(narrowed.map((each) => [...each].sort())).toEqual([
          [
            ...(await window.evaluate(async () =>
              (
                await (
                  globalThis as unknown as { incarnamind: CoreBridge }
                ).incarnamind.getLibrary()
              ).groups.map((each) => each.id),
            )),
            NOT_IN_A_FOLDER_ID,
          ].sort(),
        ]);
      } finally {
        await app.close();
      }
    });
  }
}

test("a Library that is only a Linked folder's files says it may read all of it, and Allow connects with all of it, those added later too", async () => {
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
    await expect(dialog.getByTestId("agent-folder-row")).toHaveCount(0);
    await expect(dialog.getByTestId("connect-agent-reads")).toHaveText(WORDS.en.readsAll);
    await dialog.getByTestId("connect-agent-allow").click();
    await expect(dialog).toBeHidden();
    await expect(window.getByTestId("agent-pairing-reads")).toHaveText(WORDS.en.pairingAll);
    const pairings = await window.evaluate(async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents()
      ).pairings.map((each) => each.folderIds),
    );
    expect(pairings).toEqual([[ALL_SHARED_ID]]);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`with a Project, the first line says a Project is shared only on its own, in ${LANGUAGE_NAME[language]}`, async () => {
    await writeNote("Quay plan", "The quay plan adds 31 moorings.");
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1280, 720);
      await catchCopies(window);
      await window.evaluate(async (path) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const linked = await core.addLinkedFolder(path);
        await core.createBoundFolder(linked.folderId);
      }, sources);
      await expectReadyDocuments(window, 1);
      const dialog = await openConnectDialog(window, language);
      await expect(dialog.getByTestId("connect-agent-reads")).toHaveText(
        WORDS[language].readsProjects,
      );
      await expect(dialog.getByTestId("agent-share-all")).toBeChecked();
      await shot(dialog, `project-dialog-1280-${language}`);
    } finally {
      await app.close();
    }
  });
}
