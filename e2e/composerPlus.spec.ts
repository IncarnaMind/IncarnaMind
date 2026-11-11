import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  askFirstQuestion,
  askInAssistant,
  boxOf,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  openFolderInLibrary,
  paletteOffers,
  placeAssistant,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  sizeAssistant,
  useLocalChatModel,
} from "./app";

/*
 * The + at the left of the chat box (#2924): its menu opens above it by mouse and by keyboard;
 * each row does what "/", "@" or ⌘K already does; Add files… makes the files Documents and puts
 * their chips in the Search scope; at the narrowest panel + stays whole while the model's name is
 * cut first. The system's open dialog is answered by the test, as in the other specs.
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

const pdf = async (name: string, line: string): Promise<string> => {
  const path = join(sources, `${name}.pdf`);
  await writeFile(path, buildPdf([{ lines: [name, line] }]));
  return path;
};

const parts = (window: Page) => ({
  composer: window.getByTestId("composer"),
  plus: window.getByTestId("composer-plus"),
  menu: window.getByTestId("composer-plus-menu"),
  skillsMenu: window.getByTestId("composer-plus-skills-menu"),
});

const documentsOf = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDocuments({})).map((each) => each.name).sort();
  });

/** Each Document and the Folder it is filed in (null: in none), as the core has them. */
const filingOf = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { assignments } = await core.getLibrary();
    return (await core.listDocuments({})).map((each) => ({
      name: each.name,
      groupId: assignments.find((item) => item.documentId === each.id)?.groupId ?? null,
    }));
  });

const chipNames = (composer: Locator) =>
  composer.getByTestId("scope-chip").locator(".truncate").allTextContents();

test("the + opens its menu above it by mouse and by keyboard, in order with its keys; Esc closes the innermost menu and gives the focus back to +, twice in a row", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  const { composer, plus, menu, skillsMenu } = parts(window);

  await expect(plus).toHaveAccessibleName("Add files and more");
  await expect(plus).toHaveAttribute("title", "Add files and more");
  const [plusBox, askBox, modelBox, composerBox] = await Promise.all([
    boxOf(plus),
    boxOf(composer.getByTestId("composer-ask")),
    boxOf(composer.getByTestId("composer-model")),
    boxOf(composer),
  ]);
  // A square button, never squeezed: as wide as it is tall.
  expect(plusBox.width).toBeCloseTo(plusBox.height, 1);
  expect(plusBox.x).toBeGreaterThanOrEqual(composerBox.x);
  expect(plusBox.x + plusBox.width).toBeLessThan(modelBox.x);
  // On the row of Ask, centred on it.
  expect(Math.abs(plusBox.y + plusBox.height / 2 - (askBox.y + askBox.height / 2))).toBeLessThan(2);

  for (let round = 0; round < 2; round++) {
    // The mouse: the menu opens above the button.
    await pointAndClick(window, plus);
    await expect(menu).toBeVisible();
    await motionSettled(window);
    const menuBox = await boxOf(menu);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(plusBox.y + 1);
    await expect(menu.getByRole("menuitem")).toHaveText([
      /^Add files…$/,
      /^Add a note or Document…@$/,
      /^Research…\/$/,
      /^Skills\/$/,
      /^Compare Documents…$/,
    ]);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(plus).toBeFocused();

    // The keyboard: Enter opens, the arrows move, → opens Skills.
    await window.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("composer-plus-files")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("composer-plus-note")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("composer-plus-research")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("composer-plus-skills")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(menu.getByTestId("composer-plus-research")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowRight");
    await expect(skillsMenu).toBeVisible();
    await expect(skillsMenu.getByRole("menuitem").first()).toBeFocused();
    // Esc closes the innermost menu, back on its row; the next closes the menu, back on +.
    await window.keyboard.press("Escape");
    await expect(skillsMenu).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("composer-plus-skills")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(plus).toBeFocused();

    // Space opens it too.
    await window.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(plus).toBeFocused();
  }
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  const words =
    language === "en"
      ? { manage: "Manage Skills…", skills: "Skills", research: "Research…" }
      : { manage: "管理技能…", skills: "技能", research: "研究…" };

  test(`Research…, a Skill, Manage Skills…, Add a note or Document and Compare Documents… each do what "/" or ⌘K does (${language})`, async () => {
    await writeFile(join(sources, "Tides.txt"), "Spring tides follow the new moon.\n");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await (await coreOf(window)).evaluate(
      async (core: CoreBridge, path: string) => {
        await core.addDocuments([path]);
      },
      join(sources, "Tides.txt"),
    );
    const { composer, plus, menu, skillsMenu } = parts(window);
    const input = composer.getByTestId("composer-input");
    const open = async () => {
      await pointAndClick(window, plus);
      await expect(menu).toBeVisible();
    };
    await expect(menu.getByRole("menuitem")).toHaveCount(0);
    await expect(plus).toHaveAccessibleName(
      language === "en" ? "Add files and more" : "添加文件等",
    );

    // Research…: the same chip as choosing it from "/".
    await open();
    await expect(menu.getByTestId("composer-plus-research")).toContainText(words.research);
    await pointAndClick(window, menu.getByTestId("composer-plus-research"));
    await expect(menu).toBeHidden();
    const research = composer.getByTestId("composer-research");
    await expect(research).toBeVisible();
    await expect(input).toBeFocused();
    await pointAndClick(window, composer.getByTestId("composer-research-remove"));
    await expect(research).toHaveCount(0);
    await input.click();
    await window.keyboard.type("/");
    await window.keyboard.press("Enter");
    await expect(research).toBeVisible();
    await pointAndClick(window, composer.getByTestId("composer-research-remove"));

    // A Skill: the same chip as "/" gives it.
    await open();
    await expect(menu.getByTestId("composer-plus-skills")).toContainText(words.skills);
    await pointAndClick(window, menu.getByTestId("composer-plus-skills"));
    await expect(skillsMenu).toBeVisible();
    const listed = await skillsMenu.getByRole("menuitem").allTextContents();
    expect(listed.at(-1)).toBe(words.manage);
    await pointAndClick(window, skillsMenu.getByTestId("composer-plus-skill-covenant-summary"));
    await expect(menu).toBeHidden();
    const skill = composer.getByTestId("composer-skill");
    await expect(skill).toHaveAttribute("data-state", "enabled");
    const chosen = await skill.textContent();
    await pointAndClick(window, composer.getByTestId("composer-skill-remove"));
    await input.click();
    await window.keyboard.type("/");
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("Enter");
    await expect(skill).toHaveText(chosen ?? "");
    await pointAndClick(window, composer.getByTestId("composer-skill-remove"));

    // Manage Skills…: Settings › Skills, and the last row of both lists, under a rule, as "/" has it.
    const ruleAbove = (row: Locator) =>
      row.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth) > 0);
    await open();
    await pointAndClick(window, menu.getByTestId("composer-plus-skills"));
    const manage = skillsMenu.getByTestId("composer-plus-manage-skills");
    await expect(manage).toHaveText(words.manage);
    expect(
      await manage.evaluate(
        (element) =>
          element.previousElementSibling !== null &&
          Number.parseFloat(getComputedStyle(element.previousElementSibling).borderTopWidth) > 0,
      ),
    ).toBe(true);
    await pointAndClick(window, manage);
    await expect(window.getByTestId("skills-settings")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("skills-settings")).toBeHidden();
    await input.click();
    await window.keyboard.type("/");
    const slashManage = window.getByTestId("composer-skills-manage");
    await expect(slashManage).toHaveText(words.manage);
    expect(await ruleAbove(slashManage)).toBe(true);
    await pointAndClick(window, slashManage);
    await expect(window.getByTestId("skills-settings")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("skills-settings")).toBeHidden();
    await input.click();
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("Backspace");

    // Add a note or Document: the "@" picker, which adds the same chip "@" adds.
    await open();
    await pointAndClick(window, menu.getByTestId("composer-plus-note"));
    await expect(menu).toBeHidden();
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    await expect(input).toHaveValue("@");
    await window.keyboard.type("Tides");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("scope-picker")).toBeHidden();
    await expect.poll(() => chipNames(composer)).toEqual(["Tides"]);
    await expect(input).toHaveValue("");

    // Compare Documents…: what ⌘K's command opens.
    await open();
    await pointAndClick(window, menu.getByTestId("composer-plus-compare"));
    await expect(window.getByTestId("compare-sheet")).toBeVisible();

    // "@" and "/" typed in the box work as before.
    await input.click();
    await window.keyboard.type("/");
    await expect(window.getByTestId("composer-skill-picker")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("composer-skill-picker")).toBeHidden();
    await window.keyboard.press("Backspace");
    await window.keyboard.type("@");
    await expect(window.getByTestId("scope-picker")).toBeVisible();
    await app.close();
  });
}

test("with no Skill turned on, Skills holds only Manage Skills…", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    for (const skill of await core.listSkills()) await core.setSkillEnabled(skill.id, false);
  });
  const { plus, menu, skillsMenu } = parts(window);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-skills"));
  await expect(skillsMenu.getByRole("menuitem")).toHaveText(["Manage Skills…"]);
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(plus).toBeFocused();
  await app.close();
});

test("Add files… from the + and from ⌘K makes the picked files Documents and chips in the Search scope, one Document for a file already there, and says a file it can't take", async () => {
  const tides = await pdf("Tides", "Spring tides follow the new moon.");
  const leases = await pdf("Lease", "The break clause is on 1 June.");
  const notes = join(sources, "notes.xyz");
  await writeFile(notes, "A file IncarnaMind doesn't read.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  // Room for a chip for each file; the narrow panel folds them into a count (below).
  await sizeAssistant(window, 560);
  const { composer, plus, menu } = parts(window);
  expect(await documentsOf(window)).toEqual([]);
  // One of the two is a Document already, though in no Search scope.
  await (await coreOf(window)).evaluate(async (core: CoreBridge, path: string) => {
    await core.addDocuments([path]);
  }, leases);
  await expect.poll(() => documentsOf(window)).toEqual(["Lease"]);

  // Two files at once, by mouse: a chip for each, and one Document for each.
  await interceptOpenDialog(app, [tides, leases]);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  await expect(composer.getByTestId("scope-chip")).toHaveCount(2);
  expect((await chipNames(composer)).length).toBe(2);
  await expect.poll(() => documentsOf(window)).toEqual(["Lease", "Tides"]);
  // The chips are in the Search scope, which is no longer All Documents.
  await expect(composer.getByTestId("composer-scope-all")).toHaveCount(0);
  await expect(composer.getByTestId("composer-ask")).toBeVisible();
  const composerBox = await boxOf(composer);
  const askBox = await boxOf(composer.getByTestId("composer-ask"));
  expect(askBox.x + askBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);

  // ⌘K offers the command while the box is drawn.
  expect(await paletteOffers(window, "composer.addFiles", "add files to the chat")).toBe(1);

  // The same file again, from ⌘K: no second Document and no second chip.
  await interceptOpenDialog(app, [tides]);
  await runCommand(window, "composer.addFiles", "Add files to the chat");
  await expect(window.getByTestId("palette")).toBeHidden();
  await expect.poll(() => documentsOf(window)).toEqual(["Lease", "Tides"]);
  await expect(composer.getByTestId("scope-chip")).toHaveCount(2);

  // A file it can't take is said where the files were added, and the others still join.
  const fresh = await pdf("Charter", "The laytime is 72 hours.");
  await interceptOpenDialog(app, [notes, fresh]);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  await expect.poll(() => documentsOf(window)).toEqual(["Charter", "Lease", "Tides"]);
  const said = composer.getByTestId("composer-skipped-files");
  await expect(said).toContainText("notes.xyz");
  await expect(composer.getByTestId("scope-chip")).toHaveCount(3);
  await app.close();
});

test("behind a Folder wall, Add files… files the new Documents in that Folder, which the Question already searches, and adds no chip", async () => {
  const lease = await pdf("Lease", "The break clause is on 1 June.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  const { folderId, mindId } = await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    const folder = await core.createLibraryGroup({ name: "Matter A", description: "" });
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });
    const mind = await core.createMind({ title: "Matter note", folderId: folder.id });
    return { folderId: folder.id, mindId: mind.id };
  });
  const folderRow = sidebarFolder(window, "Matter A").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
  await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
  const { composer, plus, menu } = parts(window);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");

  await interceptOpenDialog(app, lease);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  await expect
    .poll(() => filingOf(window))
    .toEqual([{ name: expect.stringContaining("Lease"), groupId: folderId }]);
  await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-kind", "folder");
  await expect(composer.getByTestId("composer-outside-wall")).toHaveCount(0);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`behind a Folder wall, a picked file that is a Document outside it is named in the box as not searched, and is not moved (${language})`, async () => {
    const lease = await pdf("Lease", "The break clause is on 1 June.");
    const charter = await pdf("Charter", "The laytime is 72 hours.");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    const { folderId, mindId } = await (await coreOf(window)).evaluate(
      async (core: CoreBridge, paths: string[]) => {
        const folder = await core.createLibraryGroup({ name: "Matter A", description: "" });
        await core.updateLibraryGroup(folder.id, {
          name: folder.name,
          description: "",
          keepInside: true,
        });
        const mind = await core.createMind({ title: "Matter note", folderId: folder.id });
        // Both are Documents already, in no Folder.
        await core.addDocuments(paths);
        return { folderId: folder.id, mindId: mind.id };
      },
      [lease, charter],
    );
    await expect
      .poll(() => filingOf(window))
      .toEqual([
        { name: expect.stringContaining("Charter"), groupId: null },
        { name: expect.stringContaining("Lease"), groupId: null },
      ]);
    const folderRow = sidebarFolder(window, "Matter A").getByTestId("folder-row");
    if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
    await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
    const { composer, plus, menu } = parts(window);
    await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");

    await interceptOpenDialog(app, [lease, charter]);
    await pointAndClick(window, plus);
    await pointAndClick(window, menu.getByTestId("composer-plus-files"));
    const said = composer.getByTestId("composer-outside-wall");
    await expect(said).toBeVisible();
    await expect(said).toContainText("Lease");
    await expect(said).toContainText("Charter");
    await expect(said).toContainText("Matter A");
    expect(await said.innerText()).toMatch(
      language === "en"
        ? /outside “Matter A”, so this Question doesn’t search them/
        : /不在“Matter A”里/,
    );
    // Not searched, not moved: the Folder's own chip alone, and both Documents where they were.
    await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
    await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-kind", "folder");
    expect((await filingOf(window)).map((each) => each.groupId)).toEqual([null, null]);
    expect(folderId).toBeTruthy();
    // It stays until the User closes it.
    await pointAndClick(window, said.getByRole("button"));
    await expect(said).toHaveCount(0);
    await app.close();
  });
}

/**
 * Two walled Folders with Notes in them, and two Documents in no Folder. The first Note is open
 * and both Documents are picked with Add files…: the line for what its Question can't search is up.
 */
async function lineIsUp(app: ElectronApplication, window: Page) {
  const lease = await pdf("Lease", "The break clause is on 1 June.");
  const charter = await pdf("Charter", "The laytime is 72 hours.");
  await setWindowSize(app, window, 1600, 900);
  const notes = await (await coreOf(window)).evaluate(
    async (core: CoreBridge, paths: string[]) => {
      const wall = async (name: string) => {
        const folder = await core.createLibraryGroup({ name, description: "" });
        await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
        return folder.id;
      };
      const a = await wall("Matter A");
      const b = await wall("Matter B");
      const first = await core.createMind({ title: "Note A1", folderId: a });
      const second = await core.createMind({ title: "Note A2", folderId: a });
      const other = await core.createMind({ title: "Note B1", folderId: b });
      await core.addDocuments(paths);
      return { first: first.id, second: second.id, other: other.id };
    },
    [lease, charter],
  );
  for (const name of ["Matter A", "Matter B"]) {
    const row = sidebarFolder(window, name).getByTestId("folder-row");
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  }
  const open = (id: string) =>
    window.locator(`[data-testid="mind-row"][data-mind-id="${id}"]`).first().click();
  await open(notes.first);
  const { composer, plus, menu } = parts(window);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");
  const pick = async (...picked: string[]) => {
    await interceptOpenDialog(app, picked);
    await pointAndClick(window, plus);
    await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  };
  await pick(lease, charter);
  const line = composer.getByTestId("composer-outside-wall");
  await expect(line).toBeVisible();
  return { composer, line, notes, open, pick };
}

test("the line for a file outside the wall goes when the Question is asked", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { composer, line } = await lineIsUp(app, window);
  await composer.getByTestId("composer-input").click();
  await window.keyboard.type("What does the break clause say?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant").getByTestId("assistant-question")).toHaveCount(1);
  await expect(line).toHaveCount(0);
  await app.close();
});

test("the line for a file outside the wall goes on the next Add files…", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { line, pick } = await lineIsUp(app, window);
  await pick(await pdf("Tariff", "The berth fee is 9 dollars."));
  await expect(line).toHaveCount(0);
  await app.close();
});

test("the line for a file outside the wall goes when the box moves to another note behind the same Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { composer, line, notes, open } = await lineIsUp(app, window);
  await open(notes.second);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");
  await expect(line).toHaveCount(0);
  await app.close();
});

test("the line for a file outside the wall does not follow the box into a note behind a different Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { composer, line, notes, open } = await lineIsUp(app, window);
  await open(notes.other);
  await expect(composer.getByTestId("scope-chip")).toContainText("Matter B");
  await expect(line).toHaveCount(0);
  await app.close();
});

test("the line for a file outside the wall goes when the walled Folder the Library shows changes", async () => {
  const lease = await pdf("Lease", "The break clause is on 1 June.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  await (await coreOf(window)).evaluate(async (core: CoreBridge, path: string) => {
    for (const name of ["Matter A", "Matter B"]) {
      const folder = await core.createLibraryGroup({ name, description: "" });
      await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
    }
    await core.addDocuments([path]);
  }, lease);
  await openFolderInLibrary(window, "Matter A");
  const { composer, plus, menu } = parts(window);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");
  await interceptOpenDialog(app, lease);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  const line = composer.getByTestId("composer-outside-wall");
  await expect(line).toBeVisible();
  await openFolderInLibrary(window, "Matter B");
  await expect(composer.getByTestId("scope-chip")).toContainText("Matter B");
  await expect(line).toHaveCount(0);
  await app.close();
});

test("with no Note open, the walled Folder the Library shows is the Folder Add files… files into, not the wall of the conversation it joins", async () => {
  const lease = await pdf("Lease", "The break clause is on 1 June.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  const ids = await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    const wall = async (name: string) => {
      const folder = await core.createLibraryGroup({ name, description: "" });
      await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
      return folder.id;
    };
    const a = await wall("Matter A");
    const b = await wall("Matter B");
    const note = await core.createMind({ title: "Matter note", folderId: a });
    return { b, note: note.id };
  });
  const folderRow = sidebarFolder(window, "Matter A").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
  await window.locator(`[data-testid="mind-row"][data-mind-id="${ids.note}"]`).first().click();
  await askInAssistant(window, "What is the notice?");
  // The Note closes; the conversation, filed in Matter A, stays open in the assistant.
  await window.getByTestId("mind-editor").first().click();
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("mind-editor")).toHaveCount(0);
  const { composer, plus, menu } = parts(window);
  await expect(composer.getByTestId("scope-chip")).toContainText("Matter A");

  await openFolderInLibrary(window, "Matter B");
  await expect(composer.getByTestId("scope-chip")).toContainText("Matter B");
  await interceptOpenDialog(app, lease);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  await expect
    .poll(() => filingOf(window))
    .toEqual([{ name: expect.stringContaining("Lease"), groupId: ids.b }]);
  await app.close();
});

test("with no Note open and the Library showing a walled Folder, Add files… files the new Documents in that Folder and adds no chip", async () => {
  const lease = await pdf("Lease", "The break clause is on 1 June.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  const folderId = await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    const folder = await core.createLibraryGroup({ name: "Matter B", description: "" });
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });
    return folder.id;
  });
  await openFolderInLibrary(window, "Matter B");
  const { composer, plus, menu } = parts(window);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");

  await interceptOpenDialog(app, lease);
  await pointAndClick(window, plus);
  await pointAndClick(window, menu.getByTestId("composer-plus-files"));
  await expect
    .poll(() => filingOf(window))
    .toEqual([{ name: expect.stringContaining("Lease"), groupId: folderId }]);
  await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-kind", "folder");
  await expect(composer.getByTestId("composer-outside-wall")).toHaveCount(0);
  await app.close();
});

/** What the row shows, read from the page: its chips, the count, the model's name and whether the controls hold. */
interface RowState {
  chips: {
    text: string;
    width: number;
    floor: number;
    showsFirstSix: boolean;
    nameCut: boolean;
    hint: { whole: boolean } | null;
  }[];
  count: string | null;
  model: { text: string; cut: boolean };
  holds: boolean;
}

const rowState = (composer: Locator): Promise<RowState> =>
  composer.evaluate((root) => {
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) throw new Error("There is no canvas to measure the names on.");
    const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="scope-chip"]')).map(
      (item) => {
        const name = item.querySelector<HTMLElement>(".truncate");
        const text = name?.textContent ?? "";
        if (name) canvas.font = getComputedStyle(name).font;
        const letters = Array.from(text);
        // Its first six characters, with the ellipsis a longer name is cut with; all of a short one.
        const kept = letters.length <= 6 ? text : `${letters.slice(0, 6).join("")}…`;
        const hint = item.querySelector<HTMLElement>(".scope-chip-empty");
        const nameCut = name ? name.scrollWidth > name.clientWidth + 1 : false;
        return {
          text,
          width: item.getBoundingClientRect().width,
          floor: Number.parseFloat(item.style.minWidth),
          // A name of seven letters is whole at less than its first six and an ellipsis.
          showsFirstSix: !nameCut || (name?.clientWidth ?? 0) + 1 >= canvas.measureText(kept).width,
          nameCut,
          hint: hint
            ? {
                whole: hint.getBoundingClientRect().right <= item.getBoundingClientRect().right + 1,
              }
            : null,
        };
      },
    );
    const model = root.querySelector<HTMLElement>('[data-testid="composer-model"] .truncate');
    const controls = root.querySelector<HTMLElement>(".composer-controls");
    return {
      chips,
      count: root.querySelector('[data-testid="scope-chips-more"]')?.textContent ?? null,
      model: {
        text: model?.textContent ?? "",
        cut: model ? model.scrollWidth > model.clientWidth + 1 : false,
      },
      holds: controls ? controls.scrollWidth <= controls.clientWidth + 1 : false,
    };
  });

/** Everything on the row is inside the composer, + whole and level with Ask. */
async function expectRowHolds(window: Page, at = ""): Promise<void> {
  const { composer, plus } = parts(window);
  const [composerBox, plusBox, askBox] = await Promise.all([
    boxOf(composer),
    boxOf(plus),
    boxOf(composer.getByTestId("composer-ask")),
  ]);
  // Never squeezed: as wide as it is tall, at the narrowest panel as at the widest.
  expect(plusBox.width, `${at}: + as wide as it is tall`).toBeCloseTo(plusBox.height, 1);
  expect(plusBox.x).toBeGreaterThanOrEqual(composerBox.x);
  expect(askBox.x + askBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
  expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(askBox.x);
  expect(Math.abs(plusBox.y - askBox.y)).toBeLessThan(3);
  expect((await rowState(composer)).holds, `${at}: the controls hold`).toBe(true);
}

/** The Anthropic model the first Question is asked with in the screenshots: "Haiku 5.5", a short name. */
async function setHaiku(window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(async (apiKey) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "anthropic", apiKey, modelId: "claude-haiku-5-5" });
  }, ANTHROPIC_KEY);
}

for (const language of ["en", "zh-CN"] as const) {
  const folderName =
    language === "en"
      ? "Quarterly reports and board materials for the Harbourside group 2026"
      : "海港集团二零二六年度季度报告和董事会材料汇总";

  test(`as the row runs short a Folder's name on the scope chip shortens to about six characters before the model's name is cut; + stays whole and All Documents is never cut (${language})`, async () => {
    await writeFile(join(sources, "Tides.txt"), "Spring tides follow the new moon.\n");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window, "sonnet-5.5-local");
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await sizeAssistant(window, 280);
    const { composer } = parts(window);

    // All Documents is whole; it is the model's name that gives way.
    const all = composer.getByTestId("composer-scope-all");
    await expect(all).toBeVisible();
    await expectRowHolds(window);
    expect(
      await all.locator(".truncate").evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    ).toBe(false);
    expect((await rowState(composer)).model.cut).toBe(true);

    // A Folder with a long name, at every width from the narrowest panel up.
    const mindId = await (await coreOf(window)).evaluate(
      async (core: CoreBridge, input: { folder: string; path: string }) => {
        const folder = await core.createLibraryGroup({ name: input.folder, description: "" });
        await core.addDocuments([input.path], { groupId: folder.id });
        return (await core.createMind({ title: "Board note", folderId: folder.id })).id;
      },
      { folder: folderName, path: join(sources, "Tides.txt") },
    );
    const folderRow = sidebarFolder(window, folderName).getByTestId("folder-row");
    if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
    await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
    await sizeAssistant(window, 400);
    const chip = composer.getByTestId("scope-chip");
    await expect(chip).toHaveCount(1);
    // Cut on screen, whole in its tooltip.
    expect(await chip.getAttribute("title")).toContain(folderName);

    const counted = language === "en" ? "1 selected" : "已选 1 项";
    for (const width of [280, 300, 320, 340, 400]) {
      await sizeAssistant(window, width);
      await expectRowHolds(window, `${width}`);
      const state = await rowState(composer);
      const [only] = state.chips;
      if (only) {
        // Never under about six characters; the model's name is cut only once the Folder's is as
        // short as it goes.
        expect(only.showsFirstSix, `${width}: six characters`).toBe(true);
        if (state.model.cut) {
          expect(only.width, `${width}: model cut`).toBeLessThanOrEqual(only.floor + 2);
        }
        if (!only.nameCut) expect(state.model.cut, `${width}: name whole`).toBe(false);
      } else {
        // Six characters of Chinese would not fit even beside the model's name cut as short as it
        // goes: the Folder folds into the count, which says what it is.
        expect(state.count, `${width}: folded`).toBe(counted);
        expect(language, `${width}: folded`).toBe("zh-CN");
        expect(width, `${width}: folded only at the narrowest panels`).toBeLessThanOrEqual(300);
        expect(state.model.cut, `${width}: folded`).toBe(true);
      }
      if (width === 400) {
        expect(only?.nameCut, `${width}`).toBe(true);
        expect(state.model.cut, `${width}`).toBe(false);
      }
    }
    await app.close();
  });

  for (const files of [2, 4]) {
    test(`${files} added files at 280, 320 and 400 px: no chip under six characters, the count when they can't all stay, and the model's name cut only after that (${language})`, async () => {
      const paths = [
        await pdf("Lease", "The break clause is on 1 June."),
        await pdf("Charter", "The laytime is 72 hours."),
        await pdf("Harbour handbook", "The pilot boards at the outer buoy."),
        await pdf("Tariff survey", "The berth fee is 9 dollars."),
      ];
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await setHaiku(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1600, 900);
      await sizeAssistant(window, 280);
      const { composer, plus, menu } = parts(window);
      for (let from = 0; from < files; from += 2) {
        await interceptOpenDialog(app, paths.slice(from, from + 2));
        await pointAndClick(window, plus);
        await pointAndClick(window, menu.getByTestId("composer-plus-files"));
        await expect.poll(async () => (await documentsOf(window)).length).toBe(from + 2);
      }
      const counted = language === "en" ? `${files} files` : `${files} 个文件`;
      for (const width of [280, 320, 400]) {
        await sizeAssistant(window, width);
        await expectRowHolds(window, `${width}`);
        const state = await rowState(composer);
        for (const chip of state.chips) {
          expect(chip.showsFirstSix, `${width}: ${chip.text}`).toBe(true);
        }
        // More than the count showing: the model's name is whole. Cut only once all are folded.
        if (state.chips.length > 0) expect(state.model.cut, `${width}: chips`).toBe(false);
        if (state.model.cut) expect(state.chips, `${width}: model cut`).toHaveLength(0);
        // Nothing is left out: the chips and what the count says add up to every file.
        if (state.chips.length === 0) expect(state.count, `${width}`).toBe(counted);
        if (width === 320 && files === 2) {
          // + · Haiku 5.5 · 2 files · Ask.
          expect(state.chips).toHaveLength(0);
          expect(state.count).toBe(counted);
          expect(state.model).toEqual({ text: "Haiku 5.5", cut: false });
        }
      }
      await app.close();
    });
  }

  test(`the count two files fold into opens each file with its ×, Esc closes it, and a × takes the file out of the scope only (${language})`, async () => {
    const paths = [
      await pdf("Lease", "The break clause is on 1 June."),
      await pdf("Charter", "The laytime is 72 hours."),
    ];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setHaiku(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await sizeAssistant(window, 320);
    const { composer, plus, menu } = parts(window);
    await interceptOpenDialog(app, paths);
    await pointAndClick(window, plus);
    await pointAndClick(window, menu.getByTestId("composer-plus-files"));
    const count = composer.getByTestId("scope-chips-more");
    await expect(count).toHaveText(language === "en" ? "2 files" : "2 个文件");
    await expectRowHolds(window, "320");

    await pointAndClick(window, count);
    const list = window.getByTestId("scope-chips-menu");
    await expect(list).toBeVisible();
    const removers = list.getByTestId("scope-chips-menu-remove");
    await expect(removers).toHaveCount(2);
    await expect(list).toContainText("Lease");
    await expect(list).toContainText("Charter");
    // The row under it is as it was.
    await expectRowHolds(window, "320 open");
    // The count is the last thing before Ask: its menu ends at its right edge, inside the box.
    await motionSettled(window);
    const [listBox, countBox, composerBox] = await Promise.all([
      boxOf(list),
      boxOf(count),
      boxOf(composer),
    ]);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(countBox.x + countBox.width + 1);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
    await window.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(count).toBeVisible();

    await pointAndClick(window, count);
    await expect(list).toBeVisible();
    await removers.first().click();
    await expect(list).toBeHidden();
    // One chip is left, whole; both are still Documents.
    await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
    await expect(count).toHaveCount(0);
    expect(await documentsOf(window)).toHaveLength(2);
    await app.close();
  });

  test(`a locked Folder folded into a count of one keeps its chip's tooltip, and its row in the menu shows the lock and no × (${language})`, async () => {
    await writeFile(join(sources, "Tides.txt"), "Spring tides follow the new moon.\n");
    // Six of its characters are as wide as six of the Chinese name's: the lock and the Ask leave
    // them no room in a row this narrow.
    const lockedName = language === "en" ? "WWWWWWWW board materials" : folderName;
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window, "sonnet-5.5-local");
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await sizeAssistant(window, 280);
    const mindId = await (await coreOf(window)).evaluate(
      async (core: CoreBridge, input: { folder: string; path: string }) => {
        const folder = await core.createLibraryGroup({ name: input.folder, description: "" });
        await core.updateLibraryGroup(folder.id, {
          name: folder.name,
          description: "",
          keepInside: true,
        });
        await core.addDocuments([input.path], { groupId: folder.id });
        return (await core.createMind({ title: "Board note", folderId: folder.id })).id;
      },
      { folder: lockedName, path: join(sources, "Tides.txt") },
    );
    const folderRow = sidebarFolder(window, lockedName).getByTestId("folder-row");
    if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
    await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
    const { composer } = parts(window);
    await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");
    // A room narrower than the narrowest panel gives, as a wider system font leaves: a locked
    // chip needs less than an unlocked one, and still fits six characters of its name at 280 px.
    await composer.evaluate((root) => {
      root.style.maxWidth = "210px";
    });
    const count = composer.getByTestId("scope-chips-more");
    const wall =
      language === "en"
        ? `Folder “${lockedName}” keeps its work inside it`
        : `“${lockedName}”只在本文件夹内工作`;
    await expect(count).toHaveText(language === "en" ? "1 selected" : "已选 1 项");
    await expect(count).toHaveAttribute("title", wall);
    await expectRowHolds(window, "210");

    await pointAndClick(window, count);
    const list = window.getByTestId("scope-chips-menu");
    await expect(list).toBeVisible();
    await motionSettled(window);
    const row = list.getByTestId("scope-chips-menu-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-walled", "true");
    await expect(row.getByTestId("scope-chips-menu-lock")).toBeVisible();
    await expect(row).toHaveAttribute("title", wall);
    await expect(list.getByTestId("scope-chips-menu-remove")).toHaveCount(0);
    const [listBox, countBox] = await Promise.all([boxOf(list), boxOf(count)]);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(countBox.x + countBox.width + 1);
    await app.close();
  });

  test(`a Folder and two files fold into one count that says what was selected (${language})`, async () => {
    const paths = [
      await pdf("Lease", "The break clause is on 1 June."),
      await pdf("Charter", "The laytime is 72 hours."),
    ];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setHaiku(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
      await core.createLibraryGroup({ name: "Matter A", description: "" });
    });
    const { composer, plus, menu } = parts(window);
    await composer.getByTestId("composer-input").click();
    await window.keyboard.type("@Matter");
    await window.keyboard.press("Enter");
    await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
    await interceptOpenDialog(app, paths);
    await pointAndClick(window, plus);
    await pointAndClick(window, menu.getByTestId("composer-plus-files"));
    await expect
      .poll(async () => (await rowState(composer)).count)
      .toBe(language === "en" ? "3 selected" : "已选 3 项");
    expect((await rowState(composer)).chips).toHaveLength(0);
    expect((await rowState(composer)).model).toEqual({ text: "Haiku 5.5", cut: false });
    await expectRowHolds(window);
    await app.close();
  });

  test(`the "· empty" on a Folder's chip is whole or gone, and goes before the Folder's name loses a character (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setHaiku(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    const mindId = await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
      const folder = await core.createLibraryGroup({ name: "Matter A", description: "" });
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: "",
        keepInside: true,
      });
      return (await core.createMind({ title: "Matter note", folderId: folder.id })).id;
    });
    const folderRow = sidebarFolder(window, "Matter A").getByTestId("folder-row");
    if ((await folderRow.getAttribute("aria-expanded")) !== "true") await folderRow.click();
    await window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first().click();
    const { composer } = parts(window);
    await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-walled", "true");
    let withHint = 0;
    for (const width of [280, 300, 320, 340, 400]) {
      await sizeAssistant(window, width);
      await expectRowHolds(window, `${width}`);
      const [chip] = (await rowState(composer)).chips;
      expect(chip?.showsFirstSix, `${width}`).toBe(true);
      if (chip?.hint) {
        withHint += 1;
        expect(chip.hint.whole, `${width}: hint whole`).toBe(true);
        expect(chip.nameCut, `${width}: hint beside a name that is whole`).toBe(false);
        // The lock and the hint keep the room a chip with a name button and a × has at its sides.
        const room = await composer.getByTestId("scope-chip").evaluate((item) => {
          const box = item.getBoundingClientRect();
          const lock = item.querySelector("svg")?.getBoundingClientRect();
          const hint = item.querySelector(".scope-chip-empty")?.getBoundingClientRect();
          return {
            left: lock ? lock.left - box.left : -1,
            right: hint ? box.right - hint.right : -1,
          };
        });
        expect(room.left, `${width}: room left of the lock`).toBeGreaterThan(5.5);
        expect(room.right, `${width}: room right of the hint`).toBeGreaterThan(5.5);
      }
    }
    // At 320 px and up there is room for "Matter A · empty" whole.
    expect(withHint).toBeGreaterThan(0);
    await app.close();
  });
}

test("in the bottom assistant the + is at the left end of the one-line row, and moves to the left of the controls under long text", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await placeAssistant(window, { dock: "bottom" });
  const { composer, plus } = parts(window);
  const input = composer.getByTestId("composer-input");
  await expect(plus).toBeVisible();

  const plusBox = await boxOf(plus);
  const inputBox = await boxOf(input);
  expect(plusBox.x + plusBox.width).toBeLessThan(inputBox.x + 1);

  await input.click();
  await window.keyboard.type(
    "A question long enough to run over several lines of the box, which asks about the tides in the western approaches and what the harbour master's handbook says about pilotage in a gale. ".repeat(
      2,
    ),
  );
  const longPlus = await boxOf(plus);
  const longInput = await boxOf(input);
  const askBox = await boxOf(composer.getByTestId("composer-ask"));
  expect(longPlus.y).toBeGreaterThanOrEqual(longInput.y + longInput.height - 1);
  expect(longPlus.x).toBeLessThan(askBox.x);
  expect(Math.abs(longPlus.y - askBox.y)).toBeLessThan(3);
  await app.close();
});

for (const dock of ["right", "left", "bottom", "float"] as const) {
  test(`the + is on the row of the assistant docked ${dock}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setWindowSize(app, window, 1600, 900);
    await placeAssistant(window, { dock });
    const { composer, plus, menu } = parts(window);
    await expect(plus).toBeVisible();
    const [composerBox, plusBox, askBox] = await Promise.all([
      boxOf(composer),
      boxOf(plus),
      boxOf(composer.getByTestId("composer-ask")),
    ]);
    expect(plusBox.x).toBeGreaterThanOrEqual(composerBox.x);
    expect(plusBox.x + plusBox.width).toBeLessThan(askBox.x);
    expect(Math.abs(plusBox.y - askBox.y)).toBeLessThan(3);
    await pointAndClick(window, plus);
    await expect(menu).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(plus).toBeFocused();
    await app.close();
  });
}

test("⌘K does not offer Add files to the chat while no chat box is drawn", async () => {
  const { app, window } = await launchApp(dataDir);
  // With no model set, the first Question puts the model's setup card where the box was.
  await askFirstQuestion(window);
  await expect(window.getByTestId("composer")).toHaveCount(0);
  expect(await paletteOffers(window, "composer.addFiles", "add files to the chat")).toBe(0);
  await app.close();
});
