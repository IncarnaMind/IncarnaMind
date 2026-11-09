import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  boxOf,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  motionSettled,
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
  expect(plusBox.width).toBe(24);
  expect(plusBox.height).toBe(24);
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
      /^Add a note or Document@$/,
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
  const { composer, plus, menu } = parts(window);
  expect(await documentsOf(window)).toEqual([]);

  // Two files at once, by mouse.
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
  // Three Documents in the Search scope: the row has room for one chip and "+2 more".
  await expect(composer.getByTestId("scope-chips-more")).toContainText("2");
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
    .poll(() =>
      window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const { assignments } = await core.getLibrary();
        return (await core.listDocuments({})).map((each) => ({
          name: each.name,
          groupId: assignments.find((item) => item.documentId === each.id)?.groupId ?? null,
        }));
      }),
    )
    .toEqual([{ name: expect.stringContaining("Lease"), groupId: folderId }]);
  await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
  await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-kind", "folder");
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  const folderName =
    language === "en"
      ? "Quarterly reports and board materials for the Harbourside group 2026"
      : "海港集团二零二六年度季度报告和董事会材料汇总";

  test(`as the row runs short a Folder's name on the scope chip is cut first, down to about six characters, then the model's name; + stays whole and All Documents is never cut (${language})`, async () => {
    await writeFile(join(sources, "Tides.txt"), "Spring tides follow the new moon.\n");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window, "sonnet-5.5-local");
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 900);
    await sizeAssistant(window, 280);
    const { composer, plus } = parts(window);
    const controls = composer.locator(".composer-controls");
    const model = composer.getByTestId("composer-model");

    /** Everything on the row is inside the composer, + whole and level with Ask, and the controls hold their contents. */
    const expectRowHolds = async () => {
      const [composerBox, plusBox, askBox] = await Promise.all([
        boxOf(composer),
        boxOf(plus),
        boxOf(composer.getByTestId("composer-ask")),
      ]);
      expect(plusBox.width).toBe(24);
      expect(plusBox.x).toBeGreaterThanOrEqual(composerBox.x);
      expect(askBox.x + askBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
      expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(askBox.x);
      expect(Math.abs(plusBox.y - askBox.y)).toBeLessThan(3);
      expect(
        await controls.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    };
    const cut = (target: Locator) =>
      target.evaluate((element) => element.scrollWidth > element.clientWidth + 1);

    // All Documents is whole; it is the model's name that gives way.
    const all = composer.getByTestId("composer-scope-all");
    await expect(all).toBeVisible();
    await expectRowHolds();
    expect(await cut(all.locator(".truncate"))).toBe(false);
    expect(await cut(model.locator(".truncate"))).toBe(true);

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
    const chip = composer.getByTestId("scope-chip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("title", /.+/);

    for (const width of [280, 300, 320, 340, 400]) {
      await sizeAssistant(window, width);
      await expectRowHolds();
      const chipWidth = (await boxOf(chip)).width;
      const nameCut = await cut(chip.locator(".truncate"));
      const modelCut = await cut(model.locator(".truncate"));
      // The model's name is cut only once the Folder's is as short as it goes: an icon, about six
      // characters and the ×.
      if (modelCut)
        expect(chipWidth, `${width}: model cut`).toBeLessThanOrEqual(language === "en" ? 90 : 110);
      if (!nameCut) expect(modelCut, `${width}: name whole`).toBe(false);
      if (width === 400) {
        expect(nameCut).toBe(true);
        expect(modelCut).toBe(false);
      }
      if (width === 280) expect(chipWidth).toBeGreaterThanOrEqual(80);
    }
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
