import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * What the assistant writes into a Note is checked right after it lands, never in front of the
 * reply (#2830). The reply comes and the composer is free while the check runs; the line under
 * the Answer's card and the Note's badge count it live; a message sent meanwhile is answered, and
 * the check still finishes. The write here cites in the step after it (#1635), so its check starts
 * as the Answer ends. The scripted model holds each sentence's check until the test releases it.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

const REVENUE = [
  "# Annual report",
  "",
  "Revenue in Q1 was €4 million.",
  "",
  "Revenue in Q2 was €5 million.",
].join("\n");

const NOTES = [
  "Tides rise twice a day along this coast.",
  "The harbour office posts the times each week.",
];

const WORDS = {
  en: {
    ask: "Add a revenue table for checking, citing after",
    next: "What was revenue in Q1?",
    checking: /^Checking: 0 of 2 sentences done$/,
    badge: /^Checking 0 of 2/,
    checked: /^Checked 2 sentences/,
  },
  "zh-CN": {
    ask: "添加核对用的收入表格，写完再引用",
    next: "第一季度的收入是多少？",
    checking: /^正在核对：已完成 0\/2 句$/,
    badge: /^正在核对 0\/2/,
    checked: /^已核对 2 句/,
  },
} as const;

type SlowCheck = {
  incarnamindSlowCheck: { hold: boolean; waiting: (() => void)[]; release(): void };
};

const holdChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as unknown as SlowCheck).incarnamindSlowCheck.hold = true;
  });

const releaseChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    const { incarnamindSlowCheck } = globalThis as unknown as SlowCheck;
    incarnamindSlowCheck.hold = false;
    incarnamindSlowCheck.release();
  });

/** Lets one held step of a sentence's check go on: its search, or its verdict. */
const releaseOneStep = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as unknown as SlowCheck).incarnamindSlowCheck.waiting.shift()?.();
  });

/** How many steps of the checks are held now. */
const heldSteps = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as SlowCheck).incarnamindSlowCheck.waiting.length);

/** The numbers a count shows, done then total: "Checking: 1 of 2 sentences done", "正在核对 1/2". */
const countIn = async (shown: Locator) =>
  ((await shown.count()) === 0 ? "" : ((await shown.textContent()) ?? ""))
    .match(/\d+/g)
    ?.join(" of ") ?? null;

/** Asks as a person does, and gives back the Answer at once. */
async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  return answers.nth(before);
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`the reply comes while what it wrote is checked, a message sent meanwhile is answered, and the check finishes, in ${language}`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Annual report.md"), REVENUE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await enterContent(window);
    await window.keyboard.type(NOTES[0] ?? "");
    await window.keyboard.press("Enter");
    await window.keyboard.type(NOTES[1] ?? "");

    await holdChecks(app);
    const answer = await ask(window, words.ask);
    // The reply is in and the composer is free while every sentence it wrote is still checked.
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    const line = answer.getByTestId("self-check-checking");
    await expect(line).toHaveText(words.checking);
    await expect(window.getByTestId("badge-progress")).toHaveText(words.badge);
    await expect(window.getByTestId("composer-stop")).toHaveCount(0);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `check-after-reply-${language}.png`) });
    }

    // A message sent while the check runs is answered, and doesn't stop the check.
    const next = await ask(window, words.next);
    await expect(next).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(line).toHaveText(words.checking);

    // One step at a time to the end: the line under the card and the badge count the same
    // finished sentences at every step, several being checked at once (#2830).
    const badge = window.getByTestId("badge-progress");
    const seen = new Set<string>();
    const agree = async () =>
      (await line.count()) === 0 || (await countIn(line)) === (await countIn(badge));
    for (let step = 0; step < 12 && (await line.count()) > 0; step++) {
      await expect.poll(agree).toBe(true);
      const before = await countIn(line);
      if (before) seen.add(before);
      const held = await heldSteps(app);
      if (held === 0) break;
      await releaseOneStep(app);
      // The step goes on to its next one, held again, or its sentence's check ends and the count
      // moves; a step of the follow-up's own checks does neither, so its wait ends without either.
      await expect
        .poll(
          async () =>
            (await line.count()) === 0 ||
            (await countIn(line)) !== before ||
            (await heldSteps(app)) >= held,
          { timeout: 2_000 },
        )
        .toBe(true)
        .catch(() => undefined);
    }
    expect([...seen]).toEqual(expect.arrayContaining(["0 of 2", "1 of 2"]));
    await releaseChecks(app);
    await expect(answer.getByTestId("self-check-checked")).toHaveText(words.checked, {
      timeout: 30_000,
    });
    await expect(line).toHaveCount(0);
    await expect(window.getByTestId("badge-progress")).toHaveCount(0);
    await app.close();
  });
}
