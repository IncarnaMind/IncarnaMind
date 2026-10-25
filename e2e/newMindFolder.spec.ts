import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A new Mind starts in the Folder of the Mind in front, as in Notion and Finder, and can be moved
 * out (#1362); with no Folder around, it starts in none.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const minds = (window: Page) =>
  window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).map(
      (mind) => ({ id: mind.id, folderId: mind.folderId }),
    ),
  );

// protects=a new Mind made with ⌘T, the + menu and the tab strip's + starts in the Folder of the Mind in front, and in none when that Mind is in none; fails_when=it is made in Not in a Folder beside a Mind in a Folder; no_claim=the Folder commands that name their Folder, which are unchanged.
test("⌘T, the + menu and the tab strip's + make the new Mind in the front Mind's Folder, and none with it in no Folder", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await newMind(window);
  const [first] = await minds(window);
  if (!first) throw new Error("No Mind.");
  const folderId = await (await coreOf(window)).evaluate(async (core: CoreBridge, id: string) => {
    const folder = await core.createLibraryGroup({ name: "Contracts", description: "" });
    await core.moveToFolder({ mindIds: [id], folderId: folder.id });
    return folder.id;
  }, first.id);
  await expect
    .poll(async () => (await minds(window)).find((each) => each.id === first.id)?.folderId)
    .toBe(folderId);

  const known = new Set([first.id]);
  const made = async () => {
    await expect.poll(async () => (await minds(window)).length).toBe(known.size + 1);
    const next = (await minds(window)).find((each) => !known.has(each.id));
    if (!next) throw new Error("No new Mind.");
    known.add(next.id);
    return next;
  };

  await window.keyboard.press("ControlOrMeta+t");
  expect((await made()).folderId).toBe(folderId);

  // From the Mind just made, which is in the Folder too.
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-new-mind").click();
  expect((await made()).folderId).toBe(folderId);

  await window.getByTestId("new-tab").first().click();
  expect((await made()).folderId).toBe(folderId);

  // Moved out of the Folder, the Mind in front makes the next one in none.
  const front = [...known].at(-1);
  if (!front) throw new Error("No Mind in front.");
  await (await coreOf(window)).evaluate(async (core: CoreBridge, id: string) => {
    await core.moveToFolder({ mindIds: [id], folderId: null });
  }, front);
  await expect
    .poll(async () => (await minds(window)).find((each) => each.id === front)?.folderId)
    .toBe(null);
  await window.keyboard.press("ControlOrMeta+t");
  expect((await made()).folderId).toBe(null);
  await app.close();
});
