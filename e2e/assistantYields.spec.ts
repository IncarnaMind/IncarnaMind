import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The assistant yields to a Citation's page opened from the Note (#2270): at 1,440px the Note
 * and the page cannot keep their even split beside the open assistant, so it folds to its rail
 * and comes back when the page closes; at 1,600px it stays open. A Citation clicked inside the
 * assistant leaves it open, and the page takes the narrower share. The User's own fold or unfold
 * wins, and unfolding it while the page is open gives the page the narrower share too. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

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

const editorOf = (window: Page) => window.getByTestId("mind-editor").filter({ visible: true });
const notePane = (window: Page) => window.locator(".mind-tab-page:visible").first();
const assistantOf = (window: Page) => window.getByTestId("assistant");

/** A Note "Draft" citing Tides, with its Answer in the assistant, which is open. */
async function draftCiting(window: Page): Promise<Locator> {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await nameMind(window, "Draft");
  const answer = await askInAssistant(window, "When do spring tides happen?");
  await addToNote(window, answer);
  return answer;
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box.width;
}

/** The Note's column and the page beside it, as they stand now. */
async function splitOf(window: Page): Promise<{ note: number; page: number }> {
  return {
    note: await widthOf(notePane(window)),
    page: await widthOf(window.getByTestId("viewer")),
  };
}

async function closePage(window: Page): Promise<void> {
  await pointAndClick(
    window,
    window.getByRole("tab", { name: "Tides", exact: true }).getByTestId("tab-close"),
  );
  await expect(window.getByTestId("viewer")).toHaveCount(0);
}

async function screenshot(window: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const folds of [true, false] as const) {
    const width = folds ? 1440 : 1600;
    test(`a Citation's page ${folds ? "folds the assistant" : "leaves the assistant open"} at ${width}px (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 900);
      await draftCiting(window);

      await pointAndClick(window, editorOf(window).getByTestId("citation-chip"));
      await expect(window.getByTestId("viewer-title")).toHaveText("Tides");

      if (folds) {
        await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");
        await expect(window.getByTestId("assistant-rail")).toBeVisible();
      } else {
        await expect(assistantOf(window)).not.toHaveAttribute("data-folded");
      }
      // The Note and the page keep their even split, each at least the width a Note is written at.
      await expect
        .poll(async () => {
          const split = await splitOf(window);
          return Math.abs(split.note - split.page);
        })
        .toBeLessThanOrEqual(2);
      const split = await splitOf(window);
      expect(split.note).toBeGreaterThanOrEqual(480);
      expect(split.page).toBeGreaterThanOrEqual(480);
      await motionSettled(window);
      await screenshot(
        window,
        `assistant-yields-${folds ? "folded" : "open"}-${language}-${width}`,
      );
      await app.close();
    });
  }

  test(`a Citation clicked in the assistant at 1440px leaves it open, its Answer in view, and the page narrower (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    const answer = await draftCiting(window);

    await pointAndClick(window, answer.getByTestId("citation-chip").first());
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(
      window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
    ).toBeVisible();
    // The page takes the narrower share, so the Note keeps the width it is written at.
    await expect
      .poll(async () => {
        const split = await splitOf(window);
        return split.note - split.page;
      })
      .toBeGreaterThan(20);
    const split = await splitOf(window);
    expect(split.note).toBeGreaterThanOrEqual(480);
    expect(split.page).toBeLessThan(split.note);
    // The User is reading in the assistant: it stays open, with the Answer and its Citation's card.
    await expect(assistantOf(window)).not.toHaveAttribute("data-folded");
    await expect(answer).toBeInViewport();
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await motionSettled(window);
    await screenshot(window, `assistant-yields-from-assistant-${language}-1440`);
    await app.close();
  });

  test(`the assistant comes back by itself with the same thread, scroll and Citation (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 560);
    const first = await draftCiting(window);
    // More Answers, so the thread scrolls in this short window.
    await askInAssistant(window, "What raises the tides?");
    await askInAssistant(window, "When are spring tides highest?");
    const last = await askInAssistant(window, "Where do the two bulges come from?");
    const answers = assistantOf(window).getByTestId("assistant-answer");
    const count = await answers.count();
    expect(count).toBe(4);

    const thread = window.getByTestId("assistant-thread");
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const scrolled = await thread.evaluate((element) => element.scrollTop);

    // A Citation clicked in the Note: its page opens, the quote washed, and the assistant folds.
    const chip = editorOf(window).getByTestId("citation-chip").first();
    await pointAndClick(window, chip);
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(
      window.getByTestId("viewer").locator("[data-quote-highlight]").first(),
    ).toBeVisible();
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");
    await screenshot(window, `assistant-yields-citation-folded-${language}`);

    // Closing the page brings it back as it was, the clicked Citation still open.
    await closePage(window);
    await expect(assistantOf(window)).not.toHaveAttribute("data-folded");
    await expect(answers).toHaveCount(count);
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(scrolled);
    await expect(first).toBeVisible();
    await expect(last).toBeVisible();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(window.getByTestId("citation-card")).toBeVisible();
    await motionSettled(window);
    await screenshot(window, `assistant-yields-restored-${language}`);
    await app.close();
  });

  test(`the User's own fold and unfold win, and a reopen gives the page the narrower share (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 760);
    await draftCiting(window);

    // A Citation in the Note folds it.
    await pointAndClick(window, editorOf(window).getByTestId("citation-chip"));
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");

    // The User unfolds it: the page takes the narrower share instead.
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistantOf(window)).not.toHaveAttribute("data-folded");
    await expect
      .poll(async () => {
        const split = await splitOf(window);
        return split.note - split.page;
      })
      .toBeGreaterThan(20);
    const reopened = await splitOf(window);
    expect(reopened.note).toBeGreaterThanOrEqual(480);
    expect(reopened.page).toBeLessThan(reopened.note);
    await motionSettled(window);
    await screenshot(window, `assistant-yields-user-unfolded-${language}`);

    // Closing the page leaves the assistant as the User left it.
    await closePage(window);
    await motionSettled(window);
    await expect(assistantOf(window)).not.toHaveAttribute("data-folded");

    // The User folds it; a Citation's page opens and the assistant stays folded, then after it too.
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");
    await pointAndClick(window, editorOf(window).getByTestId("citation-chip"));
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");
    await closePage(window);
    await motionSettled(window);
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");

    // Folded by the User, not by the page, and reopened while the page shows: the page takes the narrower share.
    await pointAndClick(window, editorOf(window).getByTestId("citation-chip"));
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
    await expect(assistantOf(window)).toHaveAttribute("data-folded", "true");
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistantOf(window)).not.toHaveAttribute("data-folded");
    await expect
      .poll(async () => {
        const split = await splitOf(window);
        return split.note - split.page;
      })
      .toBeGreaterThan(20);
    const shown = await splitOf(window);
    expect(shown.note).toBeGreaterThanOrEqual(480);
    expect(shown.page).toBeLessThan(shown.note);
    await app.close();
  });
}
