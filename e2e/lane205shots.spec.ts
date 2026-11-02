import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setWindowSize,
} from "./app";

/* Temporary pictures for #205's pull request. Not committed: run, then remove. */

const OUT = process.env.LANE_SHOTS ?? "";
const FRAMES = process.env.LANE_FRAMES ?? "";

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

async function slideTo(window: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("Nothing to point at.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y, { steps: 12 });
  return { x, y };
}

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (wanted) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: wanted },
      }),
    language,
  );

let frame = 0;
async function shot(window: Page, name: string): Promise<void> {
  if (OUT) await window.screenshot({ path: join(OUT, `${name}.png`) });
  if (FRAMES && name.startsWith("flow")) {
    await window.screenshot({ path: join(FRAMES, `${String(frame++).padStart(4, "0")}.png`) });
  }
}

/** Waits for a popover or dialog to finish growing, so a picture shows it as it rests. */
const settle = (locator: Locator) =>
  expect.poll(() => locator.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

const tagRow = (window: Page, name: string) =>
  window.getByTestId("sidebar-tag").filter({
    has: window.locator(':scope > div [data-testid="row-text"]', { hasText: name }),
  });

async function seed(window: Page): Promise<void> {
  const names: Record<string, string> = {
    "Thesis outline.md": "Chapter 2: parks and the urban heat island at night.",
    "Leeds sensor readings.csv": "site,night_temp\nWoodhouse,18.2\nHeadingley,17.9\n",
    "Spronken-Smith and Oke 1999.md": "Park cool islands in Sacramento and Vancouver.",
    "Chapter 2 draft.md": "A draft chapter on urban heat.",
    "Fieldwork notes.txt": "Tides and temperatures at the harbour.",
  };
  const paths: string[] = [];
  for (const [name, text] of Object.entries(names)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const tags = await core.listTags();
    const byName = (name: string) => tags.find((tag) => tag.name === name);
    const documents = await core.listDocuments();
    const doc = (start: string) => documents.find((each) => each.name.startsWith(start));
    const link = async (start: string, ...tagNames: string[]) => {
      const document = doc(start);
      if (!document) return;
      for (const name of tagNames) {
        const tag = byName(name);
        if (tag) await core.addDocumentTag(document.id, tag.id);
      }
    };
    await link("Thesis outline", "Paper", "Report");
    await link("Leeds sensor", "Report", "Invoice");
    await link("Spronken-Smith", "Paper", "Book", "Contract");
    await link("Chapter 2 draft", "Report", "Slides", "Notes");
    const fieldwork = await core.createTag({
      name: "Fieldwork",
      description: "Days out measuring heat and tides.",
    });
    const chapter = await core.createTag({ name: "Chapter 2", description: "Sources for chapter 2." });
    const fieldDoc = doc("Fieldwork notes");
    if (fieldDoc) await core.addDocumentTag(fieldDoc.id, fieldwork.id);
    const thesis = doc("Thesis outline");
    if (thesis) await core.addDocumentTag(thesis.id, chapter.id);
  });
  await expect(window.getByTestId("sidebar-tag")).toHaveCount(9);
}

test("pictures of the Tags section", async () => {
  if (OUT) await mkdir(OUT, { recursive: true });
  if (FRAMES) await mkdir(FRAMES, { recursive: true });
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1300, 820);
    await seed(window);
    const heading = window.getByTestId("tags-toggle");

    // Wide and narrow, English and Chinese: the section with its heading pointed at.
    for (const [language, width] of [
      ["en", 1300],
      ["en", 900],
      ["zh-CN", 1300],
      ["zh-CN", 900],
    ] as const) {
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 820);
      await window.mouse.move(width - 60, 500, { steps: 4 });
      await slideTo(window, heading);
      await expect(window.getByTestId("sidebar-tag").first()).toBeVisible();
      await shot(window, `tags-after-${language}-${width}`);
    }

    await setLanguage(window, "en");
    await setWindowSize(app, window, 1300, 820);
    const fieldwork = tagRow(window, "Fieldwork");

    // The dot's colours in place.
    await slideTo(window, fieldwork.getByTestId("tag-dot-button"));
    await window.mouse.down();
    await window.mouse.up();
    await expect(fieldwork.getByTestId("tag-colour-menu")).toBeVisible();
    await settle(fieldwork.getByTestId("tag-colour-menu"));
    await shot(window, "tags-colour-en");
    await window.keyboard.press("Escape");

    // The Tag's menu, with Colour ▸ open beside it.
    await slideTo(window, fieldwork.getByTestId("row-text"));
    await window.mouse.down({ button: "right" });
    await window.mouse.up({ button: "right" });
    await expect(fieldwork.getByTestId("tag-actions")).toBeVisible();
    await fieldwork.getByTestId("tag-actions").getByTestId("tag.colour").click();
    await expect(fieldwork.getByTestId("tag-colours")).toBeVisible();
    await settle(fieldwork.getByTestId("tag-colours"));
    await shot(window, "tags-menu-en");
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");

    // The heading's own menu, so Manage Tags… is there when the section is folded.
    await window.mouse.move(700, 400, { steps: 4 });
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await slideTo(window, heading);
    await window.getByTestId("tags-menu").click();
    await expect(window.getByTestId("tags-menu-items")).toBeVisible();
    await settle(window.getByTestId("tags-menu-items"));
    await shot(window, "tags-heading-menu-en");
    await window.keyboard.press("Escape");
    await heading.click();

    // A new Tag named in place.
    await slideTo(window, heading);
    await window.getByTestId("tags-add").click();
    const field = window.getByTestId("sidebar-tag-new-name");
    await expect(field).toBeFocused();
    await field.fill("Client pitch");
    await shot(window, "tags-new-en");
    await window.keyboard.press("Enter");

    // Manage Tags… from the heading's menu.
    await slideTo(window, heading);
    await window.getByTestId("tags-menu").click();
    await window.getByTestId("tags-menu-items").getByTestId("tags.manage").click();
    await expect(window.getByTestId("tags-dialog")).toBeVisible();
    await settle(window.getByTestId("tags-dialog"));
    await shot(window, "tags-manage-en");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("tags-dialog")).toBeHidden();

    // A frame a step, for the recording: create, rename, recolour, describe, drop, delete.
    await setWindowSize(app, window, 1100, 760);
    await slideTo(window, heading);
    await shot(window, "flow");
    await window.getByTestId("tags-add").click();
    await window.getByTestId("sidebar-tag-new-name").fill("Client brief");
    await window.keyboard.press("Enter");
    await expect(tagRow(window, "Client brief")).toHaveCount(1);
    await shot(window, "flow");
    await tagRow(window, "Client brief").getByTestId("row-text").dblclick();
    await window.keyboard.type("Client briefs");
    await window.keyboard.press("Enter");
    await expect(tagRow(window, "Client briefs")).toHaveCount(1);
    await shot(window, "flow");
    const briefs = tagRow(window, "Client briefs");
    await slideTo(window, briefs.getByTestId("tag-dot-button"));
    await window.mouse.down();
    await window.mouse.up();
    await expect(briefs.getByTestId("tag-colour-menu")).toBeVisible();
    await briefs
      .getByTestId("tag-colour-menu")
      .locator('[data-testid="tag-colour-choice"][data-colour="blue"]')
      .click();
    await shot(window, "flow");
    await slideTo(window, briefs.getByTestId("row-text"));
    await window.mouse.down({ button: "right" });
    await window.mouse.up({ button: "right" });
    await briefs.getByTestId("tag.editDescription").click();
    const dialog = window.getByTestId("tags-dialog");
    await expect(dialog).toBeVisible();
    await shot(window, "flow");
    await dialog.getByTestId("tag-description-input").first().fill("The deck and the shortlist.");
    await shot(window, "flow");
    await dialog.getByTestId("save-tag").first().click();
    await shot(window, "flow");
    await window.keyboard.press("Escape");
    // A Document dragged onto a Tag: the drop's line while it is over, then what it did.
    const from = window
      .getByTestId("document-list-item")
      .filter({ hasText: "Chapter 2 draft" })
      .getByTestId("row-text");
    const to = tagRow(window, "Fieldwork").getByTestId("row-text");
    await slideTo(window, from);
    await window.mouse.down();
    const drop = await slideTo(window, to);
    await window.mouse.move(drop.x + 2, drop.y);
    await expect(tagRow(window, "Fieldwork")).toHaveAttribute("data-drop-target", "true");
    await shot(window, "flow");
    await window.mouse.up();
    await shot(window, "flow");
    await slideTo(window, briefs.getByTestId("row-text"));
    await window.mouse.down({ button: "right" });
    await window.mouse.up({ button: "right" });
    await briefs.getByTestId("tag.delete").click();
    await expect(briefs).toHaveCount(0);
    await expect(window.getByTestId("undo-message")).toContainText("Moved “Client briefs”");
    await shot(window, "flow");
  } finally {
    await app.close();
  }
});
