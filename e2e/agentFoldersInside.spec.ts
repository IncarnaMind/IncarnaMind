import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import { unitsOf } from "../src/shared/i18n/join";
import {
  acceptPlainTextKeys,
  agentsToConnect,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Settings › AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A Folder shared with an agent shares the Folders inside it (#3394): in a connected agent's
 * Folders… and in the connect dialog, they show ticked and fixed with the Folder that shares
 * them, each row counts what an agent given it reads, a walled Folder inside is its own choice
 * with its lock, and unticking the parent gives each back its own choice. The agent's row names
 * the Folders inside it reads. Nothing on this computer opens. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save stills there.
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
const t = (language: Language, key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);
const SETTINGS = { en: "Settings", "zh-CN": "设置" } as const;

/**
 * Coast, with Engineering inside it and Yard inside that, and Legal inside Coast behind its own
 * wall, with Drafts inside it; Harbour beside Coast. A Document in each, and Claude Code connected
 * to Coast. Returns the Folders' ids by name.
 */
async function library(window: Page): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [name, sentence] of [
    ["Timetable", "The first ferry leaves at seven."],
    ["Gearbox", "The gearbox overhaul costs nine thousand pounds."],
    ["Slipway", "The slipway survey found the rails sound."],
    ["Claim", "Gwavas Marine claims forty thousand pounds."],
    ["Draft", "The draft reply offers to settle."],
    ["Tides", "Spring tides come at new moon."],
  ] as const) {
    const path = join(sources, `${name}.md`);
    await writeFile(path, `# ${name}\n\n${sentence}\n`);
    files[name] = path;
  }
  const ids = await window.evaluate(async (paths) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = async (name: string, parentId: string | null, keepInside = false) =>
      (await core.createLibraryGroup({ name, description: "", parentId, keepInside })).id;
    const coast = await folder("Coast", null);
    const engineering = await folder("Engineering", coast);
    const yard = await folder("Yard", engineering);
    const legal = await folder("Legal", coast, true);
    const drafts = await folder("Drafts", legal);
    const harbour = await folder("Harbour", null);
    const where: Record<string, string> = {
      Timetable: coast,
      Gearbox: engineering,
      Slipway: yard,
      Claim: legal,
      Draft: drafts,
      Tides: harbour,
    };
    for (const [name, path] of Object.entries(paths)) {
      const { documents } = await core.addDocuments([path]);
      const added = documents[0];
      const into = where[name];
      if (added && into) await core.assignDocumentGroup(added.id, into);
    }
    await core.setAgentsEnabled(true);
    await core.connectAgent({ name: "Claude Code", folderIds: [coast] });
    return { Coast: coast, Engineering: engineering, Yard: yard, Legal: legal, Drafts: drafts };
  }, files);
  await expectReadyDocuments(window, 6);
  return ids;
}

/** The list's row for a Folder, with its tick, its count and what says it is shared with another. */
const rowOf = (list: Locator, name: string) => {
  const row = list
    .getByTestId("agent-folder-row")
    .filter({ has: list.page().getByText(name, { exact: true }) });
  return {
    row,
    tick: row.getByTestId("agent-folder"),
    count: row.getByTestId("agent-folder-count"),
    with: row.getByTestId("agent-folder-shared-with"),
    wall: row.getByTestId("agent-folder-wall"),
  };
};

const counted = (language: Language, count: number) =>
  t(language, count === 1 ? "library.count.one" : "library.count", { count });

for (const language of ["en", "zh-CN"] as const) {
  // protects=the picker shows a ticked Folder's inner Folders ticked and fixed with it, counts what an agent reads, keeps a walled Folder inside as its own choice with its lock, and unticking the parent gives the inner Folders back their own choice, by keyboard; fails_when=an inner Folder looks unshared while it is read, a count takes in a wall's Documents, a walled Folder is shown shared, or the inner Folders stay fixed once the parent is unticked
  test(`a ticked Folder shows the Folders inside it shared with it, a walled one apart, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await interceptOpenPath(app);
      await interceptOpenExternal(app);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, 1280, 860);
      await setLanguage(window, language);
      await library(window);
      await window.getByRole("button", { name: SETTINGS[language] }).last().click();
      const page = await showSettingsPage(window, "ai");
      const pairing = page.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
      await expect(pairing.getByTestId("agent-pairing-reads")).toHaveText(
        t(language, "agents.pairing.reads", { folders: "Coast" }),
      );
      await expect(pairing.getByTestId("agent-pairing-inside")).toHaveText(
        t(language, "agents.pairing.inside", {
          folders: unitsOf(["Engineering", "Yard"], language),
        }),
      );
      await pairing.getByTestId("agent-folders").click();
      const list = pairing.getByTestId("agent-folder-list");
      await expect(list.getByTestId("agent-folder-row")).toHaveCount(6);

      const coast = rowOf(list, "Coast");
      const engineering = rowOf(list, "Engineering");
      const yard = rowOf(list, "Yard");
      const legal = rowOf(list, "Legal");
      const drafts = rowOf(list, "Drafts");
      const withCoast = t(language, "agents.folders.sharedWith", { folder: "Coast" });
      await expect(coast.tick).toBeChecked();
      await expect(coast.tick).toBeEnabled();
      for (const inner of [engineering, yard]) {
        await expect(inner.tick).toBeChecked();
        await expect(inner.tick).toBeDisabled();
        await expect(inner.with).toHaveText(withCoast);
      }
      await expect(legal.wall).toBeVisible();
      await expect(legal.tick).not.toBeChecked();
      await expect(legal.tick).toBeEnabled();
      await expect(legal.with).toHaveCount(0);
      await expect(drafts.tick).not.toBeChecked();
      await expect(drafts.tick).toBeEnabled();
      // What an agent given each reads: Coast's own and its inner Folders', never Legal's.
      await expect(coast.count).toHaveText(counted(language, 3));
      await expect(engineering.count).toHaveText(counted(language, 2));
      await expect(legal.count).toHaveText(counted(language, 2));
      // Each inner Folder sits under the one it is inside.
      const [outer, inner] = await Promise.all([
        coast.tick.boundingBox(),
        engineering.tick.boundingBox(),
      ]);
      expect((inner?.x ?? 0) > (outer?.x ?? 0)).toBe(true);
      await shot(window, `picker-${language}`);

      // By keyboard: Space unticks Coast, and its inner Folders are their own choice again.
      await coast.tick.focus();
      await window.keyboard.press("Space");
      await expect(coast.tick).not.toBeChecked();
      for (const each of [engineering, yard]) {
        await expect(each.tick).not.toBeChecked();
        await expect(each.tick).toBeEnabled();
        await expect(each.with).toHaveCount(0);
      }
      await expect(pairing.getByTestId("agent-pairing-inside")).toHaveCount(0);
      // Engineering ticked on its own shares Yard; ticked under Coast again it is fixed with it,
      // and keeps its own choice when Coast is unticked.
      await engineering.tick.focus();
      await window.keyboard.press("Space");
      await expect(yard.with).toHaveText(
        t(language, "agents.folders.sharedWith", { folder: "Engineering" }),
      );
      await coast.tick.focus();
      await window.keyboard.press("Space");
      await expect(engineering.tick).toBeDisabled();
      await expect(engineering.with).toHaveText(withCoast);
      await coast.tick.focus();
      await window.keyboard.press("Space");
      await expect(engineering.tick).toBeChecked();
      await expect(engineering.tick).toBeEnabled();
      await expect
        .poll(() =>
          window.evaluate(async () =>
            (
              await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents()
            ).pairings.map((each) => each.folderIds.length),
          ),
        )
        .toEqual([1]);

      // The connect dialog's list behaves the same, for another agent: one connected isn't listed again.
      await (await agentsToConnect(page))
        .locator('[data-client="codex"]')
        .getByTestId("agent-connect")
        .click();
      const dialog = window.getByTestId("connect-agent-dialog");
      await dialog.getByTestId("agent-share-folders").check();
      const offered = dialog.getByTestId("agent-folder-list");
      await rowOf(offered, "Coast").tick.check();
      await expect(rowOf(offered, "Engineering").tick).toBeDisabled();
      await expect(rowOf(offered, "Engineering").with).toHaveText(withCoast);
      await expect(rowOf(offered, "Legal").tick).toBeEnabled();
      await shot(dialog, `connect-${language}`);
    } finally {
      await app.close();
    }
  });
}
