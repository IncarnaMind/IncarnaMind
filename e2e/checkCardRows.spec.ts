import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * The check card counts a Note's sentences, each once, by its one state (#2831): while the User's
 * Check runs, the foot counts up and each sentence leaves "being checked" for its row as its
 * check ends, and the rows always add up to the sentences checked. The scripted model holds each
 * step of a sentence's check until the test releases it, and finds a sentence supported when it
 * shares three words with a line of a Document.
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
    notChecked: "4 not checked",
    checking: "4 being checked",
    foot: (done: number) => `Checking ${done} of 4`,
    supported: "3 supported",
    look: "1 needs a look",
  },
  "zh-CN": {
    notChecked: "4 句未核对",
    checking: "4 句正在核对",
    foot: (done: number) => `正在核对 ${done}/4`,
    supported: "3 句有依据",
    look: "1 句需要留意",
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

/** The rows' counts together: each sentence once, the own-notes line under supported aside. */
const rowsTogether = async (card: Locator): Promise<number> => {
  const counts = await Promise.all(
    ["look", "supported", "checking", "toCheck"].map((row) => countOf(card, row)),
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

  test(`while Check runs, the foot counts up and each sentence moves from being checked to its row, the rows adding up to the sentences, in ${language}`, async () => {
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
    await expect(card.getByTestId("health-toCheck")).toContainText(words.notChecked);
    await expect.poll(() => rowsTogether(card)).toBe(4);

    await holdChecks(app);
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    await expect.poll(() => heldSteps(app)).toBeGreaterThan(0);
    const foot = card.getByTestId("card-progress");
    await expect(card.getByTestId("health-checking")).toContainText(words.checking);
    await expect(card.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(foot).toHaveText(words.foot(0));
    await expect(card.getByTestId("card-foot-stop")).toBeVisible();

    // One step at a time, until a sentence's check ends: it leaves "being checked" for its row.
    while ((await countOf(card, "checking")) === 4) {
      const held = await heldSteps(app);
      await releaseOneStep(app);
      await expect
        .poll(async () => (await heldSteps(app)) === held || (await countOf(card, "checking")) < 4)
        .toBe(true);
    }
    const left = await countOf(card, "checking");
    expect(left).toBeGreaterThan(0);
    await expect(foot).toHaveText(words.foot(4 - left));
    await expect.poll(() => rowsTogether(card)).toBe(4);
    expect((await countOf(card, "supported")) + (await countOf(card, "look"))).toBe(4 - left);

    await releaseChecks(app);
    await expect(card.getByTestId("health-checking")).toHaveCount(0);
    await expect(foot).toHaveCount(0);
    await expect(card.getByTestId("health-supported")).toContainText(words.supported);
    await expect(card.getByTestId("health-look")).toContainText(words.look);
    await expect.poll(() => rowsTogether(card)).toBe(4);
    await app.close();
  });
}
