import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  checkNote,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  noteCheck,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The check card counts a Note's sentences, each once, by its one state (#2831): while the User's
 * Check runs, its head counts up (#3840) and each sentence lands in its row as its check ends, so
 * the rows always add up to the sentences the head says are done, with no row repeating the head's
 * count. The scripted model holds each step of a sentence's check until the test releases it, and
 * finds a sentence supported when it shares three words with a line of a Document.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = [
  "Spring tides happen at new and full moon.",
  "The Moon raises two bulges of water on the Earth.",
  "Harbours publish the times of high water every 12 months.",
  "Penguins nest on the harbour cliffs.",
];

const WORDS = {
  en: {
    notChecked: "4 sentences",
    head: (done: number) => `${done} of 4`,
    foot: (done: number) => `Checking ${done} of 4`,
    canBeCited: "3 can be cited",
    look: "1 needs a look",
    stop: "Stop",
  },
  "zh-CN": {
    notChecked: "共 4 句",
    head: (done: number) => `${done}/4`,
    foot: (done: number) => `正在核对 ${done}/4`,
    canBeCited: "3 句可添加引用",
    look: "1 句需要留意",
    stop: "停止",
  },
} as const;

type SlowCheck = { incarnamindSlowCheck: { hold: boolean; waiting: (() => void)[] } };

const holdChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as unknown as SlowCheck).incarnamindSlowCheck.hold = true;
  });
const heldSteps = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as SlowCheck).incarnamindSlowCheck.waiting.length);
const releaseOneStep = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as unknown as SlowCheck).incarnamindSlowCheck.waiting.shift()?.();
  });
const releaseChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    const slow = (globalThis as unknown as SlowCheck).incarnamindSlowCheck;
    slow.hold = false;
    for (const go of slow.waiting.splice(0)) go();
  });

/** How many sentences a row of the card counts, or 0 when it has no row. */
const countOf = async (card: Locator, row: string): Promise<number> => {
  const shown = card.getByTestId(`health-${row}`);
  return (await shown.count()) === 0 ? 0 : Number(await shown.getAttribute("data-count"));
};

/** The result rows' counts together: each sentence once, the own-notes line under supported aside. */
const rowsTogether = async (card: Locator): Promise<number> => {
  const counts = await Promise.all(
    ["look", "supported", "notYetCited", "cantCheck"].map((row) => countOf(card, row)),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

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

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`while Check runs, the head counts up and each sentence lands in its row, the rows adding up to what the head counts, in ${language}`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(SENTENCES.join(" "));
    await expect(editor).toContainText(SENTENCES.at(-1) ?? "");

    const card = await checkCard(window);
    await expect(card.getByTestId("check-card-line")).toContainText(words.notChecked);
    await expect(card.getByTestId("mind-health").getByTestId("health-toCheck")).toHaveCount(0);

    await holdChecks(app);
    await checkNote(window);
    await expect.poll(() => heldSteps(app)).toBeGreaterThan(0);
    // The Check button and the card's head say how far the run is; neither a row nor a second
    // Stop repeats it: the button's square is the run's one Stop (#3840).
    const button = noteCheck(window);
    const running = window.getByTestId("check-card");
    if (!(await running.isVisible())) await pointAndClick(window, button);
    const aside = running.getByTestId("check-card-head-aside");
    await expect(button).toHaveAttribute("data-state", "checking");
    await expect(aside).toHaveText(words.head(0));
    await expect(running.getByTestId("health-checking")).toHaveCount(0);
    await expect(running.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(button).toHaveAttribute("title", words.foot(0));
    await expect(window.getByTestId("note-check-stop")).toBeVisible();
    await expect(running.getByRole("button", { name: words.stop })).toHaveCount(0);

    // One step at a time, until a sentence's check ends: it lands in its row.
    while ((await rowsTogether(running)) === 0) {
      const held = await heldSteps(app);
      await releaseOneStep(app);
      await expect
        .poll(async () => (await heldSteps(app)) === held || (await rowsTogether(running)) > 0)
        .toBe(true);
    }
    const done = await rowsTogether(running);
    expect(done).toBeLessThan(4);
    await expect(aside).toHaveText(words.head(done));
    await expect(button).toHaveAttribute("title", words.foot(done));
    // The rows say what moved: no line under them counts the landed sentences a second time.
    await expect(running.locator(".check-card-note")).toHaveCount(0);

    // From here, every frame: what the button says once the run is over (#3487).
    await window.evaluate(() => {
      const seen: { running: boolean; state: string | null }[] = [];
      (globalThis as unknown as { buttonFrames: typeof seen }).buttonFrames = seen;
      const frame = () => {
        seen.push({
          running: document.querySelector('[data-testid="note-check-stop"]') !== null,
          state:
            document
              .querySelector('[data-testid="note-check-place"] [data-testid="note-check"]')
              ?.getAttribute("data-state") ?? null,
        });
        requestAnimationFrame(frame);
      };
      frame();
    });
    await releaseChecks(app);
    await expect(window.getByTestId("note-check-stop")).toHaveCount(0);
    await expect(running.getByTestId("check-card-head")).toHaveAttribute("data-stage", "done");
    // Supported, but citing nothing yet: the row of what can be cited holds them (#3358).
    await expect(running.getByTestId("health-notYetCited")).toContainText(words.canBeCited);
    await expect(running.getByTestId("health-look")).toContainText(words.look);
    await expect.poll(() => rowsTogether(running)).toBe(4);
    // The button never said "Check 4" over a card that had its results: once the run ended its
    // state was the card's, in every frame.
    const ended = await window.evaluate(() =>
      (
        globalThis as unknown as { buttonFrames: { running: boolean; state: string | null }[] }
      ).buttonFrames.filter((each) => !each.running),
    );
    expect(ended.length).toBeGreaterThan(0);
    expect(ended.filter((each) => each.state !== "look")).toEqual([]);
    await app.close();
  });
}
