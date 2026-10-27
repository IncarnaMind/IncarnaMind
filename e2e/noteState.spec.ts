import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { lockedPdf } from "../tests/helpers/lockedPdf";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  tokenColor,
} from "./app";

/*
 * A note says when it is done (D266, #1915): the corner badge, the note's row in Home and
 * the Export menu say the same state — "Not checked", "1 needs a look", "Checked 14:25" —
 * in English and Chinese. The scripted model finds a sentence contradicted when it shares
 * three words with a Document line and has a number the line doesn't (#96). Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save the screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happened 12 times in 2026."] },
]);
const CONTRADICTED = "Spring tides happened 14 times in 2026.";
const SUPPORTED = "Spring tides happened 12 times in 2026.";

const WORDS = {
  en: {
    notChecked: "Not checked",
    look: "1 needs a look",
    checked: "Checked ",
    checkFirst: "Not checked since your last edit · Check first",
    see: "Show",
    running: "A check is running",
    checking: /claims? being checked/,
  },
  "zh-CN": {
    notChecked: "未核对",
    look: "需要留意 1 处",
    checked: "已核对 ",
    checkFirst: "上次编辑后未核对 · 先核对",
    see: "查看",
    running: "正在核对",
    checking: /正在核对 \d+ 条说法/,
  },
} as const;

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

async function launchWithTides() {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  await connectLocalChatModel(running.window);
  await addDocuments(running.window, [join(sources, "Tides.pdf")]);
  return running;
}

const badge = (window: Page) => window.getByTestId("check-badge");
const stateWords = (window: Page) => badge(window).locator(".check-badge-words");

/**
 * Runs the one Check from its card. It asks before it names the claims; a re-check of one
 * edited claim may run at once, so wait for the question, the run, or the mark to change.
 */
async function checkWholeMind(window: Page, from: string | null) {
  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  const ask = card.getByTestId("mind-check-ask");
  await expect(async () => {
    if (await ask.isVisible()) return;
    if (await window.getByTestId("badge-stop").isVisible()) return;
    const marks = window.getByTestId("claim-mark");
    const mark =
      (await marks.count()) === 0 ? null : await marks.first().getAttribute("data-check");
    if (mark !== from) return;
    throw new Error("The check hasn't started.");
  }).toPass({ timeout: 30_000 });
  if (await ask.isVisible()) await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 60_000 });
}

async function goHome(window: Page) {
  await window.getByTestId("sidebar-home").click();
  await expect(window.getByTestId("home")).toBeVisible();
}

const recentRow = (window: Page, title: string) =>
  window
    .getByTestId("home-recent-row")
    .filter({ has: window.getByTestId("row-text").getByText(title, { exact: true }) });

const rowState = (window: Page, title: string): Locator =>
  recentRow(window, title).getByTestId("home-recent-state");

for (const language of ["en", "zh-CN"] as const) {
  test(`the badge, Home's row and the Export menu say the same state through a check, a fix and an edit (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const { app, window } = await launchWithTides();
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("Tides");
    await window.keyboard.press("Enter");
    await window.keyboard.type(CONTRADICTED);
    await expect(editor).toContainText(CONTRADICTED);

    // Nothing has checked it since the last edit: the badge says so, whatever its Citation (D266).
    await expect(badge(window)).toHaveAttribute("data-state", "not-checked");
    await expect(stateWords(window)).toHaveText(words.notChecked);
    await screenshot(window, `note-state-${language}-900-not-checked`);

    // The Home row says the same.
    await goHome(window);
    await expect(rowState(window, "Tides")).toHaveText(words.notChecked);
    await expect(rowState(window, "Tides")).toHaveAttribute("data-state", "not-checked");
    await screenshot(window, `note-state-home-${language}-900-not-checked`);
    await recentRow(window, "Tides").getByTestId("home-recent-open").click();
    await expect(window.getByTestId("mind-pane")).toBeVisible();

    // One contradiction: the state is amber-red, and Home says the same.
    await checkWholeMind(window, null);
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted", {
      timeout: 60_000,
    });
    await expect(badge(window)).toHaveAttribute("data-state", "needs-look", {
      timeout: 60_000,
    });
    await expect(stateWords(window)).toHaveText(words.look);
    // Screen readers hear the state by name.
    await expect(window.getByTestId("check-badge-open")).toHaveAccessibleName(
      new RegExp(words.look),
    );
    // A contradiction keeps the margin's red (D266, "amber or red as now").
    expect(await stateWords(window).evaluate((element) => getComputedStyle(element).color)).toBe(
      await tokenColor(window, "--color-danger"),
    );
    await goHome(window);
    await expect(rowState(window, "Tides")).toHaveText(words.look);
    await expect(rowState(window, "Tides")).toHaveAttribute("data-state", "needs-look");
    await screenshot(window, `note-state-home-${language}-900-needs-look`);
    await recentRow(window, "Tides").getByTestId("home-recent-open").click();

    // The Export menu says the same state under Word, and one click opens the card at its marks.
    await pointAndClick(window, window.getByTestId("export-mind"));
    const exportMenu = window.getByTestId("export-menu");
    const stateLine = exportMenu.getByTestId("export-note-state");
    await expect(stateLine).toHaveAttribute("data-state", "needs-look");
    await expect(stateLine).toHaveText(`${words.look} · ${words.see}`);
    await screenshot(window, `note-state-export-${language}-needs-look`);
    await pointAndClick(window, stateLine);
    const marks = window.getByTestId("check-card");
    await expect(marks).toBeVisible();
    await expect(marks.getByTestId("health-contradicted")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(marks).toHaveCount(0);

    // Fixing the number and checking again: every claim holds, so the state is green, with its time.
    const line = editor.locator("p").filter({ hasText: "Spring tides happened" }).first();
    await slideSelect(window, line, "14");
    await window.keyboard.type("12");
    await expect(editor).toContainText(SUPPORTED);
    await checkWholeMind(window, "needs-recheck");
    await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported", {
      timeout: 60_000,
    });
    await expect(badge(window)).toHaveAttribute("data-state", "checked", {
      timeout: 60_000,
    });
    await expect(stateWords(window)).toHaveText(new RegExp(`^${words.checked}`));
    await expect(window.getByTestId("check-badge-open")).toHaveAccessibleName(
      new RegExp(words.checked),
    );
    const time = (await stateWords(window).textContent())?.slice(words.checked.length) ?? "";
    expect(time).not.toBe("");
    // The green is the success token (D266).
    expect(await stateWords(window).evaluate((element) => getComputedStyle(element).color)).toBe(
      await tokenColor(window, "--color-success"),
    );
    await screenshot(window, `note-state-${language}-900-checked`);

    await goHome(window);
    await expect(rowState(window, "Tides")).toHaveAttribute("data-state", "checked");
    await expect(rowState(window, "Tides")).toContainText(`${words.checked}${time}`);
    await screenshot(window, `note-state-home-${language}-900-checked`);
    await recentRow(window, "Tides").getByTestId("home-recent-open").click();

    // A checked note gets no line at Export.
    await pointAndClick(window, window.getByTestId("export-mind"));
    await expect(window.getByTestId("export-menu")).toBeVisible();
    await expect(window.getByTestId("export-note-state")).toHaveCount(0);
    await screenshot(window, `note-state-export-${language}-checked`);
    await window.keyboard.press("Escape");

    // Editing the checked sentence leaves nothing checked since: back to Not checked, in all three places.
    const edited = editor.locator("p").filter({ hasText: "Spring tides happened" }).first();
    await slideSelect(window, edited, "2026");
    await window.keyboard.type("2025");
    await expect(badge(window)).toHaveAttribute("data-state", "not-checked");
    await goHome(window);
    await expect(rowState(window, "Tides")).toHaveText(words.notChecked);
    await recentRow(window, "Tides").getByTestId("home-recent-open").click();
    await pointAndClick(window, window.getByTestId("export-mind"));
    await expect(window.getByTestId("export-note-state")).toHaveText(words.checkFirst);
    await window.keyboard.press("Escape");

    // The badge holds its place at the widest window too, in both languages.
    await setWindowSize(app, window, 1600, 900);
    const pane = await window.getByTestId("mind-pane").boundingBox();
    const box = await badge(window).boundingBox();
    if (!pane || !box) throw new Error("The badge isn't drawn.");
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
    await screenshot(window, `note-state-${language}-1600-not-checked`);
    await goHome(window);
    await expect(rowState(window, "Tides")).toHaveText(words.notChecked);
    await screenshot(window, `note-state-home-${language}-1600-not-checked`);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Export says a check is running while it runs, and nothing once green (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const { app, window } = await launchWithTides();
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("Tides");
    await window.keyboard.press("Enter");
    // Each check of a sentence that says "slowly" reports slowly (#96): the run holds while Export opens.
    await window.keyboard.type(
      "Spring tides happened 12 times in 2026 slowly. Spring and neap tides happen slowly. Spring tides happen in 2026 slowly. Spring and neap tides happened in 2026 slowly.",
    );
    await expect(editor).toContainText("slowly");

    const card = await checkCard(window);
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    const ask = card.getByTestId("mind-check-ask");
    await expect
      .poll(
        async () => (await ask.isVisible()) || (await window.getByTestId("badge-stop").isVisible()),
      )
      .toBe(true);
    if (await ask.isVisible()) await pointAndClick(window, ask.getByTestId("mind-check-check"));
    await expect(window.getByTestId("badge-stop")).toBeVisible();

    // While it runs, Export says so; clicking opens the card at its progress, never a second Check.
    await pointAndClick(window, window.getByTestId("export-mind"));
    const runningLine = window.getByTestId("export-menu").getByTestId("export-note-state");
    await expect(runningLine).toHaveAttribute("data-state", "running");
    await expect(runningLine).toHaveText(`${words.running} · ${words.see}`);
    await screenshot(window, `note-state-export-${language}-running`);
    await pointAndClick(window, runningLine);
    const cardAgain = window.getByTestId("check-card");
    await expect(cardAgain.getByTestId("card-progress")).toBeVisible();
    // The claim being checked keeps its row, in the card's own words for a claim.
    await expect(cardAgain.getByTestId("health-checking")).toHaveText(words.checking);

    // Every sentence holds when the run ends, so the line is gone.
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 60_000 });
    await expect(badge(window)).toHaveAttribute("data-state", "checked", { timeout: 60_000 });
    await window.keyboard.press("Escape");
    await pointAndClick(window, window.getByTestId("export-mind"));
    await expect(window.getByTestId("export-note-state")).toHaveCount(0);
    await screenshot(window, `note-state-export-${language}-running-done`);
    await app.close();
  });
}

const READABLE = "Spring tides happen at new moon and at full moon.";

for (const language of ["en", "zh-CN"] as const) {
  test(`a checked note's green names the files its checks couldn't read (${language})`, async () => {
    test.setTimeout(120_000);
    const library = await createDataFolder();
    try {
      await writeFile(join(library, "Tides.txt"), `${READABLE}\n`);
      await writeFile(join(library, "Contract.doc"), "binary");
      await writeFile(
        join(library, "Locked.pdf"),
        lockedPdf(["Harbour fees rise in May."], "harbour"),
      );
      await writeFile(join(library, "Scan.pdf"), buildPdf([{ image: true }]));
      const { app, window } = await launchApp(dataDir, { fakeChat: true, home: library });
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await window.evaluate(async (path) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(
          path,
        );
      }, library);
      // Found and read to the end: the scan has no text, the .doc isn't read, the PDF wants a password.
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const [linked] = await bridge.listLinkedFolders();
            const documents = await bridge.listDocuments();
            return (
              linked?.status === "watching" &&
              documents.length > 0 &&
              documents.every((each) => each.status !== "queued" && each.status !== "extracting")
            );
          }),
        )
        .toBe(true);

      await newMind(window);
      await window.getByTestId("mind-editor").click();
      await window.keyboard.type(READABLE);
      await expect(window.getByTestId("mind-editor")).toContainText(READABLE);
      await checkWholeMind(window, null);
      await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "supported", {
        timeout: 60_000,
      });
      // Every claim holds, so the state is green, and it names what the check couldn't read (D261).
      await expect(badge(window)).toHaveAttribute("data-state", "checked", {
        timeout: 60_000,
      });
      await expect(stateWords(window)).toHaveText(language === "en" ? /^Checked / : /^已核对 /);
      await expect(badge(window)).toContainText(
        language === "en" ? "3 files couldn’t be read" : "3 个文件未能读取",
      );
      await screenshot(window, `note-state-${language}-checked-unread`);
      await app.close();
    } finally {
      await removeDataFolder(library);
    }
  });
}
