import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  assistantAnswers,
  checkAssistantWrites,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  openSettings,
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
 *
 * That is with "Check what the assistant writes" on. On a fresh profile it is off (#3154): no
 * check follows the write, the line under the card says how many sentences wait, and its Check
 * is Check this Note.
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
    checking: /^Checking: 0 of 2 sentences done · Stop$/,
    badge: /^Checking 0 of 2/,
    checked: /^Checked 2 sentences/,
    waiting: /^2 sentences not checked yet/,
    stop: "Stop",
    stopped: /^Stopped, 2 not checked yet · Check$/,
    userLeft: "1 sentence not checked yet",
    check: "Check",
    setting: "Check what the assistant writes",
  },
  "zh-CN": {
    ask: "添加核对用的收入表格，写完再引用",
    next: "第一季度的收入是多少？",
    checking: /^正在核对：已完成 0\/2 句 · 停止$/,
    badge: /^正在核对 0\/2/,
    checked: /^已核对 2 句/,
    waiting: /^2 句待核对/,
    stop: "停止",
    stopped: /^已停止，2 句待核对 · 核对$/,
    userLeft: "1 句待核对",
    check: "核对",
    setting: "自动核对助手写入的内容",
  },
} as const;

type SlowCheck = {
  incarnamindSlowCheck: {
    hold: boolean;
    waiting: (() => void)[];
    kinds: ("check-run" | "other")[];
    release(): void;
  };
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

/**
 * Lets the first held step of a sentence's check go on, its search or its verdict, with every
 * other held step: the Answers' own judgements, which move no count.
 */
const releaseOneStep = (app: ElectronApplication) =>
  app.evaluate(() => {
    const { waiting, kinds } = (globalThis as unknown as SlowCheck).incarnamindSlowCheck;
    const first = kinds.indexOf("check-run");
    for (let at = kinds.length - 1; at >= 0; at--) {
      if (at !== first && kinds[at] === "check-run") continue;
      kinds.splice(at, 1);
      waiting.splice(at, 1)[0]?.();
    }
  });

/** How many steps of the sentences' checks are held now. */
const heldSteps = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as SlowCheck).incarnamindSlowCheck.kinds.filter(
        (kind) => kind === "check-run",
      ).length,
  );

/**
 * The numbers the line under the Answer and the Note's badge show, done then total, read from
 * the window at the same moment: "Checking: 1 of 2 sentences done", "正在核对 1/2". Null where
 * one shows none.
 */
const counts = (window: Page) =>
  window.evaluate(() => {
    const numbers = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent?.match(/\d+/g)?.join(" of ") ??
      null;
    return { line: numbers("self-check-checking"), badge: numbers("badge-progress") };
  });

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
    await checkAssistantWrites(window);
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
    const seen = new Set<string>();
    for (let step = 0; step < 12; step++) {
      // A step of a check is held, or the check is over.
      await expect
        .poll(async () => (await line.count()) === 0 || (await heldSteps(app)) > 0)
        .toBe(true);
      const now = await counts(window);
      if (now.line === null) break;
      expect(now.badge).toBe(now.line);
      seen.add(now.line);
      const held = await heldSteps(app);
      await releaseOneStep(app);
      // The step goes on to its next one, held again, or its sentence's check ends and the count moves.
      await expect
        .poll(async () => {
          const after = await counts(window);
          return after.line === null || after.line !== now.line || (await heldSteps(app)) >= held;
        })
        .toBe(true);
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

  test(`Stop under the reply stops the check of what it wrote, and the line says how many sentences are not checked yet, in ${language}`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Annual report.md"), REVENUE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await checkAssistantWrites(window);
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await enterContent(window);
    await window.keyboard.type(NOTES[0] ?? "");

    await holdChecks(app);
    const answer = await ask(window, words.ask);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);
    const stop = answer.getByTestId("self-check-checking-action");
    await expect(stop).toHaveText(words.stop);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `stop-under-reply-${language}.png`) });
    }
    await stop.click();
    await releaseChecks(app);
    // Not "couldn't be checked": the sentences wait for the User's Check, as unread ones do.
    const stopped = answer.getByTestId("self-check-stopped");
    await expect(stopped).toHaveText(words.stopped, { timeout: 30_000 });
    await expect(answer.getByTestId("self-check-stopped-action")).toHaveText(words.check);
    await expect(answer.getByTestId("self-check-failed")).toHaveCount(0);
    await expect(answer.getByTestId("self-check-checking")).toHaveCount(0);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `stopped-under-reply-${language}.png`) });
    }
    await app.close();
  });

  test(`on a fresh profile no check follows the write: the line says how many sentences wait, and Check checks that write alone, in ${language}`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Annual report.md"), REVENUE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    const settings = await openSettings(window, "ai");
    await setLanguage(window, language);
    const row = settings.getByTestId("check-writes-settings");
    await expect(row.locator("label")).toHaveText(words.setting);
    await expect(row.getByTestId("check-writes-switch")).not.toBeChecked();
    if (SCREENSHOTS) {
      await row.scrollIntoViewIfNeeded();
      await window.screenshot({ path: join(SCREENSHOTS, `check-writes-setting-${language}.png`) });
    }
    await window.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await enterContent(window);
    await window.keyboard.type(NOTES[0] ?? "");

    await holdChecks(app);
    const answer = await ask(window, words.ask);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    const waiting = answer.getByTestId("self-check-left");
    await expect(waiting).toHaveText(words.waiting);
    await expect(answer.getByTestId("self-check-left-action")).toHaveText(words.check);
    await expect(answer.getByTestId("self-check-checking")).toHaveCount(0);
    await expect(window.getByTestId("badge-progress")).toHaveCount(0);
    // Nothing was sent for the sentences it wrote: no step of a check is held.
    expect(await heldSteps(app)).toBe(0);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `write-not-checked-${language}.png`) });
    }

    await releaseChecks(app);
    await answer.getByTestId("self-check-left-action").click();
    // The write's own sentences are checked and the line goes once none is left; the sentence the
    // User typed in the Note is the Note's Check, on the badge, so it is still not checked yet.
    await expect(waiting).toHaveCount(0, { timeout: 60_000 });
    const badge = window.getByTestId("check-badge");
    await expect(badge.locator(".check-badge-words")).toHaveText(words.userLeft);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `write-checked-${language}.png`) });
    }
    await app.close();
  });
}
