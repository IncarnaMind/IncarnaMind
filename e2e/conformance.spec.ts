import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import { OBJECT_KINDS, type ObjectKind } from "../src/renderer/src/objects";
import type { TestHooks } from "../src/shared/testHooks";
import { NO_MENU_YET } from "../tests/helpers/conformance";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  coreOf,
  coreState,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  interceptOpenExternal,
  interceptOpenPath,
  interceptShowItemInFolder,
  launchApp,
  leaveText,
  linkFolderFromSidebar,
  menuCommands,
  mindWrittenBefore,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  showSourceLocations,
  stubClipboard,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * What docs/agents/interaction.md asks of every object, checked on the built app for each kind of
 * object the registry has, in a fresh data folder and home folder, with a slid mouse:
 *
 * - right-click it: its menu holds registered commands, in the order of rule 5, and the ⋯ opens
 *   the same menu;
 * - rename it by double-click and by F2: Esc cancels, Enter saves, ⌘Z takes it back; and Enter
 *   on the row opens it;
 * - run each reversible command from the menu, then ⌘Z: the core, read through the bridge, holds
 *   what it held before (what the command made waits in Recently deleted once taken back), a
 *   change that was made offered Undo, and a delete asked nothing;
 * - an irreversible command asks first and changes nothing until answered;
 * - a kind ⌘K finds by name is found there, and its reversible delete runs from ⌘K on its row
 *   with the checks above.
 *
 * The kinds, the menus and the commands are read from the registry, so a command added to a menu
 * is run here with no edit. A kind needs a stage below to be made and shown: the types fail until
 * a new kind has one. Selecting two with ⌘-click and running a command on both waits for #225.
 *
 * What the core holds here is its Minds, Documents, Folders, Tags, Linked folders and Recently
 * deleted (`coreState`), or, for what lives in a Mind's text, that Mind's note. A window's tabs
 * aren't in it: a tab is taken back by opening it again (⇧⌘T), as in a browser.
 */

type Registry = ReturnType<TestHooks["registry"]>;

interface Run {
  app: ElectronApplication;
  window: Page;
  /** A folder of files to make Documents and Linked folders from. */
  sources: string;
}

/**
 * How to have a kind of object to check. Each method takes the object's key, which `make` gives
 * and stays the same; its ID in the page may change (a tab closed and shown again is another).
 */
interface Stage {
  make(run: Run): Promise<string>;
  /** Shows it, as the place that lists it does, and gives its ID in the page now. */
  show(run: Run, key: string): Promise<string>;
  /** What the core calls it, for the kinds that rename. */
  name?(run: Run, key: string): Promise<string>;
  /** What shows once it is opened, for the kinds that open. */
  opened?(run: Run, key: string): Locator;
  /** A kind that lives in a Mind's text, whose key is the Mind's: its state is the note, its undo the note's. */
  inNote?: true;
  /** Where a click and the keyboard's focus land, when it isn't the row's main part. */
  hit?(run: Run): Locator;
  /** Where a double-click and F2 start a rename, when it isn't the row. */
  renameFrom?: { doubleClick(run: Run): Locator; focus(run: Run): Locator };
}

/**
 * Commands that change things and are not taken back by ⌘Z yet, each with the issue that ends
 * that. A fix takes its line out: the check fails for a command that is taken back now.
 */
const NO_UNDO_YET: Record<string, string> = {
  "answer.regenerate": "an AI change is taken back from History (#113), not by the note's ⌘Z",
  "folder.organize": "what it suggests is taken back in To review (#241), not by ⌘Z",
};

/** Commands that only make a Mind: it gets no undo line and no ⌘Z step, because Delete takes it back (#1191). */
const MAKES_A_MIND = new Set([
  "document.ask",
  "document.startMind",
  "folder.ask",
  "folder.newMind",
  "mind.aiUseStatement",
]);

let dataDir: string;
let homeDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  homeDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(homeDir);
  await removeDataFolder(sources);
});

/** Reads the core through the bridge (or changes it, as from another window). */
function read<T>(window: Page, query: (core: CoreBridge) => Promise<T>): Promise<T>;
function read<T, A>(
  window: Page,
  query: (core: CoreBridge, arg: A) => Promise<T>,
  arg: A,
): Promise<T>;
async function read(
  window: Page,
  query: (core: CoreBridge, arg?: unknown) => Promise<unknown>,
  arg?: unknown,
): Promise<unknown> {
  return (await coreOf(window)).evaluate(query, arg);
}

const registryOf = (window: Page): Promise<Registry> =>
  window.evaluate(() => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("The app has no test hooks.");
    return hooks.registry();
  });

/** The sidebar shows all its sections at once; Tags, which folds, is unfolded first. */
async function showView(window: Page, name: "Folders" | "Tags"): Promise<void> {
  if (name !== "Tags") return;
  const toggle = window.getByTestId("tags-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Shows an object, and says where it is: its row, the part a click lands on, its ⋯ button and its menu. */
async function placeOf(run: Run, kind: ObjectKind, stage: Stage, key: string) {
  const { window } = run;
  const id = await stage.show(run, key);
  const button = window.locator(`[data-object-menu="${kind}:${id}"]`).first();
  await expect(button).toBeAttached({ timeout: 15_000 });
  const row = button.locator("xpath=ancestor::*[@data-object-row][1]");
  const inner = row.locator("[data-row-main], [data-tree-row]");
  return {
    row,
    hit: stage.hit?.(run) ?? ((await inner.count()) > 0 ? inner.first() : row),
    button,
    menu: button.locator("xpath=following-sibling::*[@role='menu'][1]"),
  };
}

type Place = Awaited<ReturnType<typeof placeOf>>;

const noQuestion = (window: Page) => expect(window.locator("dialog[open]")).toHaveCount(0);
const undoOffered = async (window: Page) => (await window.getByTestId("undo-message").count()) > 0;
const undo = (window: Page) => window.keyboard.press("ControlOrMeta+z");

/** A Mind's note as the core holds it, read through the bridge. */
async function noteState(window: Page, mindId: string): Promise<string> {
  const update = await read(
    window,
    async (core, id) => Array.from((await core.openMind(id)).state),
    mindId,
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(update));
  return doc.getXmlFragment("blocks").toString();
}

const stateOf = (run: Run, stage: Stage, key: string): Promise<unknown> =>
  stage.inNote ? noteState(run.window, key) : coreState(run.window);

/**
 * Reads until two reads in a row agree and no Answer is still being written: what a command did,
 * once it has finished.
 */
async function settled(window: Page, readState: () => Promise<unknown>): Promise<unknown> {
  let last = JSON.stringify(await readState());
  for (const giveUp = Date.now() + 30_000; Date.now() < giveUp; ) {
    await motionSettled(window);
    const now = JSON.stringify(await readState());
    if (now === last && !now.includes('status=\\"streaming\\"')) return JSON.parse(now);
    last = now;
  }
  throw new Error(`The core kept changing: ${last.slice(-600)}`);
}

/**
 * Taking back what a command made (a new Folder) deletes it, so it waits in Recently deleted like
 * anything deleted. The state after ⌘Z, less what waits there now that didn't before: all that was
 * there before must still be there, and everything else must be as it was.
 */
function withoutTakenBack(state: unknown, before: unknown): unknown {
  const waiting = (of: unknown): { id: string }[] =>
    typeof of === "object" && of !== null && "deleted" in of && Array.isArray(of.deleted)
      ? of.deleted
      : [];
  if (waiting(state).length === 0 && waiting(before).length === 0) return state;
  const waited = new Set(waiting(before).map((item) => item.id));
  return {
    ...(state as object),
    deleted: waiting(state).filter((item) => waited.has(item.id)),
  };
}

const mindIdsOf = (state: unknown): string[] =>
  typeof state === "object" && state !== null && "minds" in state && Array.isArray(state.minds)
    ? state.minds.map((mind: { id: string }) => mind.id)
    : [];

/** Takes back the Minds a command made, as a person does: by deleting them. */
async function deleteMadeMinds(window: Page, before: unknown): Promise<void> {
  const known = new Set(mindIdsOf(before));
  for (const id of mindIdsOf(await coreState(window))) {
    if (!known.has(id)) await read(window, (core, mindId) => core.deleteMind(mindId), id);
  }
}

/** ⌘Z where it goes to the app's changes: out of any text; in the note, to the note's own. */
async function takeBack(window: Page, stage: Stage): Promise<void> {
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  if (stage.inNote) await window.getByTestId("mind-editor").first().focus();
  else await leaveText(window);
  await undo(window);
}

/**
 * Does what a person does with a row, again if the list drew it afresh under the pointer, as a
 * list that has just loaded does.
 */
const asPersonDoes = (act: () => Promise<void>) => expect(act).toPass({ timeout: 10_000 });

async function menuByRightClick(window: Page, place: Place): Promise<string[]> {
  await asPersonDoes(async () => {
    await pointAndClick(window, place.hit, { button: "right" });
    await expect(place.menu).toBeVisible({ timeout: 2_000 });
  });
  return menuCommands(place.menu);
}

/** The ⋯ button, or, where it is out of sight (a tab's), the keyboard's way to the same menu. */
async function menuByButton(window: Page, place: Place): Promise<string[]> {
  await asPersonDoes(async () => {
    await pointAt(window, place.hit);
    await place.row.hover();
    // A tab's ⋯ only anchors its menu, under the tab's own title: nobody can click it.
    const clickable = await place.button.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top !== null && button.contains(top);
    });
    if (clickable) await place.button.click();
    else {
      await place.hit.focus();
      await window.keyboard.press("Shift+F10");
    }
    await expect(place.menu).toBeVisible({ timeout: 2_000 });
  });
  return menuCommands(place.menu);
}

async function closeMenu(window: Page, place: Place): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(place.menu).toBeHidden();
}

/**
 * The menu the registry says these commands make, by rule 5: sections one after the other, in each
 * the groups in order and a rule between them, a command within its group where it was registered.
 */
function menuOf(shown: readonly string[], registry: Registry, kind: ObjectKind): string[] {
  const registered = registry.menus[kind] ?? [];
  const groupOf = (id: string) => registry.groups.indexOf(registry.commands[id]?.group ?? "");
  const placed = shown
    .filter((id) => id !== "—")
    .map((id) => ({
      id,
      section: registered.find((each) => each.id === id)?.section ?? -1,
      group: groupOf(id),
      at: registered.findIndex((each) => each.id === id),
    }))
    .sort((a, b) => a.section - b.section || a.group - b.group || a.at - b.at);
  return placed.flatMap((each, index) => {
    const before = placed[index - 1];
    return before && (before.section !== each.section || before.group !== each.group)
      ? ["—", each.id]
      : [each.id];
  });
}

/** Rename by double-click and by F2, Esc to cancel, Enter to save, and ⌘Z to undo. */
async function checkRename(run: Run, kind: ObjectKind, stage: Stage, key: string): Promise<void> {
  const { window } = run;
  const { name } = stage;
  if (!name) throw new Error(`${kind} renames, so its stage must say how to read its name.`);
  const original = await name(run, key);
  // The row swaps itself for the field while it renames, so the field is the one in focus.
  const field = window.locator("input:focus");

  // A double-click starts it; Esc keeps the old name.
  const place = await placeOf(run, kind, stage, key);
  await asPersonDoes(async () => {
    const point = await pointAt(window, stage.renameFrom?.doubleClick(run) ?? place.hit);
    await window.mouse.dblclick(point.x, point.y);
    await expect(field).toBeFocused({ timeout: 2_000 });
  });
  await noQuestion(window);
  await window.keyboard.type("Not this");
  await window.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  expect(await name(run, key)).toBe(original);

  // F2 on the row starts it; Enter saves; ⌘Z takes it back.
  const again = await placeOf(run, kind, stage, key);
  await (stage.renameFrom?.focus(run) ?? again.hit).focus();
  await window.keyboard.press("F2");
  await expect(field).toBeFocused();
  await window.keyboard.type("Renamed");
  await window.keyboard.press("Enter");
  await expect.poll(() => name(run, key)).toBe("Renamed");
  if (!stage.inNote) expect(await undoOffered(window)).toBe(true);
  await takeBack(window, stage);
  await expect.poll(() => name(run, key)).toBe(original);
}

/** Enter on the focused row opens it, and starts no rename. */
async function checkEnterOpens(run: Run, kind: ObjectKind, stage: Stage, key: string) {
  const { opened } = stage;
  if (!opened) throw new Error(`${kind} opens, so its stage must say what shows then.`);
  const { window } = run;
  const place = await placeOf(run, kind, stage, key);
  await place.hit.focus();
  await window.keyboard.press("Enter");
  await expect(opened(run, key)).toBeVisible();
  await expect(window.locator("input:focus")).toHaveCount(0);
}

/**
 * Runs a command from the menu a right-click opens. A reversible one that changed the core offered
 * Undo, and ⌘Z puts the core back; a delete asked nothing. An irreversible one asked first and
 * changed nothing.
 */
async function checkCommand(
  run: Run,
  kind: ObjectKind,
  stage: Stage,
  key: string,
  commandId: string,
  registry: Registry,
  through: "menu" | "palette" = "menu",
): Promise<"ran" | "not offered"> {
  const { window } = run;
  const command = registry.commands[commandId];
  if (!command) throw new Error(`${commandId} isn't in the registry.`);
  const place = await placeOf(run, kind, stage, key);
  const readState = () => stateOf(run, stage, key);
  const before = await settled(window, readState);

  if (through === "palette") {
    // ⌘K on its row acts on it; ">" lists the actions that apply.
    await place.hit.focus();
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(">");
    const item = window.getByTestId("palette").locator(`[data-key="command:${commandId}"]`);
    if ((await item.count()) === 0) {
      await window.keyboard.press("Escape");
      return "not offered";
    }
    await pointAndClick(window, item);
  } else {
    const shown = await menuByRightClick(window, place);
    const item = place.menu.getByTestId(commandId);
    if (!shown.includes(commandId) || (await item.getAttribute("aria-disabled")) === "true") {
      await closeMenu(window, place);
      return "not offered";
    }
    await pointAndClick(window, item);
  }

  if (!command.reversible) {
    await expect(window.locator("dialog[open]")).toBeVisible();
    expect
      .soft(await settled(window, readState), `${commandId} changed what it asked about`)
      .toEqual(before);
    await window.keyboard.press("Escape");
    await noQuestion(window);
    expect
      .soft(await settled(window, readState), `${commandId} changed things on Esc`)
      .toEqual(before);
    return "ran";
  }

  const after = await settled(window, readState);
  const changed = JSON.stringify(after) !== JSON.stringify(before);
  if (command.destructive) {
    await noQuestion(window);
    expect.soft(changed, `${commandId} deletes, so it changes the core`).toBe(true);
  }

  const known = NO_UNDO_YET[commandId];
  if (known) {
    // A fix gives it Undo, and this check says its entry goes.
    const gone = `${commandId} is taken back now: take it off NO_UNDO_YET (${known})`;
    expect.soft(changed, `${commandId} changes nothing now: take it off NO_UNDO_YET`).toBe(true);
    if (stage.inNote) {
      await takeBack(window, stage);
      expect.soft(await settled(window, readState), gone).not.toEqual(before);
    } else {
      expect.soft(await undoOffered(window), gone).toBe(false);
    }
    return "ran";
  }

  if (MAKES_A_MIND.has(commandId)) {
    expect.soft(changed, `${commandId} makes a Mind`).toBe(true);
    expect
      .soft(await undoOffered(window), `${commandId} makes a Mind and says nothing`)
      .toBe(false);
    await deleteMadeMinds(window, before);
  } else {
    // The note keeps its own undo, with no line.
    if (changed && !stage.inNote) {
      expect
        .soft(await undoOffered(window), `${commandId} changed the core, with no Undo`)
        .toBe(true);
    }
    if (changed || (await undoOffered(window))) await takeBack(window, stage);
    else await window.keyboard.press("Escape");
  }
  await expect
    .configure({ soft: true })
    .poll(async () => withoutTakenBack(await settled(window, readState), before), {
      message: `${commandId}, then ⌘Z`,
      timeout: 15_000,
    })
    .toEqual(before);
  return "ran";
}

/** ⌘K finds it by its name, among the objects of its kind. */
async function checkFoundInPalette(run: Run, kind: ObjectKind, stage: Stage, key: string) {
  const { window } = run;
  const name = await stage.name?.(run, key);
  if (!name) throw new Error(`⌘K finds ${kind} by name, so its stage must say how to read it.`);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(name);
  const found = window
    .getByTestId("palette")
    .locator(`[data-testid="palette-item"][data-kind="${kind}"]`)
    .filter({ hasText: name });
  await expect(found.first()).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("palette")).toBeHidden();
}

/** The one test of a kind: make it, then every check above, in one app. */
async function conform(run: Run, kind: ObjectKind, stage: Stage): Promise<void> {
  const { window } = run;
  const registry = await registryOf(window);
  const menu = registry.menus[kind];
  if (!menu) throw new Error(`${kind} has no registered menu, and isn't in NO_MENU_YET.`);
  const key = await stage.make(run);

  await test.step(`${kind}: right-click and ⋯ open one menu, in order`, async () => {
    const place = await placeOf(run, kind, stage, key);
    const byRightClick = await menuByRightClick(window, place);
    expect(byRightClick.length).toBeGreaterThan(0);
    expect(byRightClick).toEqual(menuOf(byRightClick, registry, kind));
    await closeMenu(window, place);
    expect(await menuByButton(window, place)).toEqual(byRightClick);
    await closeMenu(window, place);
  });

  if (menu.some((each) => registry.commands[each.id]?.renames)) {
    await test.step(`${kind}: renames in place`, () => checkRename(run, kind, stage, key));
  }
  if (menu.some((each) => each.id === `${kind}.open`)) {
    await test.step(`${kind}: Enter opens it`, () => checkEnterOpens(run, kind, stage, key));
  }

  const notOffered: string[] = [];
  for (const { id } of menu) {
    if (registry.commands[id]?.renames) continue;
    await test.step(`${kind}: ${id}`, async () => {
      const result = await checkCommand(run, kind, stage, key, id, registry);
      if (result === "not offered") notOffered.push(id);
    });
  }
  test
    .info()
    .annotations.push({ type: `${kind}: not offered here`, description: notOffered.join(" ") });

  if (registry.found.includes(kind)) {
    await test.step(`${kind}: found by name in ⌘K`, () =>
      checkFoundInPalette(run, kind, stage, key));
    const removal = menu.find(({ id }) => {
      const command = registry.commands[id];
      return command?.destructive && command.reversible;
    });
    if (removal) {
      await test.step(`${kind}: ${removal.id} from ⌘K`, async () => {
        const result = await checkCommand(run, kind, stage, key, removal.id, registry, "palette");
        expect(result, `${removal.id} is offered in ⌘K on its row`).toBe("ran");
      });
    }
  }
}

const folderOnDisk = async (name: string) => {
  const folder = join(sources, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Reading notes.md"), "# Notes\n\nAttention lets a model focus.\n");
  return folder;
};

const mindTitle = (run: Run, mindId: string) =>
  read(
    run.window,
    async (core, id) => (await core.listMinds()).find((mind) => mind.id === id)?.title ?? "",
    mindId,
  );

const mindTab = (window: Page, mindId: string) =>
  window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);

/** Opens a Mind from the sidebar unless its tab is there, and gives that tab's ID. */
async function showMind(window: Page, mindId: string): Promise<string> {
  await showView(window, "Folders");
  const tab = mindTab(window, mindId).first();
  if ((await tab.count()) === 0) {
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-list-item"][data-mind-id="${mindId}"]`),
    );
    await expect(tab).toBeVisible();
  }
  return (await tab.getAttribute("data-tab-id")) ?? "";
}

/** The ID of the first object of a kind in the Mind's note, as its ⋯ button carries it. */
async function showInNote(window: Page, mindId: string, kind: ObjectKind): Promise<string> {
  await showMind(window, mindId);
  await pointAndClick(window, mindTab(window, mindId).first());
  const button = window
    .getByTestId("mind-editor")
    .locator(`[data-object-menu^="${kind}:"]`)
    .first();
  await expect(button).toBeAttached();
  return ((await button.getAttribute("data-object-menu")) ?? "").slice(kind.length + 1);
}

/** A Mind holding a bar chart of three quarters, written as the editor stores a chart (#436). */
async function mindWithChart(window: Page): Promise<string> {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", crypto.randomUUID());
  paragraph.insert(0, [new Y.XmlText("Revenue by quarter.")]);
  const chart = new Y.XmlElement("chart");
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
  doc.getXmlFragment("blocks").push([paragraph, chart]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Figures" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
    return mind.id;
  }, update);
}

/** A Mind holding a comparison table of one row and two columns, written as the editor stores one (#98). */
async function mindWithComparison(window: Page): Promise<string> {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", crypto.randomUUID());
  paragraph.insert(0, [new Y.XmlText("Supplier terms.")]);
  const questions = [
    { id: crypto.randomUUID(), text: "Termination notice" },
    { id: crypto.randomUUID(), text: "Liability cap" },
  ];
  const table = new Y.XmlElement("comparisonTable");
  table.setAttribute("id", crypto.randomUUID());
  table.setAttribute("questions", questions as never);
  const row = new Y.XmlElement("comparisonRow");
  row.setAttribute("documentId", crypto.randomUUID());
  row.setAttribute("documentName", "Corvane Agreement.txt");
  for (const [at, question] of questions.entries()) {
    const cell = new Y.XmlElement("comparisonCell");
    cell.setAttribute("questionId", question.id);
    cell.setAttribute("status", "failed");
    cell.setAttribute("problem", "source-removed");
    const line = new Y.XmlElement("paragraph");
    line.setAttribute("id", crypto.randomUUID());
    cell.insert(0, [line]);
    row.insert(at, [cell]);
  }
  table.insert(0, [row]);
  doc.getXmlFragment("blocks").push([paragraph, table]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Suppliers" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
    return mind.id;
  }, update);
}

/** A Mind holding a comparison table of two real Documents, for its rows' menus (#1837). */
async function mindWithComparisonRows(window: Page, dir: string): Promise<string> {
  await writeFile(join(dir, "Corvane.txt"), "Termination notice: 90 days.\n");
  await writeFile(join(dir, "Halvard.txt"), "Termination notice: 6 months.\n");
  await addDocuments(window, [join(dir, "Corvane.txt"), join(dir, "Halvard.txt")]);
  const documents = await read(window, (core) =>
    core.listDocuments().then((all) => all.map(({ id, name }) => ({ id, name }))),
  );
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", crypto.randomUUID());
  paragraph.insert(0, [new Y.XmlText("Supplier terms.")]);
  const table = new Y.XmlElement("comparisonTable");
  table.setAttribute("id", crypto.randomUUID());
  const question = { id: crypto.randomUUID(), text: "Termination notice" };
  table.setAttribute("questions", [question] as never);
  for (const document of documents) {
    const row = new Y.XmlElement("comparisonRow");
    row.setAttribute("documentId", document.id);
    row.setAttribute("documentName", document.name);
    const cell = new Y.XmlElement("comparisonCell");
    cell.setAttribute("questionId", question.id);
    cell.setAttribute("status", "failed");
    cell.setAttribute("problem", "not-found");
    const line = new Y.XmlElement("paragraph");
    line.setAttribute("id", crypto.randomUUID());
    cell.insert(0, [line]);
    row.insert(0, [cell]);
    table.insert(table.length, [row]);
  }
  doc.getXmlFragment("blocks").push([paragraph, table]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Suppliers" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
    return mind.id;
  }, update);
}

/** A Mind holding one checked sentence the check found nothing in the Documents for (#1608). */
async function mindWithCheck(window: Page): Promise<string> {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", crypto.randomUUID());
  const text = new Y.XmlText();
  text.insert(0, "Penguins nest on the harbour cliffs.", {
    claimCheck: {
      id: crypto.randomUUID(),
      request: "request-1",
      action: "check-against-documents",
      state: "unsupported",
      reason: null,
      detail: null,
      text: "Penguins nest on the harbour cliffs.",
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-26T09:00:00.000Z",
    },
  });
  paragraph.insert(0, [text]);
  doc.getXmlFragment("blocks").push([paragraph]);
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(async (change) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "Checks" });
    await core.applyMindUpdate(mind.id, new Uint8Array(change));
    await core.closeMind(mind.id);
    return mind.id;
  }, update);
}
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

type Staged = Exclude<ObjectKind, keyof typeof NO_MENU_YET>;

const STAGES: Record<Staged, Stage> = {
  mind: {
    make: ({ window }) =>
      read(window, async (core) => (await core.createMind({ title: "Shortlist" })).id),
    async show({ window }, key) {
      await showView(window, "Folders");
      return key;
    },
    name: mindTitle,
    opened: ({ window }, key) => mindTab(window, key).and(window.locator('[aria-selected="true"]')),
  },
  document: {
    async make({ window, sources: dir }) {
      const path = join(dir, "Tides.txt");
      await writeFile(path, "Neap tides are the smallest of the month.\n");
      await addDocuments(window, [path]);
      return read(window, async (core) => (await core.listDocuments())[0]?.id ?? "");
    },
    async show({ window }, key) {
      await showView(window, "Folders");
      return key;
    },
    name: ({ window }, key) =>
      read(
        window,
        async (core, id) => (await core.listDocuments()).find((each) => each.id === id)?.name ?? "",
        key,
      ),
    opened: ({ window }) => window.getByTestId("viewer-header"),
  },
  folder: {
    // With a Document in it, so there is something to ask about and to organize.
    async make({ window, sources: dir }) {
      const path = join(dir, "Invoice.txt");
      await writeFile(path, "Invoice 4471: the rent for October is due on the first.\n");
      await addDocuments(window, [path]);
      return read(window, async (core) => {
        const folder = await core.createLibraryGroup({ name: "Finance", description: "" });
        const [document] = await core.listDocuments();
        if (document) await core.assignDocumentGroup(document.id, folder.id);
        return folder.id;
      });
    },
    async show({ window }, key) {
      await showView(window, "Folders");
      return key;
    },
    name: ({ window }, key) =>
      read(
        window,
        async (core, id) =>
          (await core.getLibrary()).groups.find((each) => each.id === id)?.name ?? "",
        key,
      ),
    // In the sidebar a Folder opens by unfolding, as a click does; "Open in the Library" is in its menu.
    opened: ({ window }) => window.locator('[data-testid="folder-row"][aria-expanded="true"]'),
  },
  tag: {
    // The Tags section is there once a Document has a Tag.
    async make({ window, sources: dir }) {
      const path = join(dir, "Tides.txt");
      await writeFile(path, "Neap tides are the smallest of the month.\n");
      await addDocuments(window, [path]);
      return read(window, async (core) => {
        const tag = await core.createTag({ name: "Tides" });
        const [document] = await core.listDocuments();
        if (document) await core.addDocumentTag(document.id, tag.id);
        return tag.id;
      });
    },
    async show({ window }, key) {
      await showView(window, "Tags");
      return key;
    },
    name: ({ window }, key) =>
      read(
        window,
        async (core, id) => (await core.listTags()).find((each) => each.id === id)?.name ?? "",
        key,
      ),
    opened: ({ window }) => window.getByTestId("library"),
  },
  linkedFolder: {
    async make({ app, window }) {
      await linkFolderFromSidebar(app, window, await folderOnDisk("Library"));
      return read(window, async (core) => (await core.listLinkedFolders())[0]?.id ?? "");
    },
    async show({ window }, key) {
      await showSourceLocations(window);
      return key;
    },
  },
  deleted: {
    make: ({ window }) =>
      read(window, async (core) => {
        await core.deleteMind((await core.createMind({ title: "Old notes" })).id);
        return (await core.listDeleted())[0]?.id ?? "";
      }),
    async show({ window }, key) {
      await pointAndClick(window, window.getByTestId("open-library"));
      // Recently deleted is a folded section at the foot of the Library's page.
      const heading = window.getByTestId("deleted-heading");
      await expect(heading).toBeVisible();
      if ((await heading.getAttribute("aria-expanded")) !== "true") {
        await pointAndClick(window, heading);
      }
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      return key;
    },
  },
  // A tab is a Mind's: its key is the Mind's, and its ID the tab's, which is new each time it opens.
  tab: {
    // Beside another Mind's tab, so there are tabs to close and to move.
    async make({ window }) {
      const [first, second] = await read(window, async (core) => [
        (await core.createMind({ title: "Shortlist" })).id,
        (await core.createMind({ title: "Vendors" })).id,
      ]);
      await showMind(window, first ?? "");
      await showMind(window, second ?? "");
      return first ?? "";
    },
    show: ({ window }, key) => showMind(window, key),
    name: mindTitle,
    opened: ({ window }, key) => mindTab(window, key).and(window.locator('[aria-selected="true"]')),
  },
  answer: {
    inNote: true,
    async make({ window }) {
      return mindWrittenBefore(window, "Tide questions", [
        { question: "When do spring tides happen?", answer: "At new moon and at full moon." },
      ]);
    },
    show: ({ window }, key) => showInNote(window, key, "answer"),
  },
  citation: {
    inNote: true,
    async make({ window, sources: dir }) {
      await writeFile(join(dir, "Tides.pdf"), TIDES);
      await addDocuments(window, [join(dir, "Tides.pdf")]);
      await newMind(window);
      await nameMind(window, "Cited notes");
      const editor = window.getByTestId("mind-editor");
      await editor.click();
      await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
      await expect(editor.getByTestId("citation")).toHaveCount(1);
      return read(window, async (core) => (await core.listMinds())[0]?.id ?? "");
    },
    show: ({ window }, key) => showInNote(window, key, "citation"),
    hit: ({ window }) => window.getByTestId("mind-editor").getByTestId("citation-chip").first(),
    opened: ({ window }) => window.getByTestId("viewer-header"),
  },
  chart: {
    inNote: true,
    make: ({ window }) => mindWithChart(window),
    show: ({ window }, key) => showInNote(window, key, "chart"),
    async name({ window }, key) {
      const note = await noteState(window, key);
      return /<chart [^>]*\btitle="([^"]*)"/.exec(note)?.[1] ?? "";
    },
    renameFrom: {
      doubleClick: ({ window }) => window.getByTestId("chart").getByTestId("chart-title"),
      focus: ({ window }) => window.getByTestId("chart").getByTestId("chart-show-table"),
    },
  },
  // The key is the Mind's; its first column's heading names the object.
  comparisonColumn: {
    inNote: true,
    make: ({ window }) => mindWithComparison(window),
    show: ({ window }, key) => showInNote(window, key, "comparisonColumn"),
    // Its key is the Mind's; the first column's heading is the one its menu acts on.
    name: ({ window }) =>
      window
        .locator('[data-testid="comparison-question"] .comparison-question-label')
        .first()
        .innerText(),
  },
  // The key is the Mind's; the table's own name is what its menu renames.
  comparisonTable: {
    inNote: true,
    make: ({ window }) => mindWithComparison(window),
    show: ({ window }, key) => showInNote(window, key, "comparisonTable"),
    async name({ window }, key) {
      const note = await noteState(window, key);
      // Yjs writes a node's name in lowercase: <comparisontable …>.
      return /<comparisontable [^>]*\btitle="([^"]*)"/i.exec(note)?.[1] ?? "";
    },
    renameFrom: {
      doubleClick: ({ window }) => window.getByTestId("comparison-name").first(),
      focus: ({ window }) => window.getByTestId("comparison-head").first(),
    },
  },
  // The key is the Mind's; the first row's head is the one its menu acts on.
  comparisonRow: {
    inNote: true,
    make: ({ window, sources: dir }) => mindWithComparisonRows(window, dir),
    show: ({ window }, key) => showInNote(window, key, "comparisonRow"),
    opened: ({ window }) => window.getByTestId("viewer-header"),
  },
  comparisonCell: {
    inNote: true,
    make: ({ window }) => mindWithComparison(window),
    show: ({ window }, key) => showInNote(window, key, "comparisonCell"),
    name: ({ window }) =>
      window.getByTestId("comparison-cell").first().locator(".comparison-cell-content").innerText(),
    renameFrom: {
      doubleClick: ({ window }) => window.getByTestId("comparison-cell").first(),
      focus: ({ window }) => window.getByTestId("comparison-cell").first(),
    },
    hit: ({ window }) => window.getByTestId("comparison-cell").first(),
    opened: ({ window }) => window.getByTestId("comparison-cell-card"),
  },
  check: {
    inNote: true,
    make: ({ window }) => mindWithCheck(window),
    async show({ window }, key) {
      await showMind(window, key);
      await pointAndClick(window, mindTab(window, key).first());
      const card = window.getByTestId("claim-card");
      if (!(await card.isVisible())) {
        await pointAndClick(window, window.getByTestId("claim-mark").first());
      }
      await expect(card).toBeVisible();
      return (await window.getByTestId("claim-mark").first().getAttribute("data-claim")) ?? "";
    },
  },
};

// Each kind is one test, on its own app and folders, so CI's shards can take them one by one.
test.describe.configure({ mode: "parallel" });

for (const kind of OBJECT_KINDS) {
  if (kind in NO_MENU_YET) continue;
  const stage = STAGES[kind as Staged];
  test(`${kind}: one menu, rename in place, every command and Undo`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: homeDir });
    await interceptOpenPath(app);
    await interceptShowItemInFolder(app);
    await interceptOpenExternal(app);
    await interceptOpenDialog(app, sources);
    await stubClipboard(window);
    // Copy path and Copy address write text, which the stub leaves alone.
    await window.evaluate(() => {
      navigator.clipboard.writeText = async () => undefined;
    });
    await dismissChatSetup(window);
    // The scripted model answers the Questions a kind asks.
    await useLocalChatModel(window);
    // Organize runs when asked, not by itself, and not into Settings for want of a model.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
    });
    // Exports save where the User chose, without asking again.
    await useOutputLocation(window, sources);
    await conform({ app, window, sources }, kind, stage);
  });
}
